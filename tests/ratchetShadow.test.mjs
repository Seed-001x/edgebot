// ratchetShadow.test.mjs — the shadow (record-only) flow judge for the break-even
// ratchet (user 2026-10-14). Pins: window aggregation, the would-fire test's legs,
// one-record-per-position, the close completion record, and the master switch
// changing NOTHING when off. The judge must never influence an exit — the last
// test runs the MINDPAD shape through managePosition and shows the live ratchet
// selling exactly as it does today, with the shadow records written alongside.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ShadowFlow, ratchetArmed, ratchetShadowFire } from '../src/ratchetShadow.js';
import { Bot } from '../src/bot.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_800_000_000_000;
const CFG = { beArmPct: 0.05, beTriggerPct: 0.02, ratchetFlowWindowSec: 15, ratchetFlowSellShare: 0.70, ratchetFlowMinSellSol: 1.0 };

// ---- flow window aggregation ----
test('shadow flow window: sums buys/sells in SOL, sell share, trade count', () => {
  const f = new ShadowFlow();
  f.note('M', { ts: T0, side: 'buy', sol: 0.5 });
  f.note('M', { ts: T0 + 1000, side: 'sell', sol: 2.0 });
  f.note('M', { ts: T0 + 2000, side: 'sell', sol: 1.0 });
  f.note('M', { ts: T0 + 3000, side: 'buy', sol: 0.25 });
  const w = f.window('M', T0 + 3000, 15);
  assert.equal(w.trades, 4);
  assert.equal(w.buySol, 0.75);
  assert.equal(w.sellSol, 3.0);
  assert.equal(w.sellShare, 0.8);
});

test('shadow flow window: trades older than the window fall out; empty window is null', () => {
  const f = new ShadowFlow();
  f.note('M', { ts: T0, side: 'sell', sol: 5 });
  f.note('M', { ts: T0 + 20000, side: 'buy', sol: 1 });
  const w = f.window('M', T0 + 20000, 15); // the 5 SOL sell is 20s old — outside a 15s window
  assert.equal(w.trades, 1);
  assert.equal(w.sellSol, 0);
  assert.equal(f.window('M', T0 + 999999, 15), null); // everything stale
  assert.equal(f.window('UNKNOWN', T0, 15), null);     // never seen
});

test('shadow flow window: junk prints are ignored', () => {
  const f = new ShadowFlow();
  f.note('M', { ts: T0, side: 'sell', sol: 0 });
  f.note('M', { ts: T0, side: 'sell', sol: -2 });
  f.note('M', null);
  f.note(null, { ts: T0, side: 'sell', sol: 1 });
  assert.equal(f.window('M', T0, 15), null);
});

// ---- the would-fire test ----
const FLOW = { buySol: 0.5, sellSol: 2.5, sellShare: 2.5 / 3, trades: 9 };
test('ratchet shadow: fires — armed, off its high, exit-wave flow', () => {
  const fire = ratchetShadowFire({ peakMove: 1.12, tp1Done: false, move: 1.03, flow: FLOW, cfg: CFG });
  assert.ok(fire);
  assert.equal(fire.sellSol, 2.5);
});

test('ratchet shadow: no fire when unarmed (peak below the arm line, ratchet off)', () => {
  assert.equal(ratchetShadowFire({ peakMove: 1.04, tp1Done: false, move: 1.0, flow: FLOW, cfg: CFG }), null);
  assert.equal(ratchetShadowFire({ peakMove: null, tp1Done: false, move: 1.0, flow: FLOW, cfg: CFG }), null);
  assert.equal(ratchetShadowFire({ peakMove: 1.30, tp1Done: false, move: 1.0, flow: FLOW, cfg: { ...CFG, beArmPct: 0 } }), null);
});

test('ratchet shadow: no fire post-TP1 (the ladder owns the remainder)', () => {
  assert.equal(ratchetShadowFire({ peakMove: 1.40, tp1Done: true, move: 1.10, flow: FLOW, cfg: CFG }), null);
});

