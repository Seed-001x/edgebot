import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

// probation leash OFF in the shared fixture: the section tests below isolate their own rule on
// the pre-leash paths; the leash itself is covered by its own block (probCfg) further down.
const cfg = testCfg({ stallProbationSec: 0 }); const NOW = 1_000_000_000_000;
const pos = (o = {}) => ({ entrySol: 0.02, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 5 * 60000, ...o });
const mark = (valueSol, o = {}) => ({ valueSol, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });

test('holds in the quiet middle', () => assert.equal(evaluateExit(pos({ entryTs: NOW - 30000 }), mark(0.021), cfg, NOW).fraction, 0));
test('stop-loss on realizable value (backstop when dip stop is off)', () => { const c = { ...cfg, dipStopPct: 0 }; const d1 = evaluateExit(pos(), mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW); assert.equal(d1.fraction, 0); assert.equal(d1.floorChecks, 1); const d = evaluateExit(pos({ floorChecks: d1.floorChecks }), mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW); assert.equal(d.fraction, 1); assert.match(d.reason, /stop-loss/); });
test('liquidity death beats everything', () => {
  const d = evaluateExit(pos(), mark(0.05, { liqUsd: 1500 }), cfg, NOW); assert.match(d.reason, /liquidity death/);
  assert.match(evaluateExit(pos(), mark(20, { liqUsd: 5000 }), cfg, NOW).reason, /liquidity death/); // $3000 position, pool < 2x position
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30000 }), mark(0.021, { liqUsd: 5000 }), cfg, NOW).fraction, 0);   // small position in the same pool is fine
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
// ---- entry stall (user 2026-10-13, endpoint version): at 60s, price inside the entry range = sell
//      (range asymmetric since 2026-10-14: −5% / +3% — see the stallBandUpPct test below) ----
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
// ---- entry stall upside tightened to +3% (user 2026-10-14): −5% / +3% band; UNTXED sold at +2.2% then ripped ----
const stallUpCfg = { ...cfg, stallSec: 60, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
test('entry stall: upside edge is +3% — +2.2% still sells, +4% holds, downside unchanged', () => {
  const untxed = evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.02044), stallUpCfg, NOW);   // move 1.022 — the UNTXED print
  assert.equal(untxed.fraction, 1); assert.equal(untxed.reason, 'stall (in entry range at 60s, 2.2%)');
  assert.equal(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0208), stallUpCfg, NOW).fraction, 0); // move 1.04: outside the +3% upside, holds
  // ...whereas the old symmetric +5% band would have sold that same +4% print
  assert.match(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0208), { ...stallUpCfg, stallBandUpPct: 0.05 }, NOW).reason, /stall/);
  assert.match(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0192), stallUpCfg, NOW).reason, /stall/); // move 0.96: downside −5% unchanged, inside sells
  assert.equal(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0188), stallUpCfg, NOW).fraction, 0);    // move 0.94: through the downside band — not the stall's
});

