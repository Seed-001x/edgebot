// Liftoff detector (user 2026-10-14): the BEGINNING of an uptrend — a coin
// lifting off a tight flat base in steps. Fixtures are the grind shapes from the
// design discussion (UNTXED/CODE: an hour of +1.5% steps that pop and trend
// structurally missed). The grind fixture fires; each sibling breaks exactly
// one rule and must not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, detectLiftoff } from '../src/detect.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, view, sample } from './helpers.mjs';

const cfg = testCfg();
const NOW = 1_000_000_000_000;

const BASE_FLOW = { buysM5: 55, sellsM5: 45, volM5: 5000 };    // 100 tx/5m, quiet base
const CLIMB_FLOW = { buysM5: 104, sellsM5: 76, volM5: 9000 };  // 180 tx/5m, ratio 0.58

// 37 minutes at the live 10s cadence: a ~25m flat base (prices cycle 1.00/1.03/
// 1.06 — a 6% range) then a 12m stepped climb. priceAt/flowAt are functions of
// minutes-ago so each fixture can reshape exactly one feature.
function grindSeries({ priceAt, flowAt }) {
  const out = [];
  for (let t = NOW - 37 * 60000; t <= NOW; t += 10000) {
    const ma = (NOW - t) / 60000;
    out.push(sample(t, priceAt(ma), flowAt(ma)));
  }
  return out;
}
const basePattern = (ma) => 1.00 + (Math.round((37 - ma) * 6) % 3) * 0.03;
const grindFlow = (ma) => (ma > 12 ? BASE_FLOW : CLIMB_FLOW);

// The grind: base 1.00–1.06, then +~3% steps every 2 minutes to 1.18 (+18% off
// the base low), chunk lows 1.06 → 1.09 → 1.15 (rising), activity 1.7× the base.
const grindPrice = (ma) => {
  if (ma > 12) return basePattern(ma);
  if (ma > 10) return 1.03;
  if (ma > 8) return 1.06;
  if (ma > 6) return 1.09;
  if (ma > 4) return 1.12;
  if (ma > 2) return 1.15;
  return 1.18;
};
const grindView = { price: 1.18, buysM5: 104, sellsM5: 76 };

test('liftoff: grind shape fires — flat base, stepped climb to +18%, rising lows, ratio 0.58, 1.7× activity', () => {
  const s = grindSeries({ priceAt: grindPrice, flowAt: grindFlow });
  // the classic detectors see nothing here (no burst for pop, trend paused) — liftoff is the catch
  assert.equal(detect(view(grindView), s, cfg, NOW), null);
  const r = detectLiftoff(view(grindView), s, cfg, NOW);
  assert.ok(r, 'expected a liftoff signal');
  assert.equal(r.setup, 'liftoff');
  assert.equal(r.metrics.gainPct, 18);
  assert.equal(r.metrics.buyRatioM5, 0.58);
  assert.ok(r.metrics.txnBoost >= 1.5, `txnBoost ${r.metrics.txnBoost}`);
  assert.equal(r.label, 'liftoff: +18% off 27m base, ratio 0.58');
  // strength is the gain itself (10–35 by construction): ties a weak pop, never tops a strong one
  assert.ok(Math.abs(r.strength - 18) < 0.01, `strength ${r.strength}`);
});

test('liftoff: flat forever does NOT fire', () => {
  const s = grindSeries({ priceAt: basePattern, flowAt: () => CLIMB_FLOW });
  assert.equal(detectLiftoff(view({ price: 1.00, buysM5: 104, sellsM5: 76 }), s, cfg, NOW), null);
});

test('liftoff: same base+climb to +60% does NOT fire — too late, extended is pop/trend territory', () => {
  const moonPrice = (ma) => {
    if (ma > 12) return basePattern(ma);
    if (ma > 10) return 1.08;
    if (ma > 8) return 1.17;
    if (ma > 6) return 1.27;
    if (ma > 4) return 1.37;
    if (ma > 2) return 1.48;
    return 1.60;
  };
  const s = grindSeries({ priceAt: moonPrice, flowAt: grindFlow });
  assert.equal(detectLiftoff(view({ price: 1.60, buysM5: 104, sellsM5: 76 }), s, cfg, NOW), null);
});

test('liftoff: no base does NOT fire — +40% within minutes of first sight', () => {
  const out = [];
  const t0 = NOW - 3 * 60000;
  for (let t = t0; t <= NOW; t += 10000) {
    out.push(sample(t, 1 + 0.4 * ((t - t0) / (3 * 60000)), CLIMB_FLOW));
  }
  assert.equal(detectLiftoff(view({ price: 1.40, buysM5: 104, sellsM5: 76 }), out, cfg, NOW), null);
});

