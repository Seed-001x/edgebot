// TP1 OVERRIDE (user 2026-10-16 19:12 EDT, "arm tp1 to hit at 50% / not
// 20%-60% / just for this coin"): the per-position dial pos.tp1AtPct, set via
// POST /tp1at and cleared via POST /tp1clear (or /tp1at with pct 0). While
// set on a pre-TP1 position, exits.js section 3 bypasses the adaptive TP1
// machinery for that coin entirely — no arm, no ceiling / rollover /
// strength-fade fire before the line — and banks cfg.tp1Frac flat at the
// line, advancing stages exactly as a normal TP1. protect.test.mjs is the
// template for the admin lifecycle half; slladder.test.mjs for the engine
// half. tp1Frac is pinned to the live 0.40 so the bank asserts read in live
// terms (the code default is 0.65).
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
    const p = { id: 'pos1', mint: 'MINTX', symbol: 'XXX', setup: 'pop', entrySol: 0.05, remainingFrac: 1, peakRatio: 1, peakMove: 1, entryTs: clock.t, entryRoundTrip: 0.97, exitPending: {}, ...o };
    bot.positions.push(p);
    return p;
  };
  return { cfg, clock, deps, bot, openPos };
}

test('tp1at: sets the override on the open position, exposes it on /state, persists it; a new value overwrites', () => {
  const { cfg, bot, openPos } = rig();
  const p = openPos();
  const r = bot.tp1AtPosition('MINTX', 0.5);
  assert.equal(r, p);
  assert.equal(p.tp1AtPct, 0.5);
  assert.equal(bot.stats.tp1At.set, 1);
  assert.equal(bot.state().positions[0].tp1AtPct, 0.5);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'positions.json'), 'utf8'));
  assert.equal(saved.find(x => x.mint === 'MINTX').tp1AtPct, 0.5); // on the position record — survives restarts
  // it is a dial, not a latch: re-setting by symbol overwrites
  assert.equal(bot.tp1AtPosition('XXX', 0.35), p);
  assert.equal(p.tp1AtPct, 0.35);
  assert.equal(bot.state().positions[0].tp1AtPct, 0.35);
});

test('tp1at: unknown mint returns null and changes nothing', () => {
  const { bot, openPos } = rig();
  openPos();
  assert.equal(bot.tp1AtPosition('NOSUCHMINT', 0.5), null);
  assert.equal(bot.positions[0].tp1AtPct, undefined);
  assert.equal(bot.stats.tp1At, undefined);
});

test('tp1at: the override survives a reload — a fresh Bot on the same data dir restores it', () => {
  const { cfg, deps, bot, openPos } = rig();
  openPos();
  bot.tp1AtPosition('MINTX', 0.5);
  const bot2 = new Bot(cfg, deps);
  assert.equal(bot2.positions.length, 1);
  assert.equal(bot2.positions[0].tp1AtPct, 0.5);
});

test('tp1clear: clears the override and persists the clearing; repeat and unknown calls are clean misses', () => {
  const { cfg, bot, openPos } = rig();
  const p = openPos();
  assert.equal(bot.tp1ClearPosition('MINTX'), false);       // exists but no override set
  bot.tp1AtPosition('MINTX', 0.5);
  const r = bot.tp1ClearPosition('MINTX');
  assert.equal(r, p);
  assert.equal(p.tp1AtPct, undefined);
  assert.equal(bot.stats.tp1At.cleared, 1);
  assert.equal(bot.state().positions[0].tp1AtPct, null);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'positions.json'), 'utf8'));
  assert.equal(saved.find(x => x.mint === 'MINTX').tp1AtPct, undefined);
  assert.equal(bot.tp1ClearPosition('MINTX'), false);       // already cleared
  assert.equal(bot.tp1ClearPosition('NOSUCHMINT'), null);   // no such position
});

test('tp1at: other positions are unaffected — the dial lands on the one coin only', () => {
  const { bot, openPos } = rig();
  openPos();
  const other = openPos({ id: 'pos2', mint: 'MINTY', symbol: 'YYY' });
  bot.tp1AtPosition('MINTX', 0.5);
  assert.equal(other.tp1AtPct, undefined);
  assert.equal(bot.state().positions.find(x => x.mint === 'MINTY').tp1AtPct, null);
});

