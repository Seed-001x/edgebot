// SMALL-BAG MOONBAG METHOD (owner order 2026-10-17 ~00:22 EDT, "no dead
// flow no 50% cut just hold"; amendment ~00:24, "definitely closet this
// method… once we start leaving bigger moon bags we utilize it"): while
// BAG_SMALL_HOLD is on (the default), exits.js 3c2 sells NOTHING on a
// post-TP2 bag — no staged waves, no legacy whole-bag fire — and the 3c3
// floor becomes the bag's downside exit: armed from TP2 with no wave
// precondition, confirming for BAG_FLOOR_CONFIRM_SEC (default 60) in the
// bagTrailSince discipline. Mode OFF is the closeted waves method, pinned
// by bagstaged.test.mjs / deadflow.test.mjs (rigs pin bagSmallHold: 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, tmp } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const S = 1000;
// Same isolation as bagstaged.test.mjs: txFeeSol 0 (move == ratio), the
// pre-TP2 families inert, real dead-flow defaults, real trail default
// (bagTrailPct 0.15), trail timer OFF (its precedence is not the subject
// here; the timer itself is pinned in bagtrailconfirm.test.mjs).
// bagSmallHold / bagFloorConfirmSec ride the config defaults (1 / 60).
const cfg = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0 });
const mark = (pos, ratio, o = {}) => ({ valueSol: pos.entrySol * pos.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
const thread = (p, d) => {
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if ('deadflowArmed' in d) p.deadflowArmed = d.deadflowArmed;
  if ('bagDeadWaves' in d) p.bagDeadWaves = d.bagDeadWaves;
  if ('bagDeadHot' in d) p.bagDeadHot = d.bagDeadHot;
  if ('bagFloorSince' in d) p.bagFloorSince = d.bagFloorSince;
  if ('bagTp2Ratio' in d) p.bagTp2Ratio = d.bagTp2Ratio;
  if ('bagTrimDone' in d) p.bagTrimDone = d.bagTrimDone;
  if (d.fraction > 0 && d.fraction < 1) p.remainingFrac *= (1 - d.fraction); // bot.js's booking for any partial
  if (d.tp1) p.tp1Done = true;
  if (d.tp2) p.tp2Done = true;
  return p;
};
const fresh = (o = {}) => ({ entrySol: 1, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });
function drive(p, steps, cfgX = cfg) {
  let now = p._now ?? p.entryTs; const ds = [];
  for (const st of steps) {
    now += (st.dt ?? 4) * S; p._now = now;
    if (st.buys !== undefined || st.sells !== undefined) {
      p.flowHist = [...(p.flowHist || []), { ts: now, buys: st.buys ?? null, sells: st.sells ?? null, tx: (st.buys != null || st.sells != null) ? (st.buys || 0) + (st.sells || 0) : null }].slice(-45);
    }
    const d = evaluateExit(p, mark(p, st.ratio, { buysM5: st.buys ?? null, sellsM5: st.sells ?? 0 }), cfgX, now);
    thread(p, d); ds.push(d);
  }
  return ds;
}
const seq = (ratios, buys, sells = 40) => ratios.map((ratio, i) => ({ ratio, buys: Array.isArray(buys) ? buys[i] : buys, sells: Array.isArray(sells) ? sells[i] : sells }));
const flat = (n, ratio, buys, sells = 40) => Array.from({ length: n }, () => ({ ratio, buys, sells }));

test('config: BAG_SMALL_HOLD / BAG_FLOOR_CONFIRM_SEC default on/60, env overrides, validation bounds them', () => {
  assert.equal(loadConfig({ DATA_DIR: tmp() }).bagSmallHold, 1);
  assert.equal(loadConfig({ DATA_DIR: tmp(), BAG_SMALL_HOLD: '0' }).bagSmallHold, 0);
  assert.equal(loadConfig({ DATA_DIR: tmp() }).bagFloorConfirmSec, 60);
  assert.equal(loadConfig({ DATA_DIR: tmp(), BAG_FLOOR_CONFIRM_SEC: '0' }).bagFloorConfirmSec, 0);
  assert.equal(loadConfig({ DATA_DIR: tmp(), BAG_FLOOR_CONFIRM_SEC: '45' }).bagFloorConfirmSec, 45);
  const base = loadConfig({ DATA_DIR: tmp() });
  assert.ok(validateConfig({ ...base, bagSmallHold: 2 }).some(e => /BAG_SMALL_HOLD/.test(e)));
  assert.ok(validateConfig({ ...base, bagFloorConfirmSec: -1 }).some(e => /BAG_FLOOR_CONFIRM_SEC/.test(e)));
  assert.ok(validateConfig({ ...base, bagFloorConfirmSec: 3601 }).some(e => /BAG_FLOOR_CONFIRM_SEC/.test(e)));
  assert.ok(!validateConfig(base).some(e => /BAG_SMALL_HOLD|BAG_FLOOR_CONFIRM_SEC/.test(e)));
});

// A moonbag at peak 1.90 (trail line 1.615) printing a flat 1.86 on a dead
// tape — the exact drive that fires staged waves in the closeted method.
const bagHigh = (o = {}) => fresh({ tp1Done: true, tp2Done: true, pathClass: 'ladder', remainingFrac: 0.25, peakRatio: 1.9, peakMove: 1.9, postTp1PeakMove: 1.9, ...o });

test('(a) small-bag mode: a dead tape post-TP2 sells nothing across many checks and never counts a wave', () => {
  const p = bagHigh();
  const steps = [...seq([1.90, 1.90, 1.90], [300, 306, 312]), ...flat(40, 1.86, 312)]; // buys flatline for ~160s
  const ds = drive(p, steps);
  for (const d of ds) {
    assert.equal(d.fraction, 0);
    assert.equal(d.reason, null);
    assert.equal(d.bagDeadWaves, 0);
    assert.ok(!d.deadflowEvents.some(e => e.type === 'wave' || e.type === 'fired'));
  }
  assert.equal(p.bagDeadWaves, 0);
  // Same drive with the closet opened (mode off): the waves method is
  // intact behind the switch — wave 1 fires on the dead tape.
  const p2 = bagHigh();
  const ds2 = drive(p2, steps, testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0, bagSmallHold: 0 }));
  assert.ok(ds2.some(d => d.bagWave === 1 && d.fraction === 0.5));
});