test('liftoff: climb with a 0.45 buy ratio does NOT fire — pressure never built', () => {
  const s = grindSeries({ priceAt: grindPrice, flowAt: grindFlow });
  assert.equal(detectLiftoff(view({ price: 1.18, buysM5: 81, sellsM5: 99 }), s, cfg, NOW), null);
});

test('liftoff: a wick does NOT fire — chunk lows fall mid-climb even though the net gain passes', () => {
  // chunk mins 1.08 → 1.04 → 1.12: the second chunk dips back below the first
  // chunk's low (beyond the 0.5% tolerance), so the "climb" is a spike and a
  // retest, not rising structure. Gain (+18%), ratio and activity all pass.
  const wickPrice = (ma) => {
    if (ma > 12) return basePattern(ma);
    if (ma > 10) return 1.05;
    if (ma > 8.5) return 1.10;
    if (ma > 6.667) return 1.08;
    if (ma > 5.8) return 1.04;
    if (ma > 3.333) return 1.10;
    if (ma > 1.5) return 1.12;
    return 1.18;
  };
  const s = grindSeries({ priceAt: wickPrice, flowAt: grindFlow });
  assert.equal(detectLiftoff(view(grindView), s, cfg, NOW), null);
});

test('liftoff: climb on flat activity does NOT fire — trade count never picked up', () => {
  const flatFlow = () => ({ buysM5: 58, sellsM5: 42, volM5: 5000 }); // 100 tx/5m in both windows → boost 1.0
  const s = grindSeries({ priceAt: grindPrice, flowAt: flatFlow });
  assert.equal(detectLiftoff(view(grindView), s, cfg, NOW), null);
});

test('liftoff: grind shape on dust volume does NOT fire — $543 of 5m volume is two people, not a crowd (STUDIO)', () => {
  // the grind fixture passes every price/activity leg; only the dollars are missing
  const s = grindSeries({ priceAt: grindPrice, flowAt: grindFlow });
  assert.equal(detectLiftoff(view({ ...grindView, volM5: 543 }), s, cfg, NOW), null);
});

test('liftoff: the same grind with $6,000 of 5m volume fires — a crowd stands behind the twitch', () => {
  const s = grindSeries({ priceAt: grindPrice, flowAt: grindFlow });
  const r = detectLiftoff(view({ ...grindView, volM5: 6000 }), s, cfg, NOW);
  assert.ok(r, 'expected a liftoff signal');
  assert.equal(r.setup, 'liftoff');
  assert.equal(r.metrics.volM5, 6000);
  assert.equal(r.label, 'liftoff: +18% off 27m base, ratio 0.58');
});

test('liftoff: missing 5m volume does NOT fire — no volume figure, no floor cleared (same as trend freshness)', () => {
  const s = grindSeries({ priceAt: grindPrice, flowAt: grindFlow });
  const noVol = view(grindView);
  delete noVol.volM5;
  assert.equal(detectLiftoff(noVol, s, cfg, NOW), null);
});

test('liftoff: LIFTOFF_MIN_VOL_M5=0 turns the floor off — the dusty grind fires again (pre-floor behavior)', () => {
  const s = grindSeries({ priceAt: grindPrice, flowAt: grindFlow });
  const r = detectLiftoff(view({ ...grindView, volM5: 543 }), s, testCfg({ liftoffMinVolM5: 0 }), NOW);
  assert.ok(r, 'expected a liftoff signal with the floor off');
  assert.equal(r.setup, 'liftoff');
});

test('liftoff: disabled by LIFTOFF_ENABLED=0', () => {
  const s = grindSeries({ priceAt: grindPrice, flowAt: grindFlow });
  assert.equal(detectLiftoff(view(grindView), s, testCfg({ liftoffEnabled: false }), NOW), null);
});

test('liftoff config: defaults on with the specced values, validation rejects a bad share', () => {
  const c = loadConfig({});
  assert.equal(c.liftoffEnabled, true);
  assert.equal(c.liftoffMinHistoryMin, 20);
  assert.equal(c.liftoffLookbackMin, 45);
  assert.equal(c.liftoffBaseRangePct, 15);
  assert.equal(c.liftoffMinGainPct, 10);
  assert.equal(c.liftoffMaxGainPct, 35);
  assert.equal(c.liftoffClimbMin, 10);
  assert.equal(c.liftoffMinBuyShare, 0.55);
  assert.equal(c.liftoffTxnBoost, 1.5);
  assert.equal(c.liftoffMinVolM5, 5000);
  assert.equal(validateConfig(c).length, 0);
  const errs = validateConfig(loadConfig({ LIFTOFF_MIN_BUY_SHARE: '2' }));
  assert.ok(errs.some(e => e.includes('LIFTOFF_MIN_BUY_SHARE')));
  const volErrs = validateConfig(loadConfig({ LIFTOFF_MIN_VOL_M5: '-1' }));
  assert.ok(volErrs.some(e => e.includes('LIFTOFF_MIN_VOL_M5')));
});
