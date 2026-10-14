import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateConfig } from '../src/config.js';

test('REAL_MODE without a key stays in shadow mode', () => {
  const c = loadConfig({ REAL_MODE: '1' });
  assert.equal(c.realMode, false);
  assert.match(c.modeWarning, /SHADOW/);
});
test('real mode needs BOTH flag and key', () => {
  assert.equal(loadConfig({ REAL_MODE: '1', WALLET_PRIVATE_KEY: 'x' }).realMode, true);
  assert.equal(loadConfig({ WALLET_PRIVATE_KEY: 'x' }).realMode, false);
});
test('defaults are tiny', () => {
  const c = loadConfig({});
  assert.equal(c.tradeSol, 0.05); assert.equal(c.maxPositions, 5); assert.equal(c.dailyLossSol, 0); // 0 = cap disabled
});
test('TRADE_SOL typo guard', () => {
  assert.ok(validateConfig(loadConfig({ TRADE_SOL: '2' })).length > 0);
  assert.equal(validateConfig(loadConfig({ TRADE_SOL: '2', ALLOW_LARGE: '1' })).length, 0);
  assert.equal(validateConfig(loadConfig({})).length, 0);
});

test('entry fixes 2026-10-13: safer defaults — mandatory ape off, pace relax off, trend paused, ratio floors 0.60', () => {
  const c = loadConfig({});
  assert.equal(c.mandatoryApesPerHour, 0);
  assert.equal(c.paceRelax, 0);
  assert.equal(c.trendEnabled, 0);
  assert.equal(c.minBuyRatioM5, 0.60);
  assert.equal(c.trendMinBuyRatio, 0.60);
  assert.equal(c.fastPopMinBuyShare, 0.60);
  assert.equal(c.fastPopMaxGainPct, 0); // knob shipped off — a ceiling kills the OSPREY V-recovery fast pop exists to catch
  assert.equal(c.trendMinMc, 30000);
  assert.equal(validateConfig(c).length, 0);
});

test('shallow-dip veto 2026-10-14: defaults 0.10 / 60 min, 0 = off accepted, bad values rejected', () => {
  const c = loadConfig({});
  assert.equal(c.shallowDipMaxPct, 0.10);
  assert.equal(c.shallowDipWindowMin, 60);
  assert.equal(loadConfig({ SHALLOW_DIP_MAX_PCT: '0.05' }).shallowDipMaxPct, 0.05);
  assert.equal(loadConfig({ SHALLOW_DIP_WINDOW_MIN: '30' }).shallowDipWindowMin, 30);
  assert.equal(validateConfig(loadConfig({ SHALLOW_DIP_MAX_PCT: '0' })).length, 0); // 0 = rule off, valid (and the stale veto stays gone)
  assert.ok(validateConfig(loadConfig({ SHALLOW_DIP_MAX_PCT: '-0.1' })).some(e => e.includes('SHALLOW_DIP_MAX_PCT')));
  assert.ok(validateConfig(loadConfig({ SHALLOW_DIP_MAX_PCT: '0.95' })).some(e => e.includes('SHALLOW_DIP_MAX_PCT')));
  assert.ok(validateConfig(loadConfig({ SHALLOW_DIP_WINDOW_MIN: '0' })).some(e => e.includes('SHALLOW_DIP_WINDOW_MIN')));
  assert.ok(validateConfig(loadConfig({ SHALLOW_DIP_WINDOW_MIN: '721' })).some(e => e.includes('SHALLOW_DIP_WINDOW_MIN')));
});