test('ratchet shadow: no fire at the peak — prints into new highs are absorption, not an exit wave', () => {
  assert.equal(ratchetShadowFire({ peakMove: 1.12, tp1Done: false, move: 1.12, flow: FLOW, cfg: CFG }), null);
  assert.equal(ratchetShadowFire({ peakMove: 1.12, tp1Done: false, move: 1.15, flow: FLOW, cfg: CFG }), null);
});

test('ratchet shadow: no fire when the share is heavy but the size is one whale (sellSol below floor)', () => {
  const oneWhale = { buySol: 0.05, sellSol: 0.9, sellShare: 0.947, trades: 2 };
  assert.equal(ratchetShadowFire({ peakMove: 1.12, tp1Done: false, move: 1.03, flow: oneWhale, cfg: CFG }), null);
});

test('ratchet shadow: no fire when size is real but buyers hold the share', () => {
  const contested = { buySol: 3.0, sellSol: 2.0, sellShare: 0.4, trades: 20 };
  assert.equal(ratchetShadowFire({ peakMove: 1.12, tp1Done: false, move: 1.03, flow: contested, cfg: CFG }), null);
});

test('ratchet shadow: no fire with no flow at all (no stream coverage = no opinion)', () => {
  assert.equal(ratchetShadowFire({ peakMove: 1.12, tp1Done: false, move: 1.03, flow: null, cfg: CFG }), null);
});

test('ratchet armed: mirrors the live ratchet’s arming definition', () => {
  assert.equal(ratchetArmed(1.05, false, CFG), true);
  assert.equal(ratchetArmed(1.049, false, CFG), false);
  assert.equal(ratchetArmed(1.50, true, CFG), false);
  assert.equal(ratchetArmed(1.50, false, { ...CFG, beArmPct: 0 }), false);
});

// ---- config ----
test('ratchet shadow config: defaults load and validate clean; knobs carry the designed values', () => {
  const c = loadConfig({});
  assert.equal(c.ratchetShadow, 1);
  assert.equal(c.ratchetFlowWindowSec, 15);
  assert.equal(c.ratchetFlowSellShare, 0.70);
  assert.equal(c.ratchetFlowMinSellSol, 1.0);
  assert.equal(validateConfig(c).length, 0);
});

test('ratchet shadow config: RATCHET_SHADOW=0 validates clean (designed off value); nonsense is rejected', () => {
  assert.equal(validateConfig(loadConfig({ RATCHET_SHADOW: '0' })).length, 0);
  assert.ok(validateConfig(loadConfig({ RATCHET_SHADOW: '2' })).some(e => e.includes('RATCHET_SHADOW')));
  assert.ok(validateConfig(loadConfig({ RATCHET_FLOW_WINDOW_SEC: '0' })).some(e => e.includes('RATCHET_FLOW_WINDOW_SEC')));
  assert.ok(validateConfig(loadConfig({ RATCHET_FLOW_SELL_SHARE: '1.5' })).some(e => e.includes('RATCHET_FLOW_SELL_SHARE')));
  assert.ok(validateConfig(loadConfig({ RATCHET_FLOW_MIN_SELL_SOL: '-1' })).some(e => e.includes('RATCHET_FLOW_MIN_SELL_SOL')));
});

