// MOONBAG TRIM (owner order 2026-10-17 ~00:27 EDT, "200% from TP2 — trim
// 50%"): once per position, when the post-TP2 bag's realizable ratio
// reaches BAG_TRIM_MULT (3) × the ratio stamped at the TP2 print — +200%
// measured from the TP2 moment — exits.js 3c1 sells half the CURRENT
// remainder and the persisted bagTrimDone flag guarantees it never fires
// again. Judged on ratio, never remainingFrac; both bag modes; protect
// does not suppress it (TP-ladder family). The TP2 check itself stamps
// the baseline (bagTp2Ratio); a position that crossed TP2 before the
// stamp existed judges against 1 + tp2Pct, the TP2 trigger level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, tmp } from './helpers.mjs';

const NOW = 1_000_000_000_000;
// txFeeSol 0 (gain == ratio − 1), pre-TP2 families inert, trail timer off
// (the trail's precedence on the surviving half is asserted, its timer is
// pinned in bagtrailconfirm.test.mjs). Small-bag mode rides the default.
const cfg = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0 });
const pos = (o = {}) => ({ entrySol: 0.02, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: NOW - 5 * 60000, exitPending: {}, flowHist: [], moveHist: [], ...o });
const mark = (p, ratio, o = {}) => ({ valueSol: p.entrySol * p.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
// Thread a decision's state back the way bot.js does, booking any partial.
const carry = (p, d) => {
  const q = { ...p };
  if (d.newPeak != null) q.peakRatio = d.newPeak;
  if (d.newPeakMove != null) q.peakMove = d.newPeakMove;
  if ('bagTp2Ratio' in d) q.bagTp2Ratio = d.bagTp2Ratio;
  if ('bagTrimDone' in d) q.bagTrimDone = d.bagTrimDone;
  if ('bagFloorSince' in d) q.bagFloorSince = d.bagFloorSince;
  if (d.fraction > 0 && d.fraction < 1) q.remainingFrac *= (1 - d.fraction);
  if (d.tp1) q.tp1Done = true;
  if (d.tp2) q.tp2Done = true;
  return q;
};
// A moonbag whose TP2 print stamped 1.80: the trim line rides at 5.40.
const bag = (o = {}) => pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.05, peakRatio: 1.9, peakMove: 1.9, bagTp2Ratio: 1.8, ...o });

test('config: BAG_TRIM_MULT defaults to 3, env overrides, validation bounds it', () => {
  assert.equal(loadConfig({ DATA_DIR: tmp() }).bagTrimMult, 3);
  assert.equal(loadConfig({ DATA_DIR: tmp(), BAG_TRIM_MULT: '0' }).bagTrimMult, 0);
  assert.equal(loadConfig({ DATA_DIR: tmp(), BAG_TRIM_MULT: '4' }).bagTrimMult, 4);
  const base = loadConfig({ DATA_DIR: tmp() });
  assert.ok(validateConfig({ ...base, bagTrimMult: -1 }).some(e => /BAG_TRIM_MULT/.test(e)));
  assert.ok(validateConfig({ ...base, bagTrimMult: 101 }).some(e => /BAG_TRIM_MULT/.test(e)));
  assert.ok(!validateConfig(base).some(e => /BAG_TRIM_MULT/.test(e)));
});

test('(a) reaching 3x the TP2 stamp trims exactly 50% of the current remainder, once', () => {
  const p0 = bag();
  const d1 = evaluateExit(p0, mark(p0, 5.35), cfg, NOW); // under the 5.40 line: nothing
  assert.equal(d1.fraction, 0); assert.equal(d1.bagTrimDone, false); assert.ok(!d1.bagTrim);
  const d2 = evaluateExit(carry(p0, d1), mark(p0, 5.45), cfg, NOW + 4000); // past the line: trim fires
  assert.equal(d2.fraction, 0.5);
  assert.equal(d2.bagTrim, true);
  assert.equal(d2.bagTrimDone, true);
  assert.match(d2.reason, /^moonbag trim \(\+200% from TP2 — sold 50%, now \+445\.0%\)$/);
});