test('break-even ratchet 2026-10-14: defaults +5% arm / +2% trigger, 0 = off accepted, trigger must sit below arm', () => {
  const c = loadConfig({});
  assert.equal(c.beArmPct, 0.05);
  assert.equal(c.beTriggerPct, 0.02);
  assert.equal(validateConfig(c).length, 0);
  assert.equal(validateConfig(loadConfig({ BE_ARM_PCT: '0' })).length, 0); // 0 = ratchet off, valid — never a boot poison
  assert.equal(loadConfig({ BE_ARM_PCT: '0.08' }).beArmPct, 0.08);
  assert.equal(loadConfig({ BE_TRIGGER_PCT: '0.01' }).beTriggerPct, 0.01);
  assert.ok(validateConfig(loadConfig({ BE_ARM_PCT: '-0.1' })).some(e => e.includes('BE_ARM_PCT')));
  assert.ok(validateConfig(loadConfig({ BE_TRIGGER_PCT: '-0.01' })).some(e => e.includes('BE_TRIGGER_PCT')));
  assert.ok(validateConfig(loadConfig({ BE_TRIGGER_PCT: '0.05' })).some(e => e.includes('BE_TRIGGER_PCT'))); // trigger == default arm: no cushion, rejected
  assert.ok(validateConfig(loadConfig({ BE_ARM_PCT: '0.03', BE_TRIGGER_PCT: '0.04' })).some(e => e.includes('BE_TRIGGER_PCT')));
});

test('probation leash 2026-10-14: defaults 300s probation / 7% leash, 0 accepted as off, bad values rejected', () => {
  const c = loadConfig({});
  assert.equal(c.stallProbationSec, 300);
  assert.equal(c.stallLeashPct, 0.07);
  assert.equal(validateConfig(loadConfig({ STALL_PROBATION_SEC: '0', STALL_LEASH_PCT: '0' })).length, 0); // both zero = off switches, valid
  assert.ok(validateConfig(loadConfig({ STALL_PROBATION_SEC: '-1' })).some(e => e.includes('STALL_PROBATION_SEC')));
  assert.ok(validateConfig(loadConfig({ STALL_LEASH_PCT: '0.95' })).some(e => e.includes('STALL_LEASH_PCT')));
  assert.ok(validateConfig(loadConfig({ STALL_LEASH_PCT: '-0.1' })).some(e => e.includes('STALL_LEASH_PCT')));
});

test('fresh flow bypass + bleed exit 2026-10-14: defaults, designed off states validate cleanly, bad values rejected', () => {
  const c = loadConfig({});
  assert.equal(c.freshBypassMinVolM5, 50000);
  assert.equal(c.freshBypassMinBuyRatio, 0.65);
  assert.equal(c.bleedPct, 0.07);
  assert.equal(c.bleedMinAgeSec, 180);
  assert.equal(c.bleedLookbackSec, 60);
  assert.equal(validateConfig(c).length, 0);
  // designed off states must NEVER be boot poison (the STOP_HARD_PCT lesson)
  assert.equal(validateConfig(loadConfig({ FRESH_BYPASS_MIN_VOL_M5: '0' })).length, 0); // 0 = bypass off, valid
  assert.equal(validateConfig(loadConfig({ BLEED_PCT: '0' })).length, 0);                // 0 = bleed exit off, valid
  assert.equal(loadConfig({ FRESH_BYPASS_MIN_VOL_M5: '75000' }).freshBypassMinVolM5, 75000);
  assert.equal(loadConfig({ BLEED_PCT: '0.1' }).bleedPct, 0.1);
  assert.ok(validateConfig(loadConfig({ FRESH_BYPASS_MIN_VOL_M5: '-1' })).some(e => e.includes('FRESH_BYPASS_MIN_VOL_M5')));
  assert.ok(validateConfig(loadConfig({ FRESH_BYPASS_MIN_BUY_RATIO: '1.2' })).some(e => e.includes('FRESH_BYPASS_MIN_BUY_RATIO')));
  assert.ok(validateConfig(loadConfig({ BLEED_PCT: '-0.05' })).some(e => e.includes('BLEED_PCT')));
  assert.ok(validateConfig(loadConfig({ BLEED_PCT: '1' })).some(e => e.includes('BLEED_PCT')));
  assert.ok(validateConfig(loadConfig({ BLEED_MIN_AGE_SEC: '-1' })).some(e => e.includes('BLEED_MIN_AGE_SEC')));
  assert.ok(validateConfig(loadConfig({ BLEED_LOOKBACK_SEC: '-1' })).some(e => e.includes('BLEED_LOOKBACK_SEC')));
});