// A moonbag with a LOW peak (1.25, trail line 1.0625): prints between the
// trail line and the floor line (1.10) judge the floor alone.
const bagLow = (o = {}) => fresh({ tp1Done: true, tp2Done: true, pathClass: 'ladder', remainingFrac: 0.05, peakRatio: 1.25, peakMove: 1.25, postTp1PeakMove: 1.25, ...o });
const carry = (p, d) => thread({ ...p }, d);

test('(b) the floor is armed immediately post-TP2 in small-bag mode — the first at/below check pends, no waves involved', () => {
  const p = bagLow();
  assert.equal(p.bagDeadWaves ?? 0, 0);
  const d = evaluateExit(p, mark(p, 1.08), cfg, T0 + 4000); // first-ever moonbag check, already under the line
  assert.equal(d.fraction, 0); // pending, not a sale
  assert.equal(d.bagFloorSince, T0 + 4000); // armed + stamped on that very check
  assert.ok(d.deadflowEvents.some(e => e.type === 'floor-pending'));
  assert.equal(d.bagDeadWaves, 0);
});

test('(c) floor confirmation: breach pends, recovery disarms with no credit, 60 continuous seconds sells in full', () => {
  const p0 = bagLow();
  const t = T0 + 4000;
  const d1 = evaluateExit(p0, mark(p0, 1.08), cfg, t); // breach #1 pends
  assert.equal(d1.fraction, 0); assert.equal(d1.bagFloorSince, t);
  const d2 = evaluateExit(carry(p0, d1), mark(p0, 1.08), cfg, t + 30000); // 30s in (the OLD fire moment): still holding, no sale
  assert.equal(d2.fraction, 0); assert.equal(d2.bagFloorSince, t);
  const d3 = evaluateExit(carry(p0, d2), mark(p0, 1.08), cfg, t + 45000); // 45s in: still inside the 60s window
  assert.equal(d3.fraction, 0); assert.equal(d3.bagFloorSince, t);
  const d4 = evaluateExit(carry(p0, d3), mark(p0, 1.15), cfg, t + 50000); // bounce back above the line before 60s: disarmed
  assert.equal(d4.fraction, 0); assert.equal(d4.bagFloorSince, null);
  assert.ok(d4.deadflowEvents.some(e => e.type === 'floor-cleared'));
  const d5 = evaluateExit(carry(p0, d4), mark(p0, 1.08), cfg, t + 55000); // breach #2: a FRESH window
  assert.equal(d5.fraction, 0); assert.equal(d5.bagFloorSince, t + 55000);
  const d6 = evaluateExit(carry(p0, d5), mark(p0, 1.08), cfg, t + 114000); // 59s into #2 (110s after #1): no sale — no accumulated credit
  assert.equal(d6.fraction, 0);
  const d7 = evaluateExit(carry(p0, d6), mark(p0, 1.08), cfg, t + 115000); // 60s into #2: sells in full
  assert.equal(d7.fraction, 1);
  assert.match(d7.reason, /^moonbag floor \(\+10% over entry, held 60s\)$/);
  assert.ok(d7.deadflowEvents.some(e => e.type === 'floor'));
});

test('(d) BAG_FLOOR_CONFIRM_SEC=0 restores the instant floor in small-bag mode — same check, same string, no state', () => {
  const cfg0 = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0, bagFloorConfirmSec: 0 });
  const p = bagLow();
  const d = evaluateExit(p, mark(p, 1.08), cfg0, T0 + 4000);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /^moonbag floor \(\+10% over entry\)$/);
  assert.equal(d.bagFloorSince, null);
  assert.ok(!d.deadflowEvents.some(e => e.type === 'floor-pending' || e.type === 'floor-cleared'));
  // …and above the line the instant window changes nothing.
  const d2 = evaluateExit(bagLow(), mark(p, 1.15), cfg0, T0 + 4000);
  assert.equal(d2.fraction, 0);
});

