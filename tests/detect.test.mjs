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
const tcfg = testCfg({ trendEnabled: 1 });
test('trend: already-ranked runner still green, no history needed', () => {
  const r = detect(view({ chgH1: 80, chgM5: 30, volH1: 300_000 }), [], tcfg, NOW);
  assert.equal(r.setup, 'trend');
});
test('trend: stale move is chasing — most of the 1h move must be in the last 5m', () => {
  assert.equal(detect(view({ chgH1: 80, chgM5: 10, volH1: 300_000 }), [], tcfg, NOW), null);
  const r = detect(view({ chgH1: 80, chgM5: 30, volH1: 300_000 }), [], tcfg, NOW);
  assert.equal(r.setup, 'trend');
});
test('trend: skipped if it already rolled over >15% from a recent high', () => {
  const r = detect(view({ price: 1, chgH1: 80, chgM5: 30, volH1: 300_000 }), series([1.4, 1.4, 1.3, 1.1, 1]), tcfg, NOW);
  assert.equal(r, null);
});
test('trend: skipped when M5 is red', () => {
  assert.equal(detect(view({ chgH1: 80, chgM5: -3, volH1: 300_000 }), [], tcfg, NOW), null);
});
test('trend: one single buy is not momentum', () => {
  assert.equal(detect(view({ chgH1: 80, chgM5: 30, volH1: 300_000, buysM5: 1, sellsM5: 0 }), [], tcfg, NOW), null);
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

// ---- entry fixes 2026-10-13 (killswitch-entry-fixes.md, verified against the bot's own losers) ----
test('B1: trend is paused by default — the same view that fired all day returns nothing', () => {
  assert.equal(detect(view({ chgH1: 80, chgM5: 30, volH1: 300_000 }), [], cfg, NOW), null);
});
test('B4: trend needs a $30k market cap (BORING was $15k)', () => {
  assert.equal(detect(view({ chgH1: 80, chgM5: 30, volH1: 300_000, mc: 15_000 }), [], tcfg, NOW), null);
});
test('B2: Urara replay — a 0.71 5m ratio from 14 trades while the HOUR was sell-heavy (411 buys / 445 sells) is rejected', () => {
  const v = view({ chgH1: 30.06, chgM5: 20, volH1: 171_303, buysH1: 411, sellsH1: 445, buysM5: 10, sellsM5: 4 }); // volH1 raised past the floor so the B2 teeth are what bite
  assert.equal(detect(v, [], tcfg, NOW), null);
});
test('B2: hour buy-dominated but only 14 trades in 5m is still not demand', () => {
  const v = view({ chgH1: 80, chgM5: 30, volH1: 300_000, buysH1: 500, sellsH1: 400, buysM5: 10, sellsM5: 4 });
  assert.equal(detect(v, [], tcfg, NOW), null);
});
test('B2: hour buy-dominated with real 5m flow passes', () => {
  const v = view({ chgH1: 80, chgM5: 30, volH1: 300_000, buysH1: 500, sellsH1: 400, buysM5: 30, sellsM5: 10 });
  assert.equal(detect(v, [], tcfg, NOW).setup, 'trend');
});
test('B5: Urara revival replay — 67-day-old pool, +550% in 6h, is skipped', () => {
  const v = view({ chgH1: 80, chgM5: 30, volH1: 300_000, chgH6: 550, createdAt: NOW - 67 * 86400000 });
  assert.equal(detect(v, [], tcfg, NOW), null);
  const young = view({ chgH1: 80, chgM5: 30, volH1: 300_000, chgH6: 550, createdAt: NOW - 3600000 });
  assert.equal(detect(young, [], tcfg, NOW).setup, 'trend');
});
test('B3: wash volume on a small cap is not a pop (Urara shape: $71k hourly volume on a $15.6k cap)', () => {
  const v = view({ price: 1.5, mc: 15_600, liq: 20_000, volH1: 71_303, chgH1: 30 });
  assert.equal(detect(v, series(popPrices), cfg, NOW), null);
  const real = view({ price: 1.5, mc: 15_600, liq: 20_000, volH1: 40_000, chgH1: 30 });
  assert.equal(detect(real, series(popPrices), cfg, NOW).setup, 'pop');
});
test('A5: pop buy-ratio floor is 0.60 — 0.56 (ARCADES) is skipped, 0.61 passes', () => {
  assert.equal(detect(view({ price: 1.5, buysM5: 28, sellsM5: 22 }), series(popPrices), cfg, NOW), null);
  assert.equal(detect(view({ price: 1.5, buysM5: 61, sellsM5: 39 }), series(popPrices), cfg, NOW).setup, 'pop');
});
test('A5: trend buy-ratio floor is 0.60 — 0.56 is skipped', () => {
  const v = view({ chgH1: 80, chgM5: 30, volH1: 300_000, buysM5: 28, sellsM5: 22 });
  assert.equal(detect(v, [], tcfg, NOW), null);
});
test('A4: the fast-pop ceiling knob works when enabled — and is off by default so OSPREY lives', () => {
  const mk = (top) => Array.from({ length: 20 }, (_, i) => ({
    ts: NOW - (19 - i) * 2000, price: 1 + (top - 1) * (i / 19), sol: 0.2, side: i % 5 === 4 ? 'sell' : 'buy',
  }));
  const capped = testCfg({ fastPopMaxGainPct: 75 });
  assert.equal(fastPop(mk(2.2), capped, NOW), null); // +120% over a 75 ceiling
  const r = fastPop(mk(1.5), capped, NOW);
  assert.equal(r.setup, 'pop'); assert.equal(r.metrics.fastStream, 1);
  assert.ok(fastPop(mk(2.2), cfg, NOW)); // default cfg: no ceiling — V-recoveries still fire
});

// ---- D1 buy-ratio band (user 2026-10-13): the ratio fails at BOTH ends ----
test('D1: pop at 0.88 buy ratio is bundle-bait — blocked; 0.84 passes', () => {
  assert.equal(detect(view({ price: 1.5, buysM5: 88, sellsM5: 12 }), series(popPrices), cfg, NOW), null);
  assert.equal(detect(view({ price: 1.5, buysM5: 84, sellsM5: 16 }), series(popPrices), cfg, NOW).setup, 'pop');
});
test('D1: trend at 0.90 buy ratio (PEPECAT shape) is blocked even with trend enabled', () => {
  const v = view({ chgH1: 80, chgM5: 30, volH1: 300_000, buysM5: 90, sellsM5: 10 });
  assert.equal(detect(v, [], tcfg, NOW), null);
});
test('D1: fast pop share at 0.90 is blocked; the OSPREY 0.60 share still fires', () => {
  const mk = (buys) => Array.from({ length: 20 }, (_, i) => ({
    ts: NOW - (19 - i) * 2000, price: 1 + 0.5 * (i / 19), sol: 0.2, side: i < buys ? 'buy' : 'sell',
  }));
  assert.equal(fastPop(mk(18), cfg, NOW), null); // share 0.90
  assert.ok(fastPop(mk(12), cfg, NOW)); // share 0.60
});
