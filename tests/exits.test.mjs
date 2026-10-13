import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { testCfg } from './helpers.mjs';

const cfg = testCfg(); const NOW = 1_000_000_000_000;
const pos = (o = {}) => ({ entrySol: 0.02, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 5 * 60000, ...o });
const mark = (valueSol, o = {}) => ({ valueSol, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });

test('holds in the quiet middle', () => assert.equal(evaluateExit(pos({ entryTs: NOW - 30000 }), mark(0.021), cfg, NOW).fraction, 0));
test('stop-loss on realizable value (backstop when dip stop is off)', () => { const c = { ...cfg, dipStopPct: 0 }; const d1 = evaluateExit(pos(), mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW); assert.equal(d1.fraction, 0); assert.equal(d1.floorChecks, 1); const d = evaluateExit(pos({ floorChecks: d1.floorChecks }), mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW); assert.equal(d.fraction, 1); assert.match(d.reason, /stop-loss/); });
test('TP1 sells the configured fraction once', () => {
  const d = evaluateExit(pos(), mark(0.04), cfg, NOW); assert.equal(d.fraction, 0.75); assert.equal(d.tp1, true);
  assert.equal(evaluateExit(pos({ tp1Done: true, remainingFrac: 0.25 }), mark(0.01), cfg, NOW).fraction, 0); // ratio 2.0 on remaining basis, not re-triggered
});
test('trailing stop after arming', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.25, peakRatio: 2 });
  const d = evaluateExit(p, mark(0.004), cfg, NOW);             // ratio 0.8 ≤ 2*0.5
  assert.equal(d.fraction, 1); assert.match(d.reason, /trailing/);
  assert.equal(evaluateExit(p, mark(0.006), cfg, NOW).fraction, 0); // ratio 1.2 > 2*0.5, holds
});
test('liquidity death beats everything', () => {
  const d = evaluateExit(pos(), mark(0.05, { liqUsd: 1500 }), cfg, NOW); assert.match(d.reason, /liquidity death/);
  assert.match(evaluateExit(pos(), mark(20, { liqUsd: 5000 }), cfg, NOW).reason, /liquidity death/); // $3000 position, pool < 2x position
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30000 }), mark(0.021, { liqUsd: 5000 }), cfg, NOW).fraction, 0);   // small position in the same pool is fine
});
test('momentum failure: underwater with sellers dominating', () => {
  const d = evaluateExit(pos(), mark(0.0192, { buysM5: 5, sellsM5: 20 }), cfg, NOW); assert.match(d.reason, /momentum/);
  assert.equal(evaluateExit(pos({ entryTs: NOW - 60000 }), mark(0.0192, { buysM5: 5, sellsM5: 20 }), cfg, NOW).fraction, 0); // too early to judge
});
test('time stop and max hold', () => {
  assert.match(evaluateExit(pos({ entryTs: NOW - 30 * 60000 }), mark(0.0205), cfg, NOW).reason, /time stop/);
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30 * 60000 }), mark(0.026), cfg, NOW).fraction, 0);   // working → keep
  assert.match(evaluateExit(pos({ entryTs: NOW - 130 * 60000, peakRatio: 1.3 }), mark(0.026), cfg, NOW).reason, /max hold/);
});