// ---- probation leash (user 2026-10-14, Musclecat): at the 180s deadline inside the band the
//      position is NOT sold — it goes on probation: −7% leash, breakout clears, 300s-from-entry
//      expiry. Live-shaped cfg: stallSec 180, probation 300, leash 0.07, band −5% / +3%. ----
const probCfg = { ...cfg, stallSec: 180, stallProbationSec: 300, stallLeashPct: 0.07, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
test('probation: at the stall deadline inside the band it holds and enters probation (no sell)', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 180 * S }), mark(0.0201), probCfg, NOW);   // move 1.005
  assert.equal(d.fraction, 0); assert.equal(d.probationSince, NOW);
});
test('probation: before the deadline inside the band — no exit, no probation', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 120 * S }), mark(0.0201), probCfg, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.probationSince, null);
});
test('probation leash: on probation, a dive past −7% sells instantly; −6% still holds', () => {
  const p = { entryTs: NOW - 200 * S, probationSince: NOW - 20 * S };
  const d = evaluateExit(pos(p), mark(0.0185), probCfg, NOW);                            // move 0.925
  assert.equal(d.fraction, 1); assert.equal(d.reason, 'probation leash (-7.5% after stall deadline)');
  const d2 = evaluateExit(pos(p), mark(0.0188), probCfg, NOW);                           // move 0.94: above the leash, before expiry
  assert.equal(d2.fraction, 0); assert.equal(d2.probationSince, NOW - 20 * S);
});
test('probation expiry: still in the band at 300s from entry sells', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 300 * S, probationSince: NOW - 120 * S }), mark(0.0201), probCfg, NOW);
  assert.equal(d.fraction, 1); assert.equal(d.reason, 'probation expired (still in entry range at 300s, 0.5%)');
});
test('probation breakout: above the +3% band top clears probation, no exit', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 240 * S, probationSince: NOW - 60 * S }), mark(0.0208), probCfg, NOW); // move 1.04
  assert.equal(d.fraction, 0); assert.equal(d.probationSince, null);
});
test('probation anchors to ENTRY: first entering the band at 240s enters probation; expiry still lands at 300s from entry', () => {
  const d1 = evaluateExit(pos({ entryTs: NOW - 240 * S }), mark(0.0201), probCfg, NOW);  // deadline long past, band entered late
  assert.equal(d1.fraction, 0); assert.equal(d1.probationSince, NOW);
  const d2 = evaluateExit(pos({ entryTs: NOW - 300 * S, probationSince: d1.probationSince }), mark(0.0201), probCfg, NOW); // only 60s of probation served — but 300s from entry
  assert.equal(d2.fraction, 1); assert.match(d2.reason, /probation expired/);
});
test('probation off (STALL_PROBATION_SEC=0): the old stall sell at the deadline fires exactly as before', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 180 * S }), mark(0.0201), { ...probCfg, stallProbationSec: 0 }, NOW);
  assert.equal(d.fraction, 1); assert.equal(d.reason, 'stall (in entry range at 180s, 0.5%)');
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
  const noTp2 = { ...cfg, tp2Pct: 99, tp2RejectZone: 0 };   // isolate the middle stage: TP2 + rejection off
  const p = pos({ tp1Done: true, remainingFrac: 0.35, peakRatio: 1.6, stallSince: NOW });
  assert.equal(evaluateExit(p, mark(0.02 * 0.35 * 1.2), noTp2, NOW).fraction, 1);  // 1.2x = 25% off 1.6x peak → trail fires
  assert.equal(evaluateExit(p, mark(0.02 * 0.35 * 1.0), noTp2, NOW).fraction, 1);  // back to entry → floor fires
  const big = pos({ tp1Done: true, remainingFrac: 0.35, peakRatio: 3, stallSince: NOW });
  assert.equal(evaluateExit(big, mark(0.02 * 0.35 * 2.4), noTp2, NOW).fraction, 0);  // 2.4x vs 3x peak: holds
  assert.match(evaluateExit(big, mark(0.02 * 0.35 * 2.1), noTp2, NOW).reason, /post-TP1 trail/);  // 2.1x ≤ 2.25x trail, above lock
});
test('TP2 rejection: peaked in the zone, 10% off the peak without converting sells the rest', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.85, stallSince: NOW });   // wizardcat shape: peak +85%
  const d = evaluateExit(p, mark(0.02 * 0.6 * 1.6465), cfg, NOW);                            // 11% off the peak
  assert.equal(d.fraction, 1); assert.match(d.reason, /TP2 rejection/);
  assert.equal(evaluateExit(p, mark(0.02 * 0.6 * 1.7205), cfg, NOW).fraction, 0);            // only 7% off: still riding
});
test('TP2 rejection: a peak below the zone is just a pullback — the wide trail governs', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.6, stallSince: NOW });      // peak +60% < +80% zone
  assert.equal(evaluateExit(p, mark(0.02 * 0.6 * 1.36), cfg, NOW).fraction, 0);              // 15% off peak: holds
});
test('TP2 rejection: zone 0 disables the rule', () => {
  const off = { ...cfg, tp2RejectZone: 0 };
  const p = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.85, stallSince: NOW });
  assert.equal(evaluateExit(p, mark(0.02 * 0.6 * 1.6465), off, NOW).fraction, 0);
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
  assert.equal(evaluateExit(p, mark(0.0240), { ...cfg, trailPct: 0.9, tp2Pct: 99, tp2RejectZone: 0 }, NOW).fraction, 0);   // 2.4x: holds
  assert.match(evaluateExit(p, mark(0.0195), { ...cfg, trailPct: 0.9, tp2Pct: 99, tp2RejectZone: 0 }, NOW).reason, /post-TP1 trail/); // 1.95x ≤ 2.25x
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