test('(b) no refire: later checks, deeper runs and re-crossings never trim again', () => {
  const p0 = bag();
  const d1 = evaluateExit(p0, mark(p0, 5.45), cfg, NOW);
  assert.equal(d1.bagTrim, true);
  const p1 = carry(p0, d1); // remainder halved by the booking, flag persisted
  assert.equal(p1.remainingFrac, 0.025);
  const d2 = evaluateExit(p1, mark(p1, 6.00), cfg, NOW + 4000); // higher still: quiet
  assert.equal(d2.fraction, 0); assert.ok(!d2.bagTrim);
  const p2 = carry(p1, d2);
  const d3 = evaluateExit(p2, mark(p2, 5.20), cfg, NOW + 8000); // shallow dip (trail line is 5.10): quiet
  assert.equal(d3.fraction, 0);
  const d4 = evaluateExit(carry(p2, d3), mark(p2, 5.60), cfg, NOW + 12000); // re-cross upward: still no second trim
  assert.equal(d4.fraction, 0); assert.ok(!d4.bagTrim); assert.equal(d4.bagTrimDone, true);
});

test('(c) never fires pre-TP2, and the TP2 print itself stamps the baseline the trim judges from', () => {
  // TP2 disabled by size (tp2Frac 0): a pre-TP2 position at a huge print
  // has no moonbag and no trim, however high it flies.
  const cfgNoTp2 = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0, tp2Frac: 0 });
  const mid = pos({ tp1Done: true, remainingFrac: 0.65, peakRatio: 1.5, peakMove: 1.5 });
  const d0 = evaluateExit(mid, mark(mid, 6.0), cfgNoTp2, NOW);
  assert.equal(d0.fraction, 0); assert.ok(!d0.bagTrim); assert.equal(d0.bagTp2Ratio, null);
  // The normal ladder: TP2 banks at +100% (this cfg's tp2Pct) and the
  // firing check's own ratio becomes the stamp.
  const p0 = pos({ tp1Done: true, remainingFrac: 0.65, peakRatio: 1.5, peakMove: 1.5 });
  const d1 = evaluateExit(p0, mark(p0, 2.01), cfg, NOW);
  assert.equal(d1.tp2, true); assert.ok(!d1.bagTrim);
  assert.ok(Math.abs(d1.bagTp2Ratio - 2.01) < 1e-9); // stamped at the TP2 print, not the 1 + tp2Pct trigger
  const p1 = carry(p0, d1);
  const d2 = evaluateExit(p1, mark(p1, 6.02), cfg, NOW + 4000); // under 3 × 2.01: quiet
  assert.equal(d2.fraction, 0);
  const d3 = evaluateExit(carry(p1, d2), mark(p1, 6.04), cfg, NOW + 8000); // past the stamped line: trim
  assert.equal(d3.fraction, 0.5); assert.equal(d3.bagTrim, true);
});

test('(c2) a pre-stamp moonbag (crossed TP2 before the stamp existed) judges against 1 + tp2Pct', () => {
  const legacy = bag({ bagTp2Ratio: null }); // tp2Pct is 1.00 in this cfg → baseline 2.0, line 6.0
  const d1 = evaluateExit(legacy, mark(legacy, 5.95), cfg, NOW);
  assert.equal(d1.fraction, 0);
  const d2 = evaluateExit(legacy, mark(legacy, 6.05), cfg, NOW + 4000);
  assert.equal(d2.fraction, 0.5); assert.equal(d2.bagTrim, true);
});

test('(d) the post-trim remainder still exits via the trail normally (big-bag mode — the trail is closeted there)', () => {
  const cfgBig = { ...cfg, bagSmallHold: 0 }; // since 2026-10-17 ~04:38 the trail judges only with the closet open; the trim itself is mode-agnostic (above)
  const p0 = bag();
  const d1 = evaluateExit(p0, mark(p0, 5.45), cfgBig, NOW);
  assert.equal(d1.bagTrim, true);
  const p1 = carry(p0, d1); // half the bag survives, peak now 5.45, trail line 4.63
  const d2 = evaluateExit(p1, mark(p1, 4.50), cfgBig, NOW + 4000); // a deep retrace off the peak: the trail takes the rest
  assert.equal(d2.fraction, 1);
  assert.match(d2.reason, /^moonbag trail \(15% off peak 5\.45x, now 350\.0%\)$/);
});

test('protect does not suppress the trim (TP-ladder family), and BAG_TRIM_MULT=0 turns it off', () => {
  const prot = bag({ protected: true });
  const d = evaluateExit(prot, mark(prot, 5.45), cfg, NOW);
  assert.equal(d.fraction, 0.5); assert.equal(d.bagTrim, true);
  const cfgOff = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0, bagTrimMult: 0 });
  const dOff = evaluateExit(bag(), mark(bag(), 9.0), cfgOff, NOW);
  assert.equal(dOff.fraction, 0); assert.ok(!dOff.bagTrim);
});