// ---- dip stop + stall exit (price move measured net of the entry round-trip cost) ----
const S = 1000;
test('dip stop: sells at -5% price even with two-sided volume (old stop-loss would skip it)', () => {
  const d = evaluateExit(pos(), mark(0.011), cfg, NOW); assert.equal(d.fraction, 1); assert.match(d.reason, /dip stop/);
  assert.match(evaluateExit(pos(), mark(0.0189), cfg, NOW).reason, /dip stop/);                 // -5.5%
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0192), cfg, NOW).fraction, 0);      // -4%, holds (stall not due yet)
});
test('dip stop ignores the round-trip cost already paid at entry', () => {
  // round-trip 0.90: a flat coin reads 0.018 on 0.02 spent — that is NOT a 10% dip
  const p = pos({ entryRoundTrip: 0.9, entryTs: NOW - 30 * S });
  assert.equal(evaluateExit(p, mark(0.018), cfg, NOW).fraction, 0);
  assert.match(evaluateExit(p, mark(0.0170), cfg, NOW).reason, /dip stop/);                   // price -5.6%
});
// ---- entry stall (user 2026-10-13, endpoint version): at 60s, price inside ±5% of entry = sell ----
const stallCfg = { ...cfg, stallSec: 60, stallBandPct: 0.05, dipStopPct: 0 };
test('entry stall: inside the range at the deadline sells; before it, holds', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 59 * S }), mark(0.0201), stallCfg, NOW).fraction, 0);
  const d = evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0201), stallCfg, NOW);
  assert.equal(d.fraction, 1); assert.match(d.reason, /stall \(in entry range/);
  assert.match(evaluateExit(pos({ entryTs: NOW - 90 * S }), mark(0.0196), stallCfg, NOW).reason, /stall/); // under entry but inside the range sells too
});
test('entry stall: endpoint judges where the price IS, not where it has been', () => {
  const faded = pos({ entryTs: NOW - 300 * S, peakMove: 1.30 });  // spiked +30% in its first minute, faded back to +1%
  assert.match(evaluateExit(faded, mark(0.0202), stallCfg, NOW).reason, /stall/);
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S, peakMove: 1.12, peakRatio: 1.12 }), mark(0.0216), stallCfg, NOW).fraction, 0); // +8% at the check: still out of the range, holds (peak kept under the profit-lock arm on purpose)
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S }), mark(0.0184), stallCfg, NOW).fraction, 0);                  // -8%: through the band — the stop's territory, not the stall's
  // post-TP1 runners are exempt from the stall (in practice the trail/profit lock reach them first,
  // so isolate the exemption with the lock off): in-range at the deadline, still holds
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S, tp1Done: true, remainingFrac: 0.35, peakRatio: 1.4 }), mark(0.0074), { ...stallCfg, lockKeep: 0 }, NOW).fraction, 0);
});

// ---- grace stop (user 2026-10-13): arm -10%, 5s grace, flow confirms, floor -20% ----
const stopCfg = { ...cfg, stopLoss: 0.10, stopHardPct: 0.20, stopGraceSec: 5, stopFlowVeto: 1, dipStopPct: 0 };
test('grace stop: breaching the arm line starts the window instead of selling', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0178), stopCfg, NOW);   // ratio 0.89
  assert.equal(d.fraction, 0); assert.equal(d.stopArmedTs, NOW);
});
test('grace stop: still down after the grace with dead flow sells, confirmed', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S, stopArmedTs: NOW - 5 * S }), mark(0.0178, { buysM5: 1, sellsM5: 9 }), stopCfg, NOW);
  assert.equal(d.fraction, 1); assert.match(d.reason, /stop-loss .*confirmed/);
  const d2 = evaluateExit(pos({ entryTs: NOW - 30 * S, stopArmedTs: NOW - 6 * S }), mark(0.0178, { buysM5: 20, sellsM5: 25 }), stopCfg, NOW);
  assert.equal(d2.fraction, 1); // sells outweighing buys confirms too
});
test('grace stop: buyers absorbing the dip vetoes the sell and disarms', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S, stopArmedTs: NOW - 5 * S }), mark(0.0178, { buysM5: 30, sellsM5: 10 }), stopCfg, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.stopArmedTs, null);
});
test('grace stop: recovery above the arm line cancels the arming', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S, stopArmedTs: NOW - 3 * S }), mark(0.0192), stopCfg, NOW); // ratio 0.96
  assert.equal(d.fraction, 0); assert.equal(d.stopArmedTs, null);
});
test('hard floor needs a confirming check — first breach only arms it', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0158, { buysM5: 40, sellsM5: 2 }), stopCfg, NOW); // ratio 0.79, strong buys
  assert.equal(d.fraction, 0); assert.equal(d.floorChecks, 1); // a wick gets one more look
  const d2 = evaluateExit(pos({ entryTs: NOW - 34 * S, floorChecks: d.floorChecks }), mark(0.0156, { buysM5: 40, sellsM5: 2 }), stopCfg, NOW); // still under the floor next check
  assert.equal(d2.fraction, 1); assert.match(d2.reason, /hard floor/); // confirmed: no veto even with strong buys
});
test('hard floor: a wick that snaps back above the floor never fires', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0158), stopCfg, NOW); // ratio 0.79 breach
  assert.equal(d.floorChecks, 1);
  const d2 = evaluateExit(pos({ entryTs: NOW - 34 * S, floorChecks: d.floorChecks }), mark(0.0170), stopCfg, NOW); // ratio 0.85: above floor, still in grace zone
  assert.equal(d2.fraction, 0); assert.equal(d2.floorChecks, 0); // disarmed; grace governs from here
});
test('hard floor: STOP_HARD_CONFIRM_CHECKS=1 restores the old instant sell', () => {
  const instant = { ...stopCfg, stopHardConfirmChecks: 1 };
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0158), instant, NOW);
  assert.equal(d.fraction, 1); assert.match(d.reason, /hard floor/);
});
test('hard floor: 3s persistence — the breach must still be there 3s later', () => {
  const timed = { ...stopCfg, stopHardConfirmChecks: 1, stopHardConfirmSec: 3 };
  const t0 = NOW;
  const d = evaluateExit(pos({ entryTs: t0 - 30 * S }), mark(0.0158), timed, t0); // breach lands
  assert.equal(d.fraction, 0); assert.equal(d.floorSince, t0); // clock started, no sell yet
  const d2 = evaluateExit(pos({ entryTs: t0 - 30 * S, floorChecks: d.floorChecks, floorSince: d.floorSince }), mark(0.0156), timed, t0 + 2 * S); // +2s: still under, not long enough
  assert.equal(d2.fraction, 0);
  const d3 = evaluateExit(pos({ entryTs: t0 - 30 * S, floorChecks: d2.floorChecks, floorSince: d2.floorSince }), mark(0.0156), timed, t0 + 3.5 * S); // +3.5s: still there
  assert.equal(d3.fraction, 1); assert.match(d3.reason, /hard floor/); assert.match(d3.reason, /confirmed 3s under|confirmed 4s under/);
});
test('hard floor: recovery inside the 3s window resets the clock', () => {
  const timed = { ...stopCfg, stopHardConfirmChecks: 1, stopHardConfirmSec: 3 };
  const t0 = NOW;
  const d = evaluateExit(pos({ entryTs: t0 - 30 * S }), mark(0.0158), timed, t0);
  const d2 = evaluateExit(pos({ entryTs: t0 - 30 * S, floorChecks: d.floorChecks, floorSince: d.floorSince }), mark(0.0170), timed, t0 + 2 * S); // ratio 0.85: back above the floor
  assert.equal(d2.fraction, 0); assert.equal(d2.floorSince, null); assert.equal(d2.floorChecks, 0);
  const d3 = evaluateExit(pos({ entryTs: t0 - 30 * S, floorChecks: d2.floorChecks, floorSince: d2.floorSince }), mark(0.0158), timed, t0 + 4 * S); // a fresh breach starts a NEW clock
  assert.equal(d3.fraction, 0); assert.equal(d3.floorSince, t0 + 4 * S);
});
test('stall and dip stop can be turned off', () => {
  const off = { ...cfg, stallSec: 0, dipStopPct: 0 };
  assert.equal(evaluateExit(pos({ entryTs: NOW - 600 * S, peakMove: 1 }), mark(0.0201), off, NOW).fraction, 0);
  assert.equal(evaluateExit(pos(), mark(0.0189), off, NOW).fraction, 0);
});