// ---- break-even ratchet (user 2026-10-14, "Build it — arm at +5%"): a pre-TP1 position whose
//      peak realizable move reached +5% can no longer become a loser — a fall back to +2%
//      sells it in full at ~scratch. Judged on move/peakMove (round-trip-adjusted), never the
//      chart. beCfg isolates the ratchet: dip stop off, probation off (shared cfg), young ages
//      keep the stall/momentum/time sections out of the way except where a test says so. ----
const beCfg = { ...cfg, dipStopPct: 0 };
test('break-even ratchet: peaked +12.4%, back at the +2% trigger — sells in full, reason names both prints', () => {
  // round-trip 0.95: the +1.8% is a MOVE print (ratio 0.9671 under water on raw value) —
  // the ratchet judges the price path, not the sunk round-trip cost, and fires at 30s old,
  // long before any stall deadline (the DOG shape: peaked +22%, dead inside a minute).
  const p = pos({ entryTs: NOW - 30 * S, entryRoundTrip: 0.95, peakRatio: 1.068, peakMove: 1.124 });
  const d = evaluateExit(p, mark(0.019342), beCfg, NOW);   // move = 0.9671 / 0.95 = 1.018
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'break-even ratchet (peaked +12.4%, back to +1.8%)');
});
test('break-even ratchet: arms at exactly +5% peak, fires at exactly +2%', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.05 }), mark(0.0204), beCfg, NOW); // move 1.02
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'break-even ratchet (peaked +5.0%, back to +2.0%)');
});
test('break-even ratchet: peak only +4% never arms — +2% and below still hold, other exits keep it', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.04 });
  assert.equal(evaluateExit(p, mark(0.0204), beCfg, NOW).fraction, 0);  // back at +2%: no arm, no fire
  assert.equal(evaluateExit(p, mark(0.0194), beCfg, NOW).fraction, 0);  // through break-even to -3%: still not the ratchet's
});
test('break-even ratchet: armed, dips only to +3% — no fire', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.12 }), mark(0.0206), beCfg, NOW).fraction, 0); // move 1.03
});
test('break-even ratchet: armed and still rising — untouched', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.12 }), mark(0.024), beCfg, NOW).fraction, 0); // move 1.20, under the TP1 arm
});
test('break-even ratchet: TP1 done — never fires even at +2%, the ladder owns the remainder', () => {
  const p = pos({ entryTs: NOW - 30 * S, tp1Done: true, remainingFrac: 0.6, peakRatio: 1.30, peakMove: 1.30 });
  const d = evaluateExit(p, mark(0.02 * 0.6 * 1.02), { ...beCfg, lockKeep: 0 }, NOW); // ratio 1.02 on the remaining basis
  assert.equal(d.fraction, 0);
});
test('break-even ratchet: BE_ARM_PCT=0 disables it entirely', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.124 });
  assert.equal(evaluateExit(p, mark(0.02036), { ...beCfg, beArmPct: 0 }, NOW).fraction, 0); // move 1.018, would fire if on
});
test('break-even ratchet vs probation: deadline check starts probation first; on probation the +2% fade scratches here, the deep dive keeps the leash label', () => {
  const probBeCfg = { ...cfg, stallSec: 180, stallProbationSec: 300, stallLeashPct: 0.07, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
  // deadline check, in band at +0.5%: probation starts — the stall section returns first, ratchet defers to the next check
  const start = evaluateExit(pos({ entryTs: NOW - 180 * S, peakMove: 1.10 }), mark(0.0201), probBeCfg, NOW);
  assert.equal(start.fraction, 0); assert.equal(start.probationSince, NOW);
  // on probation, faded to +1.8% (inside the band, leash/expiry unmet): the ratchet scratches it
  const faded = evaluateExit(pos({ entryTs: NOW - 204 * S, peakMove: 1.10, probationSince: NOW - 24 * S }), mark(0.02036), probBeCfg, NOW);
  assert.equal(faded.fraction, 1); assert.match(faded.reason, /break-even ratchet/);
  // on probation, deep dive to -8.5%: the leash (judged inside the stall block, before the ratchet) keeps its own label
  const dive = evaluateExit(pos({ entryTs: NOW - 204 * S, peakMove: 1.10, probationSince: NOW - 24 * S }), mark(0.0183), probBeCfg, NOW);
  assert.equal(dive.fraction, 1); assert.match(dive.reason, /probation leash/);
});
test('break-even ratchet: no recorded peakMove (legacy position) never arms — the round-trip seed cannot fake a breakout', () => {
  // round-trip 0.90 with no stored peakMove: the peakRatio seed would read 1/0.9 = +11%,
  // but the ratchet arms only off a peak the position actually tracked — a flat print holds.
  const p = pos({ entryTs: NOW - 30 * S, entryRoundTrip: 0.9 });
  assert.equal(evaluateExit(p, mark(0.018), beCfg, NOW).fraction, 0); // flat: move 1.00
});

// ---- bleed exit (user 2026-10-14, "Still-falling test — down 7%+ and not recovering"): the
//      probation leash freed from the band. Past the prove-itself window (180s), any position
//      down 7%+ on `move` sells in full IF it is still falling — the current move at/below the
//      move ~60s ago on the position's own per-check move history. TAILOOR bled to -52% in
//      ~6 min because it never sat in the band at the deadline and nothing owned it.
//      bleedCfg isolates the exit: dip stop and stall off (shared cfg already has probation
//      off); positions carry no peakMove, so the ratchet cannot arm here. ----
const bleedCfg = { ...cfg, dipStopPct: 0, stallSec: 0 };
const hist = (...prints) => prints.map(([agoSec, move]) => ({ ts: NOW - agoSec * S, move }));
test('bleed exit: 200s old, -9% and lower than the -8% print of a minute ago — fires in full', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([120, 0.95], [60, 0.92], [4, 0.915]) });
  const d = evaluateExit(p, mark(0.0182), bleedCfg, NOW);   // move 0.91
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'bleed exit (-9.0% and still falling)');
  // the current print is appended to the returned history, bounded and threadable by the caller
  assert.equal(d.moveHist.at(-1).move, 0.91);
  assert.ok(d.moveHist.length <= 40);
});
test('bleed exit: down -9% but recovering off the -12% print of a minute ago — no fire', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.88]) });
  assert.equal(evaluateExit(p, mark(0.0182), bleedCfg, NOW).fraction, 0);   // move 0.91 > 0.88: climbing back
});
test('bleed exit: 100s old at -15% and falling — inside the prove-itself window, no fire', () => {
  const p = pos({ entryTs: NOW - 100 * S, moveHist: hist([60, 0.90]) });
  assert.equal(evaluateExit(p, mark(0.017), bleedCfg, NOW).fraction, 0);   // move 0.85, age < 180s
});
test('bleed exit: -5% and falling at 300s — above the -7% line, no fire', () => {
  const p = pos({ entryTs: NOW - 300 * S, moveHist: hist([60, 0.94]) });
  assert.equal(evaluateExit(p, mark(0.019), bleedCfg, NOW).fraction, 0);   // move 0.95
});
test('bleed exit: no lookback reading at least ~45s old — no fire yet (the post-restart shape)', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S, moveHist: [] }), mark(0.018), bleedCfg, NOW).fraction, 0);
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S, moveHist: hist([10, 0.90]) }), mark(0.018), bleedCfg, NOW).fraction, 0);
});
test('bleed exit: BLEED_PCT=0 disables it — the same falling print holds', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]) });
  assert.equal(evaluateExit(p, mark(0.0182), { ...bleedCfg, bleedPct: 0 }, NOW).fraction, 0);
});
test('bleed exit vs probation: a probationed dive keeps the leash label — the leash is judged first, inside 4b', () => {
  const probBleedCfg = { ...cfg, stallSec: 180, stallProbationSec: 300, stallLeashPct: 0.07, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
  const p = pos({ entryTs: NOW - 204 * S, probationSince: NOW - 24 * S, moveHist: hist([60, 0.95]) });
  const d = evaluateExit(p, mark(0.0183), probBleedCfg, NOW);   // move 0.915: bleed conditions also met, leash wins the label
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /probation leash/);
});