// ---- TRAIL REMOVED IN SMALL-BAG MODE (owner order 2026-10-17 ~04:38 EDT,
// "let's do that cause it wouldn't have cost me too much anyways"): the
// moonbag trail (3c) is closeted with the waves. Judged here on the LIVE
// dials — bagTrailPct / bagTrailConfirmSec / bagFloorConfirmSec all ride
// the config defaults, no timer pins — so the trail, were it live, would
// be fully armed: peak 2.80, trail line 2.38 (and 1.96 at the live store's
// -30%): a print of 1.60 is 43% off the peak, past either line.
const cfgLive = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0 });
const bagStub = (o = {}) => fresh({ tp1Done: true, tp2Done: true, pathClass: 'ladder', remainingFrac: 0.05, peakRatio: 2.8, peakMove: 2.8, postTp1PeakMove: 2.8, bagTp2Ratio: 1.8, ...o });

test('(e) small-bag mode: a 30%+ retrace held well past the trail window sells nothing, stamps no trail pending — the floor alone exits the bag', () => {
  const p = bagStub();
  const crash = drive(p, flat(40, 1.60, 300)); // ~160s deep under the trail line, way past the 60s confirm
  for (const d of crash) {
    assert.equal(d.fraction, 0);
    assert.equal(d.reason, null);
    assert.equal(d.bagTrailSince, null); // never arms, never stamps
    assert.ok(!d.deadflowEvents.some(e => e.type === 'trail-pending' || e.type === 'trail-cleared'));
    assert.equal(d.bagDeadWaves, 0);
  }
  assert.equal(p.remainingFrac, 0.05); // the whole stub still rides
  // Now the fall continues to the +10% floor line: the first check pends,
  // and only the floor's own 60s confirm sells — in full, as the floor.
  const fall = drive(p, flat(16, 1.05, 300)); // pends on #1, matures at +60s on #16
  assert.equal(fall[0].fraction, 0);
  assert.notEqual(fall[0].bagFloorSince, null);
  assert.ok(fall[0].deadflowEvents.some(e => e.type === 'floor-pending'));
  assert.equal(fall[8].fraction, 0); // 32s under the line (past the OLD window): still no sale
  const sale = fall[fall.length - 1];
  assert.equal(sale.fraction, 1);
  assert.match(sale.reason, /^moonbag floor \(\+10% over entry, held 60s\)$/);
  assert.equal(fall.filter(d => d.fraction === 1).length, 1); // exactly one sale…
  assert.ok(fall.slice(0, -1).every(d => d.fraction === 0)); // …and nothing before the floor matured
});

test('(f) small-bag mode: a trail stamp a position somehow carries drops silently — no event, no sale', () => {
  const p = bagStub({ bagTrailSince: T0 }); // e.g. armed under the closet, judged after the mode flipped
  const d = evaluateExit(p, mark(p, 1.60), cfgLive, T0 + 4000);
  assert.equal(d.fraction, 0);
  assert.equal(d.bagTrailSince, null);
  assert.ok(!d.deadflowEvents.some(e => e.type === 'trail-pending' || e.type === 'trail-cleared'));
});

test('(g) small-bag mode: the moonbag trim still fires at 3x the TP2 stamp — 50%, once', () => {
  const p = bagStub({ peakRatio: 5.45, peakMove: 5.45, postTp1PeakMove: 5.45 }); // trim line = 3 × 1.8 = 5.4
  const ds = drive(p, [{ ratio: 5.45, buys: 300 }, { ratio: 5.50, buys: 300 }], cfgLive);
  assert.equal(ds[0].fraction, 0.5);
  assert.equal(ds[0].bagTrim, true);
  assert.match(ds[0].reason, /^moonbag trim/);
  assert.equal(ds[0].bagTrailSince, null);
  assert.equal(ds[1].fraction, 0); // once per position — the re-cross sells nothing
  assert.ok(!ds[1].bagTrim);
});

test('scope: no floor pending accrues pre-TP2 or in the closeted mode, and a carried stamp drops outside the mode', () => {
  const mid = fresh({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.25, peakMove: 1.25 }); // pre-TP2, under the line
  const d = evaluateExit(mid, mark(mid, 1.05), cfg, T0 + 4000);
  assert.equal(d.bagFloorSince, null);
  assert.ok(!d.deadflowEvents.some(e => e.type === 'floor-pending'));
  const carried = bagLow({ bagFloorSince: T0 }); // a stamp restored from disk, judged with the closet open
  const dOff = evaluateExit(carried, mark(carried, 1.08), testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0, bagSmallHold: 0 }), T0 + 4000);
  assert.equal(dOff.bagFloorSince, null);
});
