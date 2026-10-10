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
  assert.equal(c.tradeSol, 0.02); assert.equal(c.maxPositions, 3); assert.equal(c.dailyLossSol, 0.06);
});
test('TRADE_SOL typo guard', () => {
  assert.ok(validateConfig(loadConfig({ TRADE_SOL: '2' })).length > 0);
  assert.equal(validateConfig(loadConfig({ TRADE_SOL: '2', ALLOW_LARGE: '1' })).length, 0);
  assert.equal(validateConfig(loadConfig({})).length, 0);
});