// ---- fail-safe confirmation (user 2026-10-14, "a fail safe to the fail safe"): the three
//      fail-safe exits (break-even ratchet, bleed exit, probation leash) no longer sell on
//      the first triggering check — with EXIT_CONFIRM_SEC > 0 the trigger ARMS a pending
//      ({kind: sinceTs}, persisted on the position as exitPending) and sells only when the
//      exit's FULL condition has held continuously until the first check at/after the
//      window; a recovery inside the window cancels it (decision.exitConfirmEvents carries
//      the outcome for bot.js to count). Fixtures below carry exitPending: {} — the state
//      bot.js initializes at entry; positions without the field keep the instant behavior
//      the blocks above assert. `run` threads the returned state back onto the position
//      exactly as bot.js does. ----
const run = (p, m, c, now) => {
  const d = evaluateExit(p, m, c, now);
  if ('exitPending' in d) p.exitPending = d.exitPending;
  if ('probationSince' in d) p.probationSince = d.probationSince;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  return d;
};
const confBeCfg = { ...beCfg, exitConfirmSec: 10 };
const confBleedCfg = { ...bleedCfg, exitConfirmSec: 10 };
const confProbCfg = { ...probCfg, exitConfirmSec: 10 };

test('exit confirmation config: EXIT_CONFIRM_SEC defaults to 10 and validates; 0 is a designed off value; negatives rejected', () => {
  const c = loadConfig({});
  assert.equal(c.exitConfirmSec, 10);
  assert.equal(validateConfig(c).length, 0);
  assert.equal(loadConfig({ EXIT_CONFIRM_SEC: '0' }).exitConfirmSec, 0);
  assert.equal(validateConfig(loadConfig({ EXIT_CONFIRM_SEC: '0' })).length, 0);
  assert.ok(validateConfig(loadConfig({ EXIT_CONFIRM_SEC: '-1' })).some(e => e.includes('EXIT_CONFIRM_SEC')));
});