// ---- take profit on the jump + profit lock ----
test('TP1: price +25% banks 65% (adaptive ceiling pinned at the arm = instant bank)', () => {
  const fixed = { ...cfg, tp1AdaptMax: cfg.tp1Pct };
  const d = evaluateExit(pos({ stallSince: NOW }), mark(0.0264), fixed, NOW);   // +32% minus ~1.6% fees (0.02 SOL test size)
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true);
  assert.equal(evaluateExit(pos({ stallSince: NOW }), mark(0.0240), fixed, NOW).fraction, 0);       // +20%: not yet
});
test('TP1 judged on what you pocket: chart +31% with 10% round-trip cost is not +25% profit', () => {
  const fixed = { ...cfg, tp1AdaptMax: cfg.tp1Pct };
  const p = pos({ entryRoundTrip: 0.9, stallSince: NOW });   // flat = 0.018 value
  assert.equal(evaluateExit(p, mark(0.0236), fixed, NOW).fraction, 0);    // price +31% but only +18% realizable
  assert.equal(evaluateExit(p, mark(0.0264), fixed, NOW).fraction, 0.65);  // +32% realizable minus fees ≥ +25%
});
test('post-TP1 trail: 25% below peak or back to entry sells the rest', () => {
  const noTp2 = { ...cfg, tp2Pct: 99 };   // isolate the middle stage: TP2 off
  const p = pos({ tp1Done: true, remainingFrac: 0.35, peakRatio: 1.6, stallSince: NOW });
  assert.equal(evaluateExit(p, mark(0.02 * 0.35 * 1.2), noTp2, NOW).fraction, 1);  // 1.2x = 25% off 1.6x peak → trail fires
  assert.equal(evaluateExit(p, mark(0.02 * 0.35 * 1.0), noTp2, NOW).fraction, 1);  // back to entry → floor fires
  const big = pos({ tp1Done: true, remainingFrac: 0.35, peakRatio: 3, stallSince: NOW });
  assert.equal(evaluateExit(big, mark(0.02 * 0.35 * 2.4), noTp2, NOW).fraction, 0);  // 2.4x vs 3x peak: holds
  assert.match(evaluateExit(big, mark(0.02 * 0.35 * 2.1), noTp2, NOW).reason, /post-TP1 trail/);  // 2.1x ≤ 2.25x trail, above lock
});
test('fees: SOL tx fees are taken out before calling it a take-profit', () => {
  const pricey = { ...cfg, txFeeSol: 0.0005, tp1AdaptMax: cfg.tp1Pct };  // 3 tx × 0.0005 = 0.0015 on 0.02 basis = 7.5%
  assert.equal(evaluateExit(pos({ stallSince: NOW }), mark(0.0262), pricey, NOW).fraction, 0);   // +31% - 7.5% < 25%
  assert.equal(evaluateExit(pos({ stallSince: NOW }), mark(0.0277), pricey, NOW).fraction, 0.65); // +38.5% - 7.5% ≥ 25%
});
test('profit lock: gives back half of the best gain → sell the rest', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.5, peakRatio: 1.4, stallSince: null });  // peak +40%
  assert.equal(evaluateExit(p, mark(0.0125), cfg, NOW).fraction, 0);                         // +25%: holds
  const d = evaluateExit(p, mark(0.0119), cfg, NOW);                                         // +19%: sell
  assert.equal(d.fraction, 1); assert.match(d.reason, /profit lock/);
});
test('profit lock not armed below +15% peak', () => {
  assert.equal(evaluateExit(pos({ peakRatio: 1.12, entryTs: NOW - 30 * S }), mark(0.0205), cfg, NOW).fraction, 0);
});
test('a big runner keeps running until it gives back a quarter (post-TP1 trail)', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.5, peakRatio: 3, stallSince: null });      // peak +200%
  assert.equal(evaluateExit(p, mark(0.0240), { ...cfg, trailPct: 0.9, tp2Pct: 99 }, NOW).fraction, 0);   // 2.4x: holds
  assert.match(evaluateExit(p, mark(0.0195), { ...cfg, trailPct: 0.9, tp2Pct: 99 }, NOW).reason, /post-TP1 trail/); // 1.95x ≤ 2.25x
});

