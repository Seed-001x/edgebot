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
