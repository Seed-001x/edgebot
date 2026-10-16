// LADDER-OFF switch (user 2026-10-16 19:09 EDT, "create a switch to switch
// off this SL system for this coin or any coin I choose to do it on so it
// could be done quick"): the per-position flag that silences ONLY the SL
// ladder (exits.js 3b2) for one coin. protect.test.mjs is the template for
// the admin lifecycle half (POST /ladderoff and /ladderon call
// bot.ladderOffPosition / bot.ladderOnPosition; the flag lives on the
// persisted position record, survives restarts, dies with the position);
// slladder.test.mjs is the template for the engine half (the flag blocks
// arming/firing, drops armed state, leaves every other exit judging, and
// resuming re-derives from the position's real age — no second gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { evaluateExit } from '../src/exits.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg } from './helpers.mjs';

// ---------- bot-side lifecycle (mirrors protect.test.mjs) ----------
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
    const p = { id: 'pos1', mint: 'MINTX', symbol: 'XXX', setup: 'pop', entrySol: 0.05, remainingFrac: 1, peakRatio: 1, peakMove: 1, entryTs: clock.t, entryRoundTrip: 0.97, exitPending: {}, slLadder: null, ...o };
    bot.positions.push(p);
    return p;
  };
  return { cfg, clock, deps, bot, openPos };
}

test('ladderoff: sets the flag, drops armed ladder state, counts the set, exposes it on /state, persists it', () => {
  const { cfg, bot, openPos } = rig();
  const armed = { armTs: T0, softDeadline: T0 + 120000, hardDeadline: T0 + 180000, deepest: 0.12, deepSeen: false, deepClamped: false, penalized: false, snapDeadline: null, finalDeadline: null, inHandoff: false };
  const p = openPos({ slLadder: armed });
  const r = bot.ladderOffPosition('MINTX');
  assert.equal(r, p);
  assert.equal(p.ladderOff, T0);
  assert.equal(p.slLadder, null); // the armed probation record dies with the flip
  assert.equal(bot.stats.ladderOff.set, 1);
  assert.equal(bot.state().positions[0].ladderOff, T0);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'positions.json'), 'utf8'));
  assert.equal(saved.find(x => x.mint === 'MINTX').ladderOff, T0); // on the position record — survives restarts
  assert.equal(saved.find(x => x.mint === 'MINTX').slLadder, null);
  // re-set (by symbol this time) is a no-op: same flag, no double count
  assert.equal(bot.ladderOffPosition('XXX'), p);
  assert.equal(bot.stats.ladderOff.set, 1);
});

test('ladderoff: unknown mint returns null and changes nothing', () => {
  const { bot, openPos } = rig();
  openPos();
  assert.equal(bot.ladderOffPosition('NOSUCHMINT'), null);
  assert.equal(bot.positions[0].ladderOff, undefined);
  assert.equal(bot.stats.ladderOff, undefined);
});

test('ladderoff: the flag survives a reload — a fresh Bot on the same data dir restores it', () => {
  const { cfg, deps, bot, openPos } = rig();
  openPos();
  bot.ladderOffPosition('MINTX');
  const bot2 = new Bot(cfg, deps); // loadPositions() reads positions.json, as a restart does
  assert.equal(bot2.positions.length, 1);
  assert.equal(bot2.positions[0].ladderOff, T0);
});

test('ladderon: clears the flag and persists the clearing; repeat and unknown calls are clean misses', () => {
  const { cfg, bot, openPos } = rig();
  const p = openPos();
  assert.equal(bot.ladderOnPosition('MINTX'), false);       // exists but ladder already on
  bot.ladderOffPosition('MINTX');
  const r = bot.ladderOnPosition('MINTX');
  assert.equal(r, p);
  assert.equal(p.ladderOff, undefined);
  assert.equal(bot.stats.ladderOff.cleared, 1);
  assert.equal(bot.state().positions[0].ladderOff, null);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'positions.json'), 'utf8'));
  assert.equal(saved.find(x => x.mint === 'MINTX').ladderOff, undefined);
  assert.equal(bot.ladderOnPosition('MINTX'), false);       // already cleared
  assert.equal(bot.ladderOnPosition('NOSUCHMINT'), null);   // no such position
});

test('ladderoff: the flag dies with the position — a rebuy of the same mint starts with the ladder on', () => {
  const { bot, openPos } = rig();
  openPos();
  bot.ladderOffPosition('MINTX');
  bot.positions = [];                                        // the position closed (any path removes the record)
  const fresh = openPos({ id: 'pos2' });
  assert.equal(fresh.ladderOff, undefined);
  assert.equal(bot.state().positions[0].ladderOff, null);
});