// ---- ratchet ----
test('ratchet confirmation: trigger arms a pending; a recovery above the trigger inside the window cancels it', () => {
  const p = pos({ entryTs: NOW - 30 * S, entryRoundTrip: 0.95, peakRatio: 1.068, peakMove: 1.124, exitPending: {} });
  const d1 = run(p, mark(0.019342), confBeCfg, NOW);                    // move 1.018 — the old instant trigger
  assert.equal(d1.fraction, 0);                                          // NOT sold: the window just opened
  assert.equal(p.exitPending.ratchet, NOW);
  assert.deepEqual(d1.exitConfirmEvents, []);
  const d2 = run(p, mark(0.01995), confBeCfg, NOW + 4 * S);              // move 1.05: back above the +2% line
  assert.equal(d2.fraction, 0);
  assert.equal(p.exitPending.ratchet, undefined);                        // pending disarmed
  assert.deepEqual(d2.exitConfirmEvents, [{ type: 'cancelled', kind: 'ratchet' }]);
});
test('ratchet confirmation: trigger held continuously sells at the first check at/after 10s — not before', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {} });
  assert.equal(run(p, mark(0.0204), confBeCfg, NOW).fraction, 0);        // trigger: pending opens
  assert.equal(run(p, mark(0.0204), confBeCfg, NOW + 4 * S).fraction, 0);  // 4s in: still holding, no sell
  assert.equal(run(p, mark(0.0204), confBeCfg, NOW + 8 * S).fraction, 0);  // 8s in: still short of the window
  const d = run(p, mark(0.0204), confBeCfg, NOW + 12 * S);               // first check past 10s
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'break-even ratchet (peaked +12.0%, back to +2.0%)');
  assert.deepEqual(d.exitConfirmEvents, [{ type: 'confirmed', kind: 'ratchet' }]);
  assert.deepEqual(p.exitPending, {});
  // a check landing exactly ON the window edge also sells
  const q = pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {} });
  assert.equal(run(q, mark(0.0204), confBeCfg, NOW).fraction, 0);
  assert.equal(run(q, mark(0.0204), confBeCfg, NOW + 10 * S).fraction, 1);
});
test('ratchet confirmation: cancel then re-trigger starts a FRESH full window', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {} });
  run(p, mark(0.0204), confBeCfg, NOW);                                  // trigger #1
  run(p, mark(0.0212), confBeCfg, NOW + 4 * S);                          // recovery: cancelled
  const re = run(p, mark(0.0204), confBeCfg, NOW + 8 * S);               // trigger #2
  assert.equal(re.fraction, 0);
  assert.equal(p.exitPending.ratchet, NOW + 8 * S);                      // stamped at the re-trigger, not the first
  assert.equal(run(p, mark(0.0204), confBeCfg, NOW + 12 * S).fraction, 0); // 12s after trigger #1 but only 4s into window #2: no sell
  assert.equal(run(p, mark(0.0204), confBeCfg, NOW + 20 * S).fraction, 1); // window #2 complete
});

