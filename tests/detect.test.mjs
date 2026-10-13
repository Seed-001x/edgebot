import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, eligible, fastPop } from '../src/detect.js';
import { testCfg, view, sample } from './helpers.mjs';

const cfg = testCfg();
const NOW = 1_000_000_000_000;
const series = (prices) => prices.map((p, i) => sample(NOW - (prices.length - 1 - i) * 10000, p));

test('pop: flat then +50% inside the window', () => {
  const prices = [...Array(12).fill(1), 1.1, 1.2, 1.3, 1.4, 1.5];
  const r = detect(view({ price: 1.5 }), series(prices), cfg, NOW);
  assert.equal(r.setup, 'pop'); assert.ok(r.metrics.gainPct >= 49);
});
test('pop: flat series is nothing', () => {
  assert.equal(detect(view(), series(Array(20).fill(1)), cfg, NOW), null);
});
test('pop: refuses to chase an already-extended move (>200%)', () => {
  const prices = [...Array(10).fill(1), 2, 3, 3.5, 4];
  assert.equal(detect(view({ price: 4 }), series(prices), cfg, NOW), null);
});
test('pop: refuses when already rolling over from the high', () => {
  const prices = [...Array(10).fill(1), 1.5, 2, 2.0, 1.6];
  assert.equal(detect(view({ price: 1.6 }), series(prices), cfg, NOW), null);
});
test('pop: needs buy-side flow', () => {
  const prices = [...Array(12).fill(1), 1.2, 1.4, 1.5];
  assert.equal(detect(view({ price: 1.5, buysM5: 8, sellsM5: 30 }), series(prices), cfg, NOW), null);
});
test('pop: needs a minimum history span', () => {
  assert.equal(detect(view({ price: 1.5 }), series([1, 1.5]), cfg, NOW), null);
});
test('pop: one single buy pumping it is not momentum', () => {
  const prices = [...Array(12).fill(1), 1.2, 1.4, 1.5];
  assert.equal(detect(view({ price: 1.5, buysM5: 1, sellsM5: 0 }), series(prices), cfg, NOW), null);
});
test('pop: twenty buys with the same move is momentum (five is not)', () => {
  const prices = [...Array(12).fill(1), 1.2, 1.4, 1.5];
  assert.equal(detect(view({ price: 1.5, buysM5: 5, sellsM5: 1 }), series(prices), cfg, NOW), null);
  const r = detect(view({ price: 1.5, buysM5: 20, sellsM5: 4 }), series(prices), cfg, NOW);
  assert.equal(r.setup, 'pop');
});
test('trend: already-ranked runner still green, no history needed', () => {
  const r = detect(view({ chgH1: 80, chgM5: 30, volH1: 300_000 }), [], cfg, NOW);
  assert.equal(r.setup, 'trend');
});
test('trend: stale move is chasing — most of the 1h move must be in the last 5m', () => {
  assert.equal(detect(view({ chgH1: 80, chgM5: 10, volH1: 300_000 }), [], cfg, NOW), null);
  const r = detect(view({ chgH1: 80, chgM5: 30, volH1: 300_000 }), [], cfg, NOW);
  assert.equal(r.setup, 'trend');
});
test('trend: skipped if it already rolled over >15% from a recent high', () => {
  const r = detect(view({ price: 1, chgH1: 80, chgM5: 30, volH1: 300_000 }), series([1.4, 1.4, 1.3, 1.1, 1]), cfg, NOW);
  assert.equal(r, null);
});
test('trend: skipped when M5 is red', () => {
  assert.equal(detect(view({ chgH1: 80, chgM5: -3, volH1: 300_000 }), [], cfg, NOW), null);
});
test('trend: one single buy is not momentum', () => {
  assert.equal(detect(view({ chgH1: 80, chgM5: 30, volH1: 300_000, buysM5: 1, sellsM5: 0 }), [], cfg, NOW), null);
});
test('eligibility: thin pool and tiny cap are rejected', () => {
  assert.ok(eligible(view({ liq: 5000 }), cfg).length > 0);
  assert.ok(eligible(view({ mc: 5000 }), cfg).length > 0);
  assert.ok(eligible(view({ liq: 20_000, mc: 2_000_000 }), cfg).some(r => /% of mc/.test(r)));
  assert.equal(eligible(view(), cfg).length, 0);
});