// ---- TP ladder (user 2026-10-13): adaptive TP1, TP2 at +100%, moonbag ----
test('adaptive TP1: strong run rides past the arm without banking', () => {
  const d = evaluateExit(pos({ stallSince: NOW }), mark(0.0264), cfg, NOW);   // +30% net, fresh peak, flow 30b/10s
  assert.equal(d.fraction, 0); assert.ok(d.tp1Arm);                            // armed, not fired
});
test('adaptive TP1: ceiling banks the slice', () => {
  const d = evaluateExit(pos({ stallSince: NOW }), mark(0.0330), cfg, NOW);   // +63% net ≥ +60% ceiling
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true); assert.match(d.reason, /ceiling/);
});
test('adaptive TP1: rollover from the peak banks it', () => {
  const p = pos({ tp1Arm: { ts: NOW - 8000, share: 0.6 }, peakRatio: 1.5, stallSince: NOW });
  const d = evaluateExit(p, mark(0.0272), cfg, NOW);                          // ratio 1.36: ~14 gain pts off the peak
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true); assert.match(d.reason, /rollover/);
});
test('adaptive TP1: weak flow at the arm banks immediately at the arm level', () => {
  const d = evaluateExit(pos({ stallSince: NOW }), mark(0.0264, { buysM5: 5, sellsM5: 30 }), cfg, NOW);  // share 0.14
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true); assert.match(d.reason, /strength faded/);
});
test('TP2: at +100% net it sells tp2Frac of the ORIGINAL position', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 2.2, stallSince: NOW });
  const d = evaluateExit(p, mark(0.02 * 0.6 * 2.1), cfg, NOW);                // ratio 2.1 on the remaining basis
  assert.equal(d.tp2, true); assert.ok(Math.abs(d.fraction - 0.35 / 0.6) < 1e-9);
});
test('moonbag: post-TP2 remainder rides a 15% trail under its recorded peak, immune to lock and the generic trailing stop', () => {
  const p = pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.25, peakRatio: 2.8, stallSince: NOW });
  assert.equal(evaluateExit(p, mark(0.02 * 0.25 * 2.42), cfg, NOW).fraction, 0);   // 2.42x: 13.6% off peak — bag holds
  const d = evaluateExit(p, mark(0.02 * 0.25 * 2.35), cfg, NOW);                    // 2.35x: 16.1% off peak — past the -15% line
  assert.equal(d.fraction, 1); assert.match(d.reason, /moonbag trail/);
});