test('tp1at: the override dies with the position — a rebuy of the same mint starts unset', () => {
  const { bot, openPos } = rig();
  openPos();
  bot.tp1AtPosition('MINTX', 0.5);
  bot.positions = [];                                        // the position closed (any path removes the record)
  const fresh = openPos({ id: 'pos2' });
  assert.equal(fresh.tp1AtPct, undefined);
  assert.equal(bot.state().positions[0].tp1AtPct, null);
});

// ---------- engine behavior (mirrors slladder.test.mjs) ----------
const cfg = testCfg({ txFeeSol: 0, slMinAgeSec: 0, tp1Frac: 0.40 }); // gain = ratio − 1 exactly; bank pinned at the live 40%
const NOW = 1_000_000_000_000;
const S = 1000;
const epos = (o = {}) => ({ entrySol: 0.05, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 60 * S, slLadder: null, ...o });
const mk = (p, gainPct, o = {}) => ({ valueSol: p.entrySol * p.remainingFrac * (1 + gainPct / 100), liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });
const step = (p, gainPct, c, now, markOver = {}) => { const d = evaluateExit(p, mk(p, gainPct, markOver), c, now); if ('slLadder' in d) p.slLadder = d.slLadder; return d; };
const WEAK = { buysM5: 5, sellsM5: 30 }; // share 0.14 — the adaptive strength-fade trigger print

test('engine: the override blocks an adaptive strength-fade fire below the line', () => {
  const control = step(epos(), 30, cfg, NOW, WEAK);          // no override: +30% on dead flow banks at once
  assert.equal(control.fraction, 0.40); assert.equal(control.tp1, true);
  assert.match(control.reason, /adaptive: strength faded/);
  const p = epos({ tp1AtPct: 0.5 });
  const d = step(p, 30, cfg, NOW, WEAK);                      // same print, override at +50%: nothing sells
  assert.equal(d.fraction, 0); assert.equal(d.tp1, undefined);
  assert.equal(d.tp1Arm, null);                               // and nothing arms either
});

test('engine: the override blocks even a ceiling fire below a higher line', () => {
  const control = step(epos(), 63, cfg, NOW);                 // no override: +63% ≥ +60% ceiling banks
  assert.equal(control.fraction, 0.40); assert.match(control.reason, /ceiling/);
  const d = step(epos({ tp1AtPct: 0.8 }), 63, cfg, NOW);      // override at +80%: the ceiling is not TP1's judge anymore
  assert.equal(d.fraction, 0); assert.equal(d.tp1, undefined);
});

test('engine: a pre-existing adaptive arm does not survive into the override window', () => {
  const p = epos({ tp1Arm: { ts: NOW - 8000, share: 0.6 }, tp1AtPct: 0.5 });
  const d = step(p, 30, cfg, NOW, WEAK);
  assert.equal(d.fraction, 0);
  assert.equal(d.tp1Arm, null);
});

test('engine: at the line TP1 fires flat — banks tp1Frac with the override reason; one point below holds', () => {
  const p = epos({ tp1AtPct: 0.5 });
  assert.equal(step(p, 49, cfg, NOW).fraction, 0);
  const d = step(p, 50, cfg, NOW + 4 * S);
  assert.equal(d.fraction, 0.40);
  assert.equal(d.tp1, true);
  assert.equal(d.reason, 'TP1 +50% (override)');
  assert.equal(d.tp1Arm, null);
});

test('engine: post-TP1 stages are unchanged — TP2 fires on the remainder, and a stale override can never re-fire TP1', () => {
  const mid = epos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.5 }); // the override was spent by its fire (bot.js deletes it)
  const d = step(mid, 100, cfg, NOW);
  assert.equal(d.tp2, true);
  assert.ok(Math.abs(d.fraction - 0.35 / 0.6) < 1e-9);
  assert.match(d.reason, /TP2/);
  const stale = epos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.5, tp1AtPct: 0.5 }); // a value that somehow survived
  const d2 = step(stale, 50, cfg, NOW);
  assert.equal(d2.fraction, 0); assert.equal(d2.tp1, undefined); // TP1's section is gated on !tp1Done — the stale dial is inert
});

test('engine: clearing the override restores the adaptive machinery exactly', () => {
  const p = epos({ tp1AtPct: 0.5 });
  assert.equal(step(p, 30, cfg, NOW, WEAK).fraction, 0);      // blocked while set
  delete p.tp1AtPct;                                         // POST /tp1clear
  const d = step(p, 30, cfg, NOW + 4 * S, WEAK);              // the same print now banks adaptively
  assert.equal(d.fraction, 0.40); assert.equal(d.tp1, true);
  assert.match(d.reason, /adaptive: strength faded/);
});
