// Reconcile drop guard (user order 2026-10-16, the WORLD orphan): the bot
// bought WORLD, and 5 seconds later a single token-balance read of zero —
// the fill's token account had literally just been created and the read
// raced it — dropped the position as "sold outside bot (manual sell)". The
// tokens never left the wallet; the position fell off the books and the
// exit stack never managed it through a +124% run. The guard: a reconcile
// drop now needs (a) the position older than the post-entry grace window
// AND (b) a zero balance sustained across separate checks spanning the
// confirm window, stamped on the position (persisted) and cleared by any
// non-zero read. Both drop sites (boot reconcile in start(), the 60s
// periodic reconcilePositions) go through the same guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_000_000_000_000;

// Real Executor over a scripted RPC wallet: state.raw === null means the
// wallet shows NO token account for the mint (the racing-read shape that
// parses to 0n); otherwise one account holding that raw amount.
function rig(cfgOver = {}) {
  const cfg = testCfg({ realMode: true, reconcileGraceSec: 120, reconcileConfirmSec: 60, ...cfgOver });
  const clock = { t: T0 };
  const state = { raw: null };
  const rpc = async (method) => {
    if (method === 'getBalance') return { value: 1_000_000_000 };
    if (method === 'getTokenAccountsByOwner') {
      return { value: state.raw === null ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount: state.raw, decimals: 6, uiAmount: 1 } } } } } }] };
    }
    throw new Error('unexpected rpc ' + method);
  };
  const exec = new Executor(cfg, { rpc, env: { WALLET_PRIVATE_KEY: bs58.encode(Keypair.generate().secretKey) } });
  const drops = [];
  const mkBot = () => {
    const bot = new Bot(cfg, { now: () => clock.t, exec });
    bot.closeExternal = async (p, reason) => { drops.push({ id: p.id, reason }); bot.positions = bot.positions.filter(x => x.id !== p.id); return true; };
    return bot;
  };
  const pos = (over = {}) => ({ id: 'p1', mint: 'MINT1', symbol: 'WORLD', entryTs: clock.t - 600_000, entrySol: 0.025, ...over });
  return { cfg, clock, state, drops, mkBot, pos };
}

test('reconcile: a zero read inside the post-entry grace window never drops (the WORLD race)', async () => {
  const { clock, state, drops, mkBot, pos } = rig();
  const bot = mkBot();
  const p = pos({ entryTs: clock.t - 5_000 }); // filled 5 seconds ago
  bot.positions = [p];
  state.raw = null; // balance reads zero — account not yet visible
  await bot.reconcilePositions();
  assert.equal(drops.length, 0);
  assert.equal(bot.positions.length, 1);
  assert.equal(p.zeroBalSince, undefined, 'no confirm clock may start inside grace');
});

test('reconcile: first post-grace zero stamps but does not drop; a zero 30s later still holds', async () => {
  const { clock, state, drops, mkBot, pos } = rig();
  const bot = mkBot();
  const p = pos();
  bot.positions = [p];
  state.raw = null;
  await bot.reconcilePositions();
  assert.equal(drops.length, 0);
  assert.equal(p.zeroBalSince, clock.t);
  clock.t += 30_000;
  await bot.reconcilePositions();
  assert.equal(drops.length, 0, 'zero must persist the full confirm window');
  assert.equal(bot.positions.length, 1);
});

test('reconcile: a zero sustained past the confirm window drops as an external sell', async () => {
  const { clock, state, drops, mkBot, pos } = rig();
  const bot = mkBot();
  bot.positions = [pos()];
  state.raw = null;
  await bot.reconcilePositions();
  clock.t += 61_000;
  await bot.reconcilePositions();
  assert.equal(drops.length, 1);
  assert.match(drops[0].reason, /sold outside bot/);
  assert.equal(bot.positions.length, 0);
});

test('reconcile: a non-zero read clears the stamp and refreshes tokensRaw; the next zero starts fresh', async () => {
  const { clock, state, drops, mkBot, pos } = rig();
  const bot = mkBot();
  const p = pos();
  bot.positions = [p];
  state.raw = null;
  await bot.reconcilePositions();
  assert.equal(p.zeroBalSince, clock.t);
  state.raw = '5000';
  clock.t += 10_000;
  await bot.reconcilePositions();
  assert.equal(p.zeroBalSince, undefined, 'live balance clears the stamp');
  assert.equal(p.tokensRaw, '5000');
  state.raw = null;
  clock.t += 10_000;
  await bot.reconcilePositions();
  assert.equal(drops.length, 0, 'a fresh zero is a first sighting again, not a confirmation');
  assert.equal(p.zeroBalSince, clock.t);
});

test('reconcile: boot path shares the guard — a zero at boot stamps, a later boot past the window drops', async () => {
  const { cfg, clock, state, drops, mkBot, pos } = rig();
  state.raw = null;
  const bot1 = mkBot();
  bot1.positions = [pos()];
  bot1.savePositions();
  await bot1.start(); // boot reconcile: first zero sighting
  assert.equal(drops.length, 0, 'boot alone must never drop on one read');
  clock.t += 61_000;
  const bot2 = mkBot(); // fresh process, positions reloaded from disk (stamp persisted)
  assert.equal(bot2.positions.length, 1);
  assert.equal(bot2.positions[0].zeroBalSince, T0);
  await bot2.start();
  assert.equal(drops.length, 1, 'sustained zero across the restart drops');
  assert.match(drops[0].reason, /no longer in wallet/);
  assert.equal(cfg.reconcileGraceSec, 120); // rig pin only; defaults pinned below
});

test('reconcile: shipped defaults are grace 120s / confirm 60s', () => {
  const cfg = testCfg({});
  assert.equal(cfg.reconcileGraceSec, 120);
  assert.equal(cfg.reconcileConfirmSec, 60);
});

test('reconcile: a null balance (shadow / unknown) never drops and never stamps', async () => {
  const { mkBot, pos } = rig();
  const bot = mkBot();
  const p = pos();
  assert.equal(bot._reconcileZeroConfirmed(p, null, T0), false);
  assert.equal(p.zeroBalSince, undefined);
});
