import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { testCfg } from './helpers.mjs';

const cfg = testCfg(); const NOW = 1_000_000_000_000;
const pos = (o = {}) => ({ entrySol: 0.02, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 5 * 60000, ...o });
const mark = (valueSol, o = {}) => ({ valueSol, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });

test('holds in the quiet middle', () => assert.equal(evaluateExit(pos(), mark(0.021), cfg, NOW).fraction, 0));
test('stop-loss on realizable value (backstop when dip stop is off)', () => { const d = evaluateExit(pos(), mark(0.011, { buysM5: 1, sellsM5: 1 }), { ...cfg, dipStopPct: 0 }, NOW); assert.equal(d.fraction, 1); assert.match(d.reason, /stop-loss/); });
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
  assert.equal(evaluateExit(pos(), mark(0.021, { liqUsd: 5000 }), cfg, NOW).fraction, 0);   // small position in the same pool is fine
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
  assert.equal(evaluateExit(pos({ stallSince: NOW }), mark(0.0192), cfg, NOW).fraction, 0);      // -4%, holds
});
test('dip stop ignores the round-trip cost already paid at entry', () => {
  // round-trip 0.90: a flat coin reads 0.018 on 0.02 spent — that is NOT a 10% dip
  const p = pos({ entryRoundTrip: 0.9, stallSince: NOW });
  assert.equal(evaluateExit(p, mark(0.018), cfg, NOW).fraction, 0);
  assert.match(evaluateExit(p, mark(0.0170), cfg, NOW).reason, /dip stop/);                   // price -5.6%
});
test('stall: flat near entry for 60s sells; under 60s holds', () => {
  assert.equal(evaluateExit(pos({ stallSince: NOW - 59 * S }), mark(0.0201), cfg, NOW).fraction, 0);
  const d = evaluateExit(pos({ stallSince: NOW - 60 * S }), mark(0.0201), cfg, NOW);
  assert.equal(d.fraction, 1); assert.match(d.reason, /stall/);
  assert.match(evaluateExit(pos({ stallSince: NOW - 60 * S }), mark(0.0196), cfg, NOW).reason, /stall/); // drifting under entry counts
});
test('stall clock starts, keeps running, and resets when price climbs out', () => {
  assert.equal(evaluateExit(pos(), mark(0.0201), cfg, NOW).stallSince, NOW);                       // starts now if unset
  assert.equal(evaluateExit(pos({ stallSince: NOW - 30 * S }), mark(0.0201), cfg, NOW).stallSince, NOW - 30 * S);
  const up = evaluateExit(pos({ stallSince: NOW - 90 * S }), mark(0.0206), cfg, NOW);             // +3% → running
  assert.equal(up.fraction, 0); assert.equal(up.stallSince, null);
});
test('stall and dip stop can be turned off', () => {
  const off = { ...cfg, stallSec: 0, dipStopPct: 0 };
  assert.equal(evaluateExit(pos({ stallSince: NOW - 600 * S }), mark(0.0201), off, NOW).fraction, 0);
  assert.equal(evaluateExit(pos(), mark(0.0189), off, NOW).fraction, 0);
});
