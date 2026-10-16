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

// ---- Orphan adoption (user order 2026-10-16): reconcile also picks bags
// back up. WORLD's bag sat in the wallet for 4+ hours because nothing ever
// looked; these tests pin the adoption side against the same journal shape.
function adoptRig(cfgOver = {}) {
  const cfg = testCfg({ realMode: true, maxPositions: 2, ...cfgOver });
  const clock = { t: T0 + 4 * 3600e3 };
  const state = { bal: 0n, value: 0.0252, balReads: 0 };
  const exec = {
    tokenBalance: async () => { state.balReads++; return state.bal; },
    markValue: async () => state.value,
    roundTrip: async () => ({ ratio: 0.97 }),
    solBalance: async () => 1,
  };
  const bot = new Bot(cfg, { now: () => clock.t, exec });
  const open = { type: 'open', id: 'MINT1-1', mint: 'MINT1', symbol: 'WORLD', setup: 'pop', entrySol: 0.025, tokensRaw: '1000000', entryFillSol: 2.5e-8, sig: 'SIGBUY', ts: T0 };
  const close = { type: 'close', id: 'MINT1-1', mint: 'MINT1', symbol: 'WORLD', setup: 'pop', entrySol: 0.025, tokensRaw: '1000000', decimals: 6, reason: 'reconcile: sold outside bot (manual sell) — P&L est. from last quote', entry: { price: 0.0003, mc: 286632, volH1: 1000 }, ts: T0 + 5000 };
  bot.journal.trades.push(open, close);
  return { cfg, clock, state, bot, open, close };
}

test('adopt: the WORLD shape — flat books, bag still in the wallet — is picked back up', async () => {
  const { clock, state, bot } = adoptRig();
  state.bal = 1000000n; // the whole bag never left
  await bot.reconcilePositions();
  assert.equal(bot.positions.length, 1);
  const p = bot.positions[0];
  assert.equal(p.adopted, true);
  assert.equal(p.adoptOf, 'MINT1-1');
  assert.equal(p.entrySol, 0.025);
  assert.equal(p.remainingFrac, 1);
  assert.equal(p.entryTs, T0, 'age judges from the original entry');
  assert.ok(p.peakRatio > 1.03 && p.peakRatio < 1.05, `peak starts at the adoption mark (got ${p.peakRatio})`);
  assert.equal(p.entryMc, 286632, 'entry snapshot restored from the close record');
  const rec = bot.journal.trades[bot.journal.trades.length - 1];
  assert.equal(rec.type, 'open');
  assert.equal(rec.adopted, true);
  assert.equal(clock.t - (p.adoptedTs || 0), 0);
});

test('adopt: dust stays dust — a bag under the value floor is not adopted', async () => {
  const { state, bot } = adoptRig();
  state.bal = 1000000n;
  state.value = 0.001; // < ADOPT_MIN_SOL 0.005
  await bot.reconcilePositions();
  assert.equal(bot.positions.length, 0);
});

test('adopt: a truly empty wallet adopts nothing', async () => {
  const { state, bot } = adoptRig();
  state.bal = 0n;
  await bot.reconcilePositions();
  assert.equal(bot.positions.length, 0);
});

test('adopt: the position cap defers adoption until a slot frees', async () => {
  const { state, bot } = adoptRig({ maxPositions: 1 });
  bot.positions = [{ id: 'other', mint: 'OTHER', symbol: 'OTHER', entryTs: T0, entrySol: 0.025 }];
  state.bal = 1000000n;
  await bot.reconcilePositions();
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].mint, 'OTHER');
  bot.positions = [];
  bot.adoptScan.clear();
  await bot.reconcilePositions();
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].mint, 'MINT1');
});

test('adopt: balance re-reads are throttled to one per mint per 5 minutes', async () => {
  const { clock, state, bot } = adoptRig();
  state.bal = 0n;
  await bot.reconcilePositions();
  await bot.reconcilePositions();
  assert.equal(state.balReads, 1);
  clock.t += 300_001;
  await bot.reconcilePositions();
  assert.equal(state.balReads, 2);
});

test('adopt: a TP1 the original position banked stays banked, and the remainder fraction is the balance share', async () => {
  const { state, bot, open } = adoptRig();
  bot.journal.trades.push({ type: 'sell', id: open.id, mint: 'MINT1', symbol: 'WORLD', reason: 'TP1 (adaptive) — banked 40%', ts: T0 + 60_000 });
  state.bal = 600000n; // 60% of the original buy remains
  state.value = 0.015;
  await bot.reconcilePositions();
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].tp1Done, true);
  assert.equal(bot.positions[0].tp2Done, false);
  assert.equal(bot.positions[0].remainingFrac, 0.6);
});

test('adopt: ADOPT_ORPHANS=0 disables adoption entirely', async () => {
  const { state, bot } = adoptRig({ adoptOrphans: 0 });
  state.bal = 1000000n;
  await bot.reconcilePositions();
  assert.equal(bot.positions.length, 0);
});

test('adopt: the boot path adopts too (deploy-restart orphan)', async () => {
  const { state, bot } = adoptRig();
  state.bal = 1000000n;
  await bot.start();
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].adopted, true);
});

test('adopt: shipped defaults are on / 0.005 SOL floor / 168h lookback', () => {
  const cfg = testCfg({});
  assert.equal(cfg.adoptOrphans, 1);
  assert.equal(cfg.adoptMinSol, 0.005);
  assert.equal(cfg.adoptLookbackH, 168);
});
