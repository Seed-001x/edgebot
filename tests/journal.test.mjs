import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/journal.js';
import { tmp, view } from './helpers.mjs';

test('follows every signal forward and records +5/+15/+60 returns, best and worst', () => {
  let t = 1_000_000_000_000; const j = new Journal(tmp(), { now: () => t });
  j.signal({ mint: 'A', symbol: 'A', setup: 'pop', decision: 'taken', price: 1, mc: 1e6 });
  j.signal({ mint: 'B', symbol: 'B', setup: 'pop', decision: 'skipped', reasons: ['clones: 18 wallets hold the exact same balance'], price: 1, mc: 1e6 });
  for (const [min, a, b] of [[1, 1.1, 0.9], [5, 1.3, 0.6], [15, 1.5, 0.3], [40, 2.0, 0.1], [60, 1.2, 0.05]]) {
    t = 1_000_000_000_000 + min * 60000;
    j.observe(view({ address: 'A', price: a })); j.observe(view({ address: 'B', price: b }));
  }
  const r = j.report();
  const taken = r.bySetup['pop/taken'], skipped = r.bySetup['pop/skipped'];
  assert.equal(taken.avgR5, 0.3); assert.equal(taken.avgR15, 0.5); assert.equal(taken.avgR60, 0.2); assert.equal(taken.avgMaxRet, 1);
  assert.equal(skipped.avgR15, -0.7); assert.equal(skipped.winRate15, 0);
  assert.equal(r.bySkipReason.clones.n, 1);              // the gate "saved" us: skipped coin fell 70%
  assert.equal(j.pending.size, 0);
});
test('survives a restart: signals and finished outcomes are reloaded', () => {
  const dir = tmp(); let t = 1_000_000_000_000;
  let j = new Journal(dir, { now: () => t });
  j.signal({ mint: 'A', symbol: 'A', setup: 'trend', decision: 'taken', price: 2, mc: 1e6 });
  for (const m of [5, 15, 60]) { t = 1_000_000_000_000 + m * 60000; j.observe(view({ address: 'A', price: 3 })); }
  j = new Journal(dir, { now: () => t });
  assert.equal(j.report().bySetup['trend/taken'].avgR60, 0.5);
});
test('unobserved signals expire instead of leaking', () => {
  let t = 1_000_000_000_000; const j = new Journal(tmp(), { now: () => t });
  j.signal({ mint: 'A', symbol: 'A', setup: 'pop', decision: 'skipped', reasons: ['x: y'], price: 1, mc: 1 });
  t += 100 * 60000; j.observe(view({ address: 'ZZZ', price: 1 }));
  assert.equal(j.pending.size, 0);
});
test('trade stats aggregate closed trades', () => {
  const j = new Journal(tmp());
  j.trade({ type: 'close', pnlSol: 0.01, reason: 'trailing stop (15% off peak 2.00x)' });
  j.trade({ type: 'close', pnlSol: -0.004, reason: 'stop-loss (-21%)' });
  j.trade({ type: 'open' });
  const t = j.report().trades;
  assert.equal(t.closed, 2); assert.equal(t.wins, 1); assert.ok(Math.abs(t.totalPnlSol - 0.006) < 1e-9);
});