// ---------- engine behavior (mirrors slladder.test.mjs) ----------
const cfg = testCfg({ txFeeSol: 0, slMinAgeSec: 0 });       // gate off — the as-built machine
const cfgGate = testCfg({ txFeeSol: 0, slMinAgeSec: 180 }); // the live 3-minute engagement gate
const NOW = 1_000_000_000_000;
const S = 1000;
const epos = (o = {}) => ({ entrySol: 0.05, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 60 * S, slLadder: null, ...o });
const mk = (p, gainPct, o = {}) => ({ valueSol: p.entrySol * p.remainingFrac * (1 + gainPct / 100), liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });
const step = (p, gainPct, c, now, markOver = {}) => { const d = evaluateExit(p, mk(p, gainPct, markOver), c, now); if ('slLadder' in d) p.slLadder = d.slLadder; return d; };

test('engine: ladderOff blocks arming and firing outright — a -35% print past every rung just holds', () => {
  const p = epos({ entryTs: NOW - 300 * S, ladderOff: NOW - 60 * S }); // past the age gate, flag on
  const d1 = step(p, -35, cfgGate, NOW);
  assert.equal(d1.fraction, 0); assert.equal(d1.reason, null);
  assert.equal(p.slLadder, null);
  assert.equal(d1.slLadderEvents.length, 0);
  // 30s later the final countdown (had it armed) would long have expired — still nothing
  const d2 = step(p, -35, cfgGate, NOW + 30 * S);
  assert.equal(d2.fraction, 0); assert.equal(p.slLadder, null);
  // and the suppression is NOT reported as a protect block — the flags are distinct
  assert.equal(d2.protectedBlock, null);
});

test('engine: armed state drops when the flag flips on mid-arm — no deadline executes under it', () => {
  const p = epos();
  step(p, -12, cfg, NOW);                                    // arms normally, flag off
  assert.ok(p.slLadder);
  p.ladderOff = NOW + 10 * S;                                // the user flips it off mid-probation
  const d = step(p, -12, cfg, NOW + 200 * S);                // past the hard cap: would have fired
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
  assert.equal(p.slLadder, null);
});

test('engine: other exits judge normally while ladderOff — a TP1 bank still banks', () => {
  const fixed = { ...cfg, tp1AdaptMax: cfg.tp1Pct };        // ceiling pinned at the arm = instant bank (exits.test.mjs shape)
  const p = epos({ ladderOff: NOW - 60 * S, stallSince: NOW });
  const d = step(p, 32, fixed, NOW);
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true);
});

test('engine: other exits judge normally while ladderOff — the undertaker and liquidity death still fire', () => {
  const dead = epos({ entryTs: NOW - 11 * 60 * S, ladderOff: NOW - 60 * S });
  const d1 = step(dead, -20, cfg, NOW, { buysM5: 0, sellsM5: 5 }); // 11 min in, no buyers: momentum failure
  assert.equal(d1.fraction, 1); assert.match(d1.reason, /momentum failure/);
  const dry = epos({ ladderOff: NOW - 60 * S });
  const d2 = step(dry, -20, cfg, NOW, { liqUsd: 100 });
  assert.equal(d2.fraction, 1); assert.match(d2.reason, /liquidity death/);
});

test('engine: flipping back on resumes fresh arming from the next check — no second gate from the toggle', () => {
  const p = epos({ entryTs: NOW - 300 * S, ladderOff: NOW - 100 * S }); // 5 min old, flag on
  assert.equal(step(p, -12, cfgGate, NOW).fraction, 0);
  assert.equal(p.slLadder, null);
  delete p.ladderOff;                                        // POST /ladderon
  const d = step(p, -12, cfgGate, NOW + 5 * S);
  assert.ok(p.slLadder);                                     // armed fresh on the first judged check
  assert.equal(p.slLadder.armTs, NOW + 5 * S);
  assert.equal(p.slLadder.softDeadline, NOW + 5 * S + 120 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 5 * S + 180 * S);
  assert.ok(d.slLadderEvents.some(e => e.type === 'armed'));
});

test('engine: the age gate still runs from ENTRY after a toggle — a young coin stays gated, then engages on age', () => {
  const p = epos({ entryTs: NOW - 60 * S, ladderOff: NOW - 30 * S }); // 60s old at NOW, flag flipped on then off
  delete p.ladderOff;
  const d1 = step(p, -12, cfgGate, NOW);                      // age 60s: the gate still owns it
  assert.equal(d1.fraction, 0); assert.equal(p.slLadder, null);
  const d2 = step(p, -12, cfgGate, NOW + 130 * S);            // age 190s: engages fresh at this check
  assert.ok(p.slLadder);
  assert.equal(p.slLadder.armTs, NOW + 130 * S);
});