// ---- bleed ----
test('bleed confirmation: trigger arms a pending; a recovery above −7% inside the window cancels it', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([120, 0.95], [60, 0.92], [4, 0.915]), exitPending: {} });
  const d1 = run(p, mark(0.0182), confBleedCfg, NOW);                    // move 0.91, still falling — the old instant fire
  assert.equal(d1.fraction, 0);
  assert.equal(p.exitPending.bleed, NOW);
  const d2 = run(p, mark(0.0192), confBleedCfg, NOW + 4 * S);            // move 0.96: back above the −7% line
  assert.equal(d2.fraction, 0);
  assert.equal(p.exitPending.bleed, undefined);
  assert.deepEqual(d2.exitConfirmEvents, [{ type: 'cancelled', kind: 'bleed' }]);
});
test('bleed confirmation: still falling through the window sells at the first check at/after 10s — not before', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([120, 0.95], [60, 0.92], [4, 0.915]), exitPending: {} });
  assert.equal(run(p, mark(0.0182), confBleedCfg, NOW).fraction, 0);        // 0.91 vs 0.92 a minute ago: pending
  assert.equal(run(p, mark(0.0181), confBleedCfg, NOW + 4 * S).fraction, 0);  // 0.905, still falling, 4s in
  assert.equal(run(p, mark(0.01806), confBleedCfg, NOW + 8 * S).fraction, 0); // 0.903, 8s in
  const d = run(p, mark(0.018), confBleedCfg, NOW + 12 * S);               // 0.90, window complete
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'bleed exit (-10.0% and still falling)');
  assert.deepEqual(d.exitConfirmEvents, [{ type: 'confirmed', kind: 'bleed' }]);
});
test('bleed confirmation: cancel then re-trigger starts a FRESH full window', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([120, 0.95], [60, 0.92], [4, 0.915]), exitPending: {} });
  run(p, mark(0.0182), confBleedCfg, NOW);                                   // trigger #1
  run(p, mark(0.0192), confBleedCfg, NOW + 4 * S);                           // recovery above −7%: cancelled
  const re = run(p, mark(0.0182), confBleedCfg, NOW + 8 * S);               // falling again: trigger #2
  assert.equal(re.fraction, 0);
  assert.equal(p.exitPending.bleed, NOW + 8 * S);
  assert.equal(run(p, mark(0.0181), confBleedCfg, NOW + 16 * S).fraction, 0); // 8s into window #2: no sell
  const d = run(p, mark(0.018), confBleedCfg, NOW + 20 * S);                // window #2 complete
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'bleed exit (-10.0% and still falling)');
});
test('bleed confirmation: price still ≤ −7% but no longer still-falling cancels the pending (the recovering leg)', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: {} });
  const d1 = run(p, mark(0.0182), confBleedCfg, NOW);                    // 0.91 ≤ 0.92 print: falling, pending opens
  assert.equal(d1.fraction, 0);
  assert.equal(p.exitPending.bleed, NOW);
  const d2 = run(p, mark(0.0185), confBleedCfg, NOW + 4 * S);            // 0.925: still past −7%, but ABOVE the 0.92 lookback — recovering
  assert.equal(d2.fraction, 0);
  assert.equal(p.exitPending.bleed, undefined);
  assert.deepEqual(d2.exitConfirmEvents, [{ type: 'cancelled', kind: 'bleed' }]);
});

// ---- probation leash ----
test('leash confirmation: trigger arms a pending; a recovery above the leash line cancels it, probation intact', () => {
  const p = pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} });
  const d1 = run(p, mark(0.0185), confProbCfg, NOW);                     // move 0.925 — the old instant leash fire
  assert.equal(d1.fraction, 0);
  assert.equal(p.exitPending.leash, NOW);
  const d2 = run(p, mark(0.0188), confProbCfg, NOW + 4 * S);             // move 0.94: above the leash, in band, before expiry
  assert.equal(d2.fraction, 0);
  assert.equal(p.exitPending.leash, undefined);
  assert.equal(p.probationSince, NOW - 20 * S);                          // still on probation — only the sell was disarmed
  assert.deepEqual(d2.exitConfirmEvents, [{ type: 'cancelled', kind: 'leash' }]);
});
test('leash confirmation: dive held through the window sells at the first check at/after 10s — not before', () => {
  const p = pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} });
  assert.equal(run(p, mark(0.0185), confProbCfg, NOW).fraction, 0);
  assert.equal(run(p, mark(0.0185), confProbCfg, NOW + 4 * S).fraction, 0);
  assert.equal(run(p, mark(0.0185), confProbCfg, NOW + 8 * S).fraction, 0);
  const d = run(p, mark(0.0185), confProbCfg, NOW + 12 * S);
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'probation leash (-7.5% after stall deadline)');
  assert.deepEqual(d.exitConfirmEvents, [{ type: 'confirmed', kind: 'leash' }]);
});
test('leash confirmation: cancel then re-trigger starts a FRESH full window', () => {
  const p = pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} });
  run(p, mark(0.0185), confProbCfg, NOW);                                // trigger #1
  run(p, mark(0.0188), confProbCfg, NOW + 4 * S);                        // recovery: cancelled
  const re = run(p, mark(0.0185), confProbCfg, NOW + 8 * S);             // dive again: trigger #2
  assert.equal(re.fraction, 0);
  assert.equal(p.exitPending.leash, NOW + 8 * S);
  assert.equal(run(p, mark(0.0185), confProbCfg, NOW + 16 * S).fraction, 0); // 8s into window #2: no sell
  const d = run(p, mark(0.0185), confProbCfg, NOW + 20 * S);
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'probation leash (-7.5% after stall deadline)');
});

