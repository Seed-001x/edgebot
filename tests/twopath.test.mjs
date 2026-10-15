// TWO-PATH EXIT REDESIGN (user 2026-10-15, variant c): classification at TP1 by
// the fire's realized gain ([+20%, +40%] modest / above ladder / below ladder +
// kill-zone overlay), the modest remainder (no trails — a +50% target that SPLITS
// 2/3 banked + 1/3 converted to ladder), and the kill zone (absolute +10% floor,
// arms only at a 1.25x post-TP1 peak, 10s confirmation window, instant sell on
// re-entry). Design record: user/files/exit-redesign-note-2026-10-15.md (§1, §7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const S = 1000;
// txFeeSol 0 makes gain == ratio - 1 exactly, so fire prices land where the test
// aims them. TP1: arms +10%, ceiling +60%, giveback 8pts — fires print the drop
// target via rollover. Trails at the live 15% so the SCRIP shape is faithful.
const cfg = testCfg({ txFeeSol: 0, tp1Pct: 0.10, tp1AdaptMax: 0.60, tp1Giveback: 0.08, tp1Frac: 0.4, tp2Pct: 0.80, tpTrailPct: 0.15, exitConfirmSec: 10, stallProbationSec: 0, lockKeep: 0, dipStopPct: 0 });
const mark = (pos, ratio, o = {}) => ({ valueSol: pos.entrySol * pos.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
// thread the caller-persisted state from a decision back into the fixture, as bot.js does
const thread = (p, d) => {
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if ('tp1Arm' in d) p.tp1Arm = d.tp1Arm;
  if ('exitPending' in d) p.exitPending = d.exitPending;
  if ('killZone' in d) p.killZone = d.killZone;
  if ('postTp1PeakMove' in d) p.postTp1PeakMove = d.postTp1PeakMove;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if ('probationSince' in d) p.probationSince = d.probationSince;
  return p;
};
const fresh = (o = {}) => ({ entrySol: 1, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });
const rem = (o = {}) => ({ entrySol: 0.05, remainingFrac: 0.6, peakRatio: 1, peakMove: 1, tp1Done: true, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });

// Drive a TP1 fire at an exact realized gain: rise to the peak (arms TP1), then
// drop to the fire gain (rollover banks it). Returns the firing decision.
function classifyAt(fireGain, peakGain) {
  const p = fresh();
  const d1 = evaluateExit(p, mark(p, 1 + peakGain), cfg, T0);
  assert.equal(d1.fraction, 0, 'peak check must not fire');
  thread(p, d1);
  const d2 = evaluateExit(p, mark(p, 1 + fireGain), cfg, T0 + 4 * S);
  assert.equal(d2.tp1, true, `expected a TP1 fire at +${fireGain * 100}%`);
  return d2;
}

// ---- classification band edges ----
test('classify: fire at +19.9% → ladder + kill-zone overlay', () => {
  const d = classifyAt(0.199, 0.30);
  assert.equal(d.pathClass, 'ladder'); assert.equal(d.killZoneOverlay, true);
});
test('classify: fire at the +20% band edge → modest, no overlay', () => {
  const d = classifyAt(0.20 + 1e-9, 0.30);
  assert.equal(d.pathClass, 'modest'); assert.equal(d.killZoneOverlay, false);
});
test('classify: fire at +30% (mid-band) → modest', () => {
  const d = classifyAt(0.30, 0.42);
  assert.equal(d.pathClass, 'modest'); assert.equal(d.killZoneOverlay, false);
});
test('classify: fire at the +40% band edge → modest', () => {
  const d = classifyAt(0.40 - 1e-9, 0.50);
  assert.equal(d.pathClass, 'modest'); assert.equal(d.killZoneOverlay, false);
});
test('classify: fire at +40.1% → ladder, no overlay', () => {
  const d = classifyAt(0.401, 0.50);
  assert.equal(d.pathClass, 'ladder'); assert.equal(d.killZoneOverlay, false);
});
test('classify: NEYMAR shape — fire at +11% → ladder + overlay', () => {
  const d = classifyAt(0.11, 0.30);
  assert.equal(d.pathClass, 'ladder'); assert.equal(d.killZoneOverlay, true);
});

// ---- modest remainder: no trails, rides to the split ----
test('modest: SCRIP shape — a +40% retrace from a 1.66x peak does NOT trail-sell (the ladder control does)', () => {
  const base = { pathClass: 'modest', peakRatio: 1.66, peakMove: 1.66, postTp1PeakMove: 1.66, killZone: { armed: true, entries: 0 } };
  const d = evaluateExit(rem(base), mark(rem(base), 1.402), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 0);
  const ctl = { ...base, pathClass: 'ladder' };
  const dc = evaluateExit(rem(ctl), mark(rem(ctl), 1.402), cfg, T0 + 60 * S);
  assert.equal(dc.fraction, 1); assert.match(dc.reason, /post-TP1 trail/);
});
test('modest: crossing +50% splits — bank fraction of the remainder, modestSplit flagged', () => {
  const p = rem({ pathClass: 'modest', peakRatio: 1.49, peakMove: 1.49, postTp1PeakMove: 1.49 });
  const d = evaluateExit(p, mark(p, 1.52), cfg, T0 + 60 * S);
  assert.equal(d.modestSplit, true);
  assert.equal(d.fraction, cfg.modestSplitBankFrac);
  assert.match(d.reason, /modest target \+50%/);
});
test('modest: the converted slice is plain ladder — TP2 fires on it (original-fraction convention clamps to the whole slice)', () => {
  // after the split: 0.6 * (1 - 2/3) = 0.20 of the original remains; TP2 sells
  // tp2Frac (0.35) OF THE ORIGINAL → 0.35/0.20 > 1 → clamped to the full slice.
  const p = rem({ remainingFrac: 0.2, pathClass: 'ladder', splitDone: true, peakRatio: 1.66, peakMove: 1.66, postTp1PeakMove: 1.66 });
  const d = evaluateExit(p, mark(p, 1.85), cfg, T0 + 120 * S);
  assert.equal(d.tp2, true); assert.equal(d.fraction, 1);
});

// ---- kill zone: arming gate ----
test('zone: inert before arming — a dip to +5% with a 1.20x post-TP1 peak accrues no zone state', () => {
  const p = rem({ pathClass: 'modest', postTp1PeakMove: 1.20, killZone: null });
  const d = evaluateExit(p, mark(p, 1.05), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 0);
  assert.equal(d.killZone, null);
  assert.equal(d.killzoneEvents.length, 0);
});
test('zone: arms when the post-TP1 peak reaches 1.25x', () => {
  const p = rem({ pathClass: 'modest', postTp1PeakMove: 1.10, killZone: null });
  const d = evaluateExit(p, mark(p, 1.26), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 0);
  assert.deepEqual(d.killzoneEvents, [{ type: 'armed' }]);
  assert.equal(d.killZone.armed, true);
});

// ---- kill zone: window, cancel, re-entry ----
test('zone: first entry opens the 10s window, recovery cancels + counts the entry, second entry sells instantly', () => {
  const p = rem({ pathClass: 'modest', postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30 });
  let d = evaluateExit(p, mark(p, 1.08), cfg, T0 + 100 * S); thread(p, d);
  assert.equal(d.fraction, 0); assert.equal(d.exitPending.killzone, T0 + 100 * S);
  d = evaluateExit(p, mark(p, 1.05), cfg, T0 + 104 * S); thread(p, d);
  assert.equal(d.fraction, 0, 'inside the window it must not sell yet');
  d = evaluateExit(p, mark(p, 1.30), cfg, T0 + 108 * S); thread(p, d);
  assert.equal(d.fraction, 0);
  assert.deepEqual(d.killzoneEvents, [{ type: 'cancelled' }]);
  assert.equal(d.killZone.entries, 1);
  assert.equal(d.exitPending.killzone, undefined);
  d = evaluateExit(p, mark(p, 1.07), cfg, T0 + 112 * S);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /kill zone \(re-entry/);
  assert.deepEqual(d.killzoneEvents, [{ type: 'reentry' }]);
});
test('zone: a first entry that holds through the window sells the full remainder at lapse', () => {
  const p = rem({ pathClass: 'modest', postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30 });
  let d = evaluateExit(p, mark(p, 1.08), cfg, T0 + 100 * S); thread(p, d);
  assert.equal(d.exitPending.killzone, T0 + 100 * S);
  d = evaluateExit(p, mark(p, 1.06), cfg, T0 + 110 * S);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /kill zone \(move .* held at\/below the \+10% floor/);
  assert.deepEqual(d.killzoneEvents, [{ type: 'fired' }]);
  assert.ok(d.exitConfirmEvents.some(e => e.type === 'confirmed' && e.kind === 'killzone'));
});

// ---- overlay ladder remainders: ladder intact + zone overlaid ----
test('overlay: TP2 still fires, the trail still fires (and beats the zone), and the zone arms on its own line', () => {
  const tp2p = rem({ pathClass: 'ladder', killZoneOverlay: true, postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30 });
  const dTp2 = evaluateExit(tp2p, mark(tp2p, 1.85), cfg, T0 + 60 * S);
  assert.equal(dTp2.tp2, true);
  // trail line (1.32 * 0.85 = 1.122) sits above the zone floor: the trail owns the descent
  const trp = rem({ pathClass: 'ladder', killZoneOverlay: true, postTp1PeakMove: 1.32, killZone: { armed: true, entries: 0 }, peakRatio: 1.32, peakMove: 1.32 });
  const dTr = evaluateExit(trp, mark(trp, 1.10), cfg, T0 + 60 * S);
  assert.equal(dTr.fraction, 1); assert.match(dTr.reason, /post-TP1 trail/);
  assert.equal(dTr.exitPending.killzone, undefined);
  // trail line (1.26 * 0.85 = 1.071) sits below the floor: the zone takes the dip
  const zp = rem({ pathClass: 'ladder', killZoneOverlay: true, postTp1PeakMove: 1.26, killZone: { armed: true, entries: 0 }, peakRatio: 1.26, peakMove: 1.26 });
  const dZ = evaluateExit(zp, mark(zp, 1.09), cfg, T0 + 60 * S);
  assert.equal(dZ.fraction, 0); assert.equal(dZ.exitPending.killzone, T0 + 60 * S);
});
test('overlay: NEYMAR shape — a run to 2.5x is never zone-sold; post-TP2 the bag trail owns it', () => {
  const p = rem({ pathClass: 'ladder', killZoneOverlay: true, postTp1PeakMove: 1.11, killZone: null, peakRatio: 1.11, peakMove: 1.11 });
  let d = evaluateExit(p, mark(p, 1.40), cfg, T0 + 60 * S); thread(p, d);
  assert.equal(d.fraction, 0);
  d = evaluateExit(p, mark(p, 2.00), cfg, T0 + 120 * S); thread(p, d);
  assert.equal(d.tp2, true, 'the ladder TP2 banks on the way up, as today');
  assert.ok(!d.killzoneEvents.some(e => e.type === 'fired' || e.type === 'reentry'));
  const bag = rem({ pathClass: 'ladder', killZoneOverlay: true, tp2Done: true, postTp1PeakMove: 2.51, killZone: { armed: true, entries: 0 }, peakRatio: 2.51, peakMove: 2.51 });
  const dBag = evaluateExit(bag, mark(bag, 1.05), cfg, T0 + 300 * S);
  assert.equal(dBag.fraction, 1); assert.match(dBag.reason, /moonbag trail/);
});

// ---- >+40% ladder: byte-identical behavior, no zone, no target ----
test('ladder (>40%): no zone accrues and no modest target exists — the trail judges as before', () => {
  const p = rem({ pathClass: 'ladder', killZoneOverlay: false, postTp1PeakMove: 1.66, killZone: null, peakRatio: 1.66, peakMove: 1.66 });
  const d = evaluateExit(p, mark(p, 1.05), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 1); assert.match(d.reason, /post-TP1 trail/);
  assert.equal(d.killZone, null); assert.equal(d.killzoneEvents.length, 0);
  const p2 = rem({ pathClass: 'ladder', killZoneOverlay: false, peakRatio: 1.55, peakMove: 1.55 });
  const d2 = evaluateExit(p2, mark(p2, 1.55), cfg, T0 + 60 * S);
  assert.equal(d2.fraction, 0); assert.equal(d2.modestSplit, undefined);
});

// ---- protect: suppresses the zone, never the split ----
test('protect: a protected modest remainder in the zone is suppressed (counted), the +50% split still fires', () => {
  const p = rem({ pathClass: 'modest', protected: T0, postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30 });
  const d = evaluateExit(p, mark(p, 1.05), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, 'kill zone');
  assert.equal(d.exitPending.killzone, undefined);
  const d2 = evaluateExit(p, mark(p, 1.52), cfg, T0 + 64 * S);
  assert.equal(d2.modestSplit, true);
});

// ---- precedence: a fail-safe pending owns the slot; the zone waits ----
test('precedence: bleed pending first — the zone does not arm, the bleed confirms alone (single owner)', () => {
  const t = T0 + 400 * S; // age 400s: past the bleed prove-itself window
  const p = rem({ pathClass: 'modest', entryTs: T0, postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30, moveHist: [{ ts: t - 60 * S, move: 0.95 }] });
  let d = evaluateExit(p, mark(p, 0.90), cfg, t); thread(p, d);
  assert.equal(d.fraction, 0);
  assert.equal(d.exitPending.bleed, t);
  assert.equal(d.exitPending.killzone, undefined, 'zone must wait while the bleed owns the slot');
  d = evaluateExit(p, mark(p, 0.88), cfg, t + 11 * S);
  assert.equal(d.fraction, 1); assert.match(d.reason, /bleed exit/);
});

// ---- config: knobs + validation ----
test('config: redesign knobs carry the decided defaults and validate', () => {
  const c = loadConfig({ DATA_DIR: '/tmp/twopath-cfg' });
  assert.equal(c.modestMinPct, 0.20); assert.equal(c.modestMaxPct, 0.40);
  assert.equal(c.modestTargetPct, 0.50); assert.equal(c.modestSplitBankFrac, 0.6667);
  assert.equal(c.killZoneFloorPct, 0.10); assert.equal(c.killZoneArmMult, 1.25);
  const bad = loadConfig({ DATA_DIR: '/tmp/twopath-cfg', MODEST_MIN_PCT: '0.5', MODEST_MAX_PCT: '0.4', KILL_ZONE_ARM_MULT: '0.5' });
  const errs = validateConfig(bad);
  assert.ok(errs.some(e => e.includes('MODEST_MAX_PCT')), errs.join('; '));
  assert.ok(errs.some(e => e.includes('KILL_ZONE_ARM_MULT')), errs.join('; '));
});

// ---- bot-level: unprotect re-arms the zone fresh; close records carry the class ----
test('bot: unprotect resets the kill-zone record; ensureClose stamps path; /state exposes path', () => {
  const cfgB = testCfg();
  const exec = new Executor(cfgB, { quote: async (input) => (input === SOL_MINT ? { outAmount: '1000000000', priceImpactPct: '0.01' } : { outAmount: '0' }) });
  const deps = { now: () => T0, exec, discover: async () => new Map(), fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [] };
  const bot = new Bot(cfgB, deps);
  const p = { id: 'posZ', mint: 'MINTZ', symbol: 'ZZZ', setup: 'pop', entrySol: 0.05, remainingFrac: 0.6, peakRatio: 1.3, peakMove: 1.3, entryTs: T0, exitPending: {}, protected: T0, pathClass: 'modest', killZone: { armed: true, entries: 1 } };
  bot.positions.push(p);
  assert.equal(bot.state().positions[0].path, 'modest');
  bot.unprotectPosition('MINTZ');
  assert.equal(p.killZone, null, 'unprotect re-arms the zone fresh');
  const ok = bot.ensureClose(p, { id: p.id, mint: p.mint, symbol: p.symbol, setup: p.setup, entrySol: p.entrySol, exitSol: 0.06, pnlSol: 0.01, heldMin: 5, reason: 'test close', simulated: false, ts: T0 });
  assert.equal(ok, true);
  const close = bot.journal.trades.find(x => x.type === 'close' && x.id === 'posZ');
  assert.equal(close.path, 'modest');
});