// ---- buy-rule tightening (dead-cat bounces, fresh graduations, low volume) ----
const popPrices = [...Array(12).fill(1), 1.2, 1.4, 1.5];
test('pop: bounce off a crash is not a pop (down on the hour)', () => {
  assert.equal(detect(view({ price: 1.5, chgH1: -40 }), series(popPrices), cfg, NOW), null);
});
test('pop: skipped when still far under the 1h high', () => {
  const hist = [sample(NOW - 40 * 60000, 3), sample(NOW - 30 * 60000, 2.5), ...series(popPrices)]; // 1h high 3, now 1.5
  assert.equal(detect(view({ price: 1.5, chgH1: 5 }), hist, cfg, NOW), null);
});
test('pop: low 5-minute volume is skipped (25k judged on the 5m window)', () => {
  assert.equal(detect(view({ price: 1.5, volM5: 15_000 }), series(popPrices), cfg, NOW), null);
  // a hot 5 minutes is enough even when the hour as a whole is quiet
  assert.equal(detect(view({ price: 1.5, volM5: 40_000, volH1: 5_000 }), series(popPrices), cfg, NOW).setup, 'pop');
});
test('pool-age filter: off by default, blocks fresh pools when MIN_PAIR_AGE_MIN is set', () => {
  assert.equal(detect(view({ price: 1.5, createdAt: NOW - 3 * 60000 }), series(popPrices), cfg, NOW).setup, 'pop');
  const aged = { ...cfg, minPairAgeMin: 15 };
  assert.ok(eligible(view({ createdAt: NOW - 3 * 60000 }), aged, NOW).some(r => /pool only/.test(r)));
  assert.equal(eligible(view({ createdAt: NOW - 30 * 60000 }), aged, NOW).length, 0);
});

test('pop: coin down 40%+ over 6h is a crash bounce, even if up on the hour (wINU 00:36)', () => {
  assert.equal(detect(view({ price: 1.5, chgH1: 10, chgH6: -55 }), series(popPrices), cfg, NOW), null);
  assert.equal(detect(view({ price: 1.5, chgH1: 10, chgH6: -20 }), series(popPrices), cfg, NOW).setup, 'pop');
  assert.equal(detect(view({ price: 1.5, chgH1: 10, chgH6: -55 }), series(popPrices), { ...cfg, popMaxDropH6: 0 }, NOW).setup, 'pop'); // off
});

// ---- fast pop (live trade stream) ----
const fTrades = (prices, opts = {}) => prices.map((p, i) => ({
  ts: NOW - (prices.length - 1 - i) * (opts.stepMs || 3000),
  price: p,
  sol: opts.solPerTrade ?? 0.2,
  side: opts.side ? opts.side(i) : 'buy',
}));
const ramp = (from, to, n) => Array.from({ length: n }, (_, i) => from + (to - from) * (i / (n - 1)));

test('fastpop: fires on a live +45% ramp with buy-dominated flow', () => {
  const r = fastPop(fTrades(ramp(1, 1.45, 25), { side: (i) => (i % 5 === 4 ? 'sell' : 'buy') }), cfg, NOW);
  assert.ok(r, 'expected a signal');
  assert.equal(r.setup, 'pop');
  assert.equal(r.metrics.fastStream, 1);
  assert.ok(r.metrics.gainPct >= 44);
  assert.ok(r.metrics.buyRatioM5 >= 0.55);
});
test('fastpop: a V-recovery off the window low fires (OSPREY shape)', () => {
  const prices = [...ramp(1, 0.55, 10), ...ramp(0.55, 1.05, 15)]; // dump then recovery: last is +91% off the low
  const r = fastPop(fTrades(prices, { side: (i) => (i < 10 ? 'sell' : 'buy') }), cfg, NOW);
  // sells dominate the whole window here (15 buys / 25) = 0.6 share — fires
  assert.ok(r, 'expected a signal');
});
test('fastpop: flat stream is nothing', () => {
  assert.equal(fastPop(fTrades(Array(25).fill(1)), cfg, NOW), null);
});
test('fastpop: rollover from the window peak does not fire', () => {
  const prices = [...ramp(1, 1.6, 15), ...ramp(1.6, 1.35, 10)]; // last is ~16% under the peak
  assert.equal(fastPop(fTrades(prices), cfg, NOW), null);
});
test('fastpop: sell-dominated live flow does not fire', () => {
  assert.equal(fastPop(fTrades(ramp(1, 1.5, 25), { side: (i) => (i % 3 === 0 ? 'buy' : 'sell') }), cfg, NOW), null);
});
test('fastpop: thin volume does not fire', () => {
  assert.equal(fastPop(fTrades(ramp(1, 1.5, 25), { solPerTrade: 0.01 }), cfg, NOW), null);
});
test('fastpop: a move that stopped printing does not fire', () => {
  const stale = fTrades(ramp(1, 1.5, 25)).map(t => ({ ...t, ts: t.ts - 40000 })); // last trade 40s ago
  assert.equal(fastPop(stale, cfg, NOW), null);
});
test('fastpop: too few trades does not fire', () => {
  assert.equal(fastPop(fTrades(ramp(1, 1.5, 6), { stepMs: 10000 }), cfg, NOW), null);
});