// ---- EXIT_CONFIRM_SEC=0: the layer is off, wired positions sell on the trigger check ----
test('exit confirmation OFF (EXIT_CONFIRM_SEC=0): all three fail-safes sell instantly, exactly as before the layer', () => {
  const r = evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {} }), mark(0.0204), { ...confBeCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(r.fraction, 1); assert.match(r.reason, /break-even ratchet/); assert.deepEqual(r.exitPending, {});
  const b = evaluateExit(pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: {} }), mark(0.0182), { ...confBleedCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(b.fraction, 1); assert.equal(b.reason, 'bleed exit (-9.0% and still falling)');
  const l = evaluateExit(pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} }), mark(0.0185), { ...confProbCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(l.fraction, 1); assert.equal(l.reason, 'probation leash (-7.5% after stall deadline)');
});

// ---- interplay: a pending fail-safe never blocks the rest of the stack ----
test('exit confirmation: a TP1 decision during a ratchet pending executes immediately; the pending survives the partial sell', () => {
  const tpCfg = { ...cfg, dipStopPct: 0, exitConfirmSec: 10, tp1Pct: 0.20, tp1Frac: 0.4, tp1AdaptMax: 0.60, tp1Giveback: 0.08, lockKeep: 0 };
  const p = pos({ entryTs: NOW - 30 * S, peakRatio: 1.45, peakMove: 1.45, exitPending: {} });
  const d1 = run(p, mark(0.0204), tpCfg, NOW);                           // faded to +2%: ratchet pending opens
  assert.equal(d1.fraction, 0);
  assert.equal(p.exitPending.ratchet, NOW);
  const d2 = run(p, mark(0.026), tpCfg, NOW + 4 * S);                    // rips to 1.30x: TP1 rollover off the 1.45 peak
  assert.equal(d2.tp1, true);
  assert.equal(d2.fraction, 0.4);                                        // banked NOW — the pending did not delay it
  assert.equal(d2.exitPending.ratchet, NOW);                             // ...and the ratchet pending is still ticking on the remainder
  assert.deepEqual(d2.exitConfirmEvents, []);
});

