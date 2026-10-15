// PROTECT switch (user 2026-10-15, "just the stop loss… no ratchet", "no SL until I
// say"): the bot-side lifecycle of the flag. exits.test.mjs covers what the flag does
// inside the exit judge; this file covers the admin seam — POST /protect and
// POST /unprotect call bot.protectPosition / bot.unprotectPosition, the flag lives
// on the persisted position record (survives restarts), holds for the life of the
// position with no expiry, and dies with the position (a rebuy starts unprotected).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_000_000_000_000;
function rig() {
  const cfg = testCfg();
  const clock = { t: T0 };
  const exec = new Executor(cfg, { quote: async (input) => (input === SOL_MINT ? { outAmount: '1000000000', priceImpactPct: '0.01' } : { outAmount: '0' }) });
  const deps = {
    now: () => clock.t, exec,
    discover: async () => new Map(),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  };
  const bot = new Bot(cfg, deps);
  const openPos = (o = {}) => {
    const p = { id: 'pos1', mint: 'MINTX', symbol: 'XXX', setup: 'pop', entrySol: 0.05, remainingFrac: 1, peakRatio: 1, peakMove: 1, entryTs: clock.t, entryRoundTrip: 0.97, exitPending: {}, ...o };
    bot.positions.push(p);
    return p;
  };
  return { cfg, clock, deps, bot, openPos };
}

test('protect: sets the flag on the open position, counts the set, exposes it on /state, persists it', () => {
  const { cfg, bot, openPos } = rig();
  const p = openPos();
  const r = bot.protectPosition('MINTX');
  assert.equal(r, p);
  assert.equal(p.protected, T0);
  assert.equal(bot.stats.protect.set, 1);
  assert.equal(bot.state().positions[0].protected, T0);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'positions.json'), 'utf8'));
  assert.equal(saved.find(x => x.mint === 'MINTX').protected, T0); // on the position record — survives restarts
  // re-protect (by symbol this time) is a no-op: same flag, no double count
  assert.equal(bot.protectPosition('XXX'), p);
  assert.equal(bot.stats.protect.set, 1);
});

test('protect: unknown mint returns null and changes nothing', () => {
  const { bot, openPos } = rig();
  openPos();
  assert.equal(bot.protectPosition('NOSUCHMINT'), null);
  assert.equal(bot.positions[0].protected, undefined);
  assert.equal(bot.stats.protect, undefined);
});

test('protect: the flag survives a reload — a fresh Bot on the same data dir restores it', () => {
  const { cfg, deps, bot, openPos } = rig();
  openPos();
  bot.protectPosition('MINTX');
  const bot2 = new Bot(cfg, deps); // loadPositions() reads positions.json, as a restart does
  assert.equal(bot2.positions.length, 1);
  assert.equal(bot2.positions[0].protected, T0);
});

test('unprotect: clears the flag and persists the clearing; repeat and unknown calls are clean misses', () => {
  const { cfg, bot, openPos } = rig();
  const p = openPos();
  assert.equal(bot.unprotectPosition('MINTX'), false);      // exists but not protected
  bot.protectPosition('MINTX');
  const r = bot.unprotectPosition('MINTX');
  assert.equal(r, p);
  assert.equal(p.protected, undefined);
  assert.equal(bot.state().positions[0].protected, null);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'positions.json'), 'utf8'));
  assert.equal(saved.find(x => x.mint === 'MINTX').protected, undefined);
  assert.equal(bot.unprotectPosition('MINTX'), false);      // already cleared
  assert.equal(bot.unprotectPosition('NOSUCHMINT'), null);  // no such position
});

test('protect: the flag dies with the position — a rebuy of the same mint starts unprotected', () => {
  const { bot, openPos } = rig();
  openPos();
  bot.protectPosition('MINTX');
  bot.positions = [];                                        // the position closed (any path removes the record)
  const fresh = openPos({ id: 'pos2' });
  assert.equal(fresh.protected, undefined);
  assert.equal(bot.state().positions[0].protected, null);
});
