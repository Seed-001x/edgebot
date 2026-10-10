import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { testCfg } from './helpers.mjs';

const cfg = testCfg(); const NOW = 1_000_000_000_000;
const pos = (o = {}) => ({ entrySol: 0.02, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 5 * 60000, ...o });
const mark = (valueSol, o = {}) => ({ valueSol, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });

test('holds in the quiet middle', () => assert.equal(evaluateExit(pos(), mark(0.021), cfg, NOW).fraction, 0));
test('stop-loss on realizable value', () => { const d = evaluateExit(pos(), mark(0.0135), cfg, NOW); assert.equal(d.fraction, 1); assert.match(d.reason, /stop-loss/); });
test('TP1 sells the configured fraction once', () => {
  const d = evaluateExit(pos(), mark(0.0285), cfg, NOW); assert.equal(d.fraction, 0.5); assert.equal(d.tp1, true);
  assert.equal(evaluateExit(pos({ tp1Done: true, remainingFrac: 0.5 }), mark(0.0145), cfg, NOW).fraction, 0); // ratio 1.45 on remaining basis, not re-triggered
});
test('trailing stop after arming', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.5, peakRatio: 2 });
  const d = evaluateExit(p, mark(0.0165), cfg, NOW);             // ratio 1.65 ≤ 2*0.85
  assert.equal(d.fraction, 1); assert.match(d.reason, /trailing/);
  assert.equal(evaluateExit(p, mark(0.0185), cfg, NOW).fraction, 0);
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