// ---- PROTECT switch (user 2026-10-15, "just the stop loss… no ratchet", "no SL until
//      I say"): a one-time per-position flag (pos.protected, set via POST /protect).
//      While set, ONLY the stop-loss family (2a dip stop, 2a2 hard floor, 2b grace
//      stop) and the break-even ratchet (4c) are skipped — bleed, probation/stall,
//      momentum, trails and the full TP ladder judge as normal. The flag holds for
//      the life of the position; /unprotect (deleting the field) re-arms both exits.
//      The stop's armed state and any ratchet pending are dropped from the returned
//      state while the flag is set; bleed/leash pendings are untouched. ----
const protPos = (o = {}) => pos({ protected: NOW - 60000, ...o });
test('protect: dip stop is skipped and reported, and no stop state accumulates', () => {
  const d = evaluateExit(protPos(), mark(0.011), cfg, NOW);   // move 0.55 — deep in dip-stop / floor / grace territory
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, 'dip stop');
  assert.equal(d.stopArmedTs, null);                          // the grace stop never armed
  assert.equal(d.floorChecks, 0);                             // the hard floor never counted a check
  assert.equal(evaluateExit(pos(), mark(0.011), cfg, NOW).fraction, 1); // control: unprotected sells
  assert.equal(evaluateExit(pos(), mark(0.011), cfg, NOW).protectedBlock, null); // unprotected decisions carry no block
});
test('protect: grace stop is skipped even with the grace long elapsed and flow dead', () => {
  const c = { ...cfg, dipStopPct: 0, stopHardPct: 0 };
  const dead = mark(0.011, { buysM5: 1, sellsM5: 1 });        // ratio 0.55, no buyers to veto
  const d = evaluateExit(protPos({ stopArmedTs: NOW - 10000 }), dead, c, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, 'stop-loss');
  assert.equal(d.stopArmedTs, null);                          // pre-flag arming is cleared, not carried
  const ctl = evaluateExit(pos({ stopArmedTs: NOW - 10000 }), dead, c, NOW); // control: unprotected sells
  assert.equal(ctl.fraction, 1); assert.match(ctl.reason, /stop-loss.*confirmed after 5s grace/);
});
test('protect: hard floor is skipped even with its confirmation already satisfied', () => {
  const c = { ...cfg, dipStopPct: 0 };
  const p = protPos({ floorChecks: 1, floorSince: NOW - 10000 });
  const d = evaluateExit(p, mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, 'stop-loss');
  assert.equal(d.floorChecks, 0); assert.equal(d.floorSince, null);
  const ctl = evaluateExit(pos({ floorChecks: 1, floorSince: NOW - 10000 }), mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW);
  assert.equal(ctl.fraction, 1); assert.match(ctl.reason, /stop-loss/); // control: the second confirmed check sells
});
test('protect: ratchet is skipped even with a matured pending, and the pending is dropped silently', () => {
  const p = protPos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: { ratchet: NOW - 12000 } });
  const d = evaluateExit(p, mark(0.0204), confBeCfg, NOW);    // move 1.02 — the armed ratchet's trigger
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, 'ratchet');
  assert.equal(d.exitPending.ratchet, undefined);             // dropped — it can never execute under the flag
  assert.ok(!d.exitConfirmEvents.some(e => e.kind === 'ratchet')); // and it is NOT counted as a cancelled window
  const ctl = evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: { ratchet: NOW - 12000 } }), mark(0.0204), confBeCfg, NOW);
  assert.equal(ctl.fraction, 1); assert.match(ctl.reason, /break-even ratchet/); // control: matured pending sells
});
test('protect: a bleed pending is left exactly as it was — still armed, still ticking', () => {
  const p = protPos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: { ratchet: NOW - 5000, bleed: NOW - 5000 } });
  const d = evaluateExit(p, mark(0.0182), confBleedCfg, NOW); // move 0.91 and falling: the bleed trigger holds
  assert.equal(d.fraction, 0);                                // 5s into its 10s window: not sold YET — the layer's normal timing
  assert.equal(d.exitPending.bleed, NOW - 5000);              // bleed pending preserved to the tick
  assert.equal(d.exitPending.ratchet, undefined);             // only the ratchet pending was dropped
  assert.deepEqual(d.exitConfirmEvents, []);
  assert.equal(d.protectedBlock, null);                       // nothing was suppressed — the bleed proceeded normally
});
test('protect: bleed exit still fires in full', () => {
  const p = protPos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: {} });
  const d = evaluateExit(p, mark(0.0182), { ...confBleedCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'bleed exit (-9.0% and still falling)');
});
test('protect: probation leash still fires in full', () => {
  const p = protPos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} });
  const d = evaluateExit(p, mark(0.0185), { ...confProbCfg, exitConfirmSec: 0 }, NOW); // move 0.925 — through the −7% leash
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /probation leash/);
});
test('protect: TP1 still banks on schedule', () => {
  const fixed = { ...cfg, tp1AdaptMax: cfg.tp1Pct };
  const d = evaluateExit(protPos({ stallSince: NOW }), mark(0.0264), fixed, NOW);
  assert.equal(d.tp1, true);
  assert.equal(d.fraction, 0.65);
});
test('protect off again (unprotect): the grace stop re-arms fresh and sells after its grace', () => {
  const c = { ...cfg, dipStopPct: 0, stopHardPct: 0 };
  const dead = mark(0.011, { buysM5: 1, sellsM5: 1 });
  const p = protPos({ stopArmedTs: NOW - 10000 });
  const d1 = evaluateExit(p, dead, c, NOW);
  assert.equal(d1.fraction, 0); assert.equal(d1.stopArmedTs, null); // protection cleared the stale arming
  delete p.protected;                                              // POST /unprotect
  p.stopArmedTs = d1.stopArmedTs;                                  // bot.js threads the returned state back
  const d2 = evaluateExit(p, dead, c, NOW);
  assert.equal(d2.fraction, 0); assert.equal(d2.stopArmedTs, NOW); // re-armed fresh — no instant sell off the old arming
  p.stopArmedTs = d2.stopArmedTs;
  const d3 = evaluateExit(p, dead, c, NOW + 6 * S);
  assert.equal(d3.fraction, 1); assert.match(d3.reason, /stop-loss.*grace/);
});
test('protect off again (unprotect): the ratchet re-arms and sells through its window', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {}, protected: NOW - 60000 });
  const d1 = run(p, mark(0.0204), confBeCfg, NOW);
  assert.equal(d1.fraction, 0); assert.equal(d1.protectedBlock, 'ratchet');
  assert.deepEqual(p.exitPending, {});                             // no pending could arm under the flag
  delete p.protected;                                              // POST /unprotect
  const d2 = run(p, mark(0.0204), confBeCfg, NOW + 2 * S);
  assert.equal(d2.fraction, 0); assert.equal(p.exitPending.ratchet, NOW + 2 * S); // fresh window opens
  const d3 = run(p, mark(0.0204), confBeCfg, NOW + 13 * S);
  assert.equal(d3.fraction, 1); assert.match(d3.reason, /break-even ratchet/);
});