// ---- bot wiring ----
function shadowRig(over = {}) {
  const cfg = testCfg({ fastPop: 0, dipStopPct: 0, ...over });
  const clock = { t: T0 };
  const rig = { cfg, clock, mark: 0 };
  rig.exec = {
    solBalance: async () => 5,
    markValue: async () => rig.mark,
    sell: async () => ({ tokensSold: '1000000', solOut: rig.mark, sig: null, simulated: true }),
    closeEmptyAccounts: async () => {},
  };
  rig.bot = new Bot(cfg, {
    now: () => clock.t, exec: rig.exec,
    discover: async () => new Map(), fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  rig.pos = (o = {}) => ({
    id: 'p1', mint: 'MINT1', symbol: 'SHDW', setup: 'pop', entrySol: 0.1, tokensRaw: '1000000',
    remainingFrac: 1, entryRoundTrip: 0.972, peakRatio: 1, peakMove: 1, entryTs: T0,
    realizedSol: 0, feesSol: 0, simulated: true, ...o,
  });
  rig.shadowRecs = () => {
    try { return fs.readFileSync(path.join(cfg.dataDir, 'ratchet_shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch { return []; }
  };
  return rig;
}

test('tradeWatchMints: held mints stream for the shadow judge with fast pop OFF; nothing extra when shadow is off', () => {
  const on = shadowRig();
  on.bot.positions.push(on.pos());
  assert.deepEqual(on.bot.tradeWatchMints(), ['MINT1']); // fastPop 0, shadow 1 → held only
  const off = shadowRig({ ratchetShadow: 0 });
  off.bot.positions.push(off.pos());
  assert.deepEqual(off.bot.tradeWatchMints(), []);       // both off → exactly today's behavior
  const fp = shadowRig({ fastPop: 1, ratchetShadow: 0 });
  fp.bot.positions.push(fp.pos());
  assert.deepEqual(fp.bot.tradeWatchMints(), ['MINT1']); // held first, as today
});

test('noteTrade: shadow buffers held mints only; with the switch off it buffers nothing', () => {
  const r = shadowRig();
  r.bot.positions.push(r.pos());
  r.bot.noteTrade('MINT1', { ts: T0, side: 'sell', sol: 2, tokens: 10, price: 0.2 });
  r.bot.noteTrade('OTHER', { ts: T0, side: 'sell', sol: 2, tokens: 10, price: 0.2 });
  assert.ok(r.bot.shadowFlow.window('MINT1', T0, 15));
  assert.equal(r.bot.shadowFlow.window('OTHER', T0, 15), null);
  const off = shadowRig({ ratchetShadow: 0 });
  off.bot.positions.push(off.pos());
  off.bot.noteTrade('MINT1', { ts: T0, side: 'sell', sol: 2, tokens: 10, price: 0.2 });
  assert.equal(off.bot.shadowFlow.window('MINT1', T0, 15), null);
});

test('judge: would-fire is recorded ONCE per position, with the flow snapshot; stats count it', () => {
  const r = shadowRig();
  const pos = r.pos({ peakMove: 1.12 });
  r.bot.positions.push(pos);
  r.bot.noteTrade('MINT1', { ts: T0, side: 'sell', sol: 2.0, tokens: 10, price: 0.2 });
  r.bot.noteTrade('MINT1', { ts: T0, side: 'buy', sol: 0.3, tokens: 10, price: 0.03 });
  r.bot.judgeRatchetShadow(pos, 1.03, T0);
  r.bot.judgeRatchetShadow(pos, 1.01, T0 + 4000); // still firing conditions — must NOT duplicate
  const recs = r.shadowRecs();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'would-fire');
  assert.equal(recs[0].mint, 'MINT1');
  assert.equal(recs[0].moveAtFire, 1.03);
  assert.equal(recs[0].peakMove, 1.12);
  assert.equal(recs[0].sellSol, 2.0);
  assert.equal(recs[0].sellShare, 0.87);
  assert.equal(recs[0].windowSec, 15);
  assert.equal(r.bot.stats.ratchetShadow.wouldFire, 1);
  assert.equal(pos.ratchetShadowArmed, true);
});

test('judge: switch off records nothing even in textbook fire conditions', () => {
  const r = shadowRig({ ratchetShadow: 0 });
  const pos = r.pos({ peakMove: 1.12 });
  r.bot.positions.push(pos);
  r.bot.noteShadowTrade('MINT1', { ts: T0, side: 'sell', sol: 3, tokens: 10 }); // direct feed still lands in the buffer…
  r.bot.judgeRatchetShadow(pos, 1.0, T0);                                       // …but the judge is off
  assert.deepEqual(r.shadowRecs(), []);
  assert.equal(r.bot.stats.ratchetShadow.wouldFire, 0);
});

test('ensureClose: an armed position’s close writes the completion record (ratchet-fired and other-exit variants)', () => {
  const r = shadowRig();
  const pos = r.pos({ peakMove: 1.12, ratchetShadowArmed: true, ratchetShadowFired: true, ratchetShadowMove: 1.01 });
  r.bot.positions.push(pos);
  r.bot.ensureClose(pos, { id: 'p1', mint: 'MINT1', symbol: 'SHDW', setup: 'pop', pnlSol: -0.001, reason: 'break-even ratchet (peaked +12.0%, back to +1.0%)', ts: T0 + 60000 });
  const recs = r.shadowRecs();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'closed');
  assert.equal(recs[0].outcome, 'closed');
  assert.equal(recs[0].ratchetFired, true);
  assert.equal(recs[0].wouldFire, true);
  assert.equal(recs[0].actualExitMove, 1.01);
  assert.equal(recs[0].pnlSol, -0.001);
  assert.equal(r.bot.stats.ratchetShadow.completed, 1);

  const r2 = shadowRig();
  const pos2 = r2.pos({ peakMove: 1.20, ratchetShadowArmed: true, ratchetShadowMove: 0.9 });
  r2.bot.positions.push(pos2);
  r2.bot.ensureClose(pos2, { id: 'p1', mint: 'MINT1', symbol: 'SHDW', setup: 'pop', pnlSol: -0.01, reason: 'bleed exit (-10.0% and still falling)', ts: T0 + 60000 });
  const recs2 = r2.shadowRecs();
  assert.equal(recs2.length, 1);
  assert.equal(recs2[0].ratchetFired, false);
  assert.equal(recs2[0].wouldFire, false);
  assert.equal(recs2[0].exitReason, 'bleed exit (-10.0% and still falling)');
});

test('ensureClose: a position the judge never saw armed gets NO completion record', () => {
  const r = shadowRig();
  const pos = r.pos({ peakMove: 1.02 });
  r.bot.positions.push(pos);
  r.bot.ensureClose(pos, { id: 'p1', mint: 'MINT1', symbol: 'SHDW', setup: 'pop', pnlSol: -0.005, reason: 'stall (in entry range at 180s, -2.0%)', ts: T0 + 60000 });
  assert.deepEqual(r.shadowRecs(), []);
  assert.equal(r.bot.stats.ratchetShadow.completed, 0);
});

// ---- the MINDPAD shape through the real position loop (exit-stack v2): the
//      LIVE Tratchet is stripped in code, so the position now rides through
//      the crash — but the shadow judge is a separate record-only module and
//      keeps scoring exactly as before: would-fire records, completion waits
//      for whatever exit eventually closes the position. ----
test('managePosition: armed position crashes through the line — the live stack holds (Tratchet stripped in v2); the shadow judge still records its would-fire', async () => {
  const r = shadowRig();
  const pos = r.pos();
  r.bot.positions.push(pos);
  // check 1: mark at move 1.12 (peak +12% on the realizable quote) — arms the shadow judge, no exit
  r.mark = 0.1 * 1.12 * 0.972;
  await r.bot.managePosition(pos, 150);
  assert.equal(r.bot.positions.length, 1);
  assert.ok(pos.peakMove > 1.11 && pos.peakMove < 1.13);
  assert.equal(pos.ratchetShadowArmed, true);
  // the exit wave prints on the stream inside the judge's window
  r.bot.noteTrade('MINT1', { ts: r.clock.t + 1000, side: 'sell', sol: 1.6, tokens: 10, price: 0.16 });
  r.bot.noteTrade('MINT1', { ts: r.clock.t + 2000, side: 'sell', sol: 0.9, tokens: 10, price: 0.09 });
  r.bot.noteTrade('MINT1', { ts: r.clock.t + 2000, side: 'buy', sol: 0.3, tokens: 10, price: 0.03 });
  // check 2 (4s later): the coin has crashed to move 0.93 — through the old +2% trigger
  r.clock.t += 4000;
  r.mark = 0.1 * 0.93 * 0.972;
  await r.bot.managePosition(pos, 150);
  assert.equal(r.bot.positions.length, 1, 'no live ratchet exists anymore — the position rides');
  const closes = r.bot.journal.trades.filter(t => t.type === 'close');
  assert.equal(closes.length, 0);
  const recs = r.shadowRecs();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'would-fire');
  assert.equal(recs[0].moveAtFire, 0.93);
  assert.deepEqual(r.bot.stats.ratchetShadow, { wouldFire: 1, completed: 0 });
});
