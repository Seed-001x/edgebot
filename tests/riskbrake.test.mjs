import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Risk } from '../src/risk.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

// Risk brake (user 2026-10-15): "after the next 3 L trade half... if 1 trade wipes out
// the whole .05 then halt after that." LOSS_HALVE_N red closes from arming halve the
// size until lifted; one close losing >= WIPE_HALT_FRAC of its stake writes HALT.
let clock = Date.UTC(2026, 9, 15, 12, 0, 0);
const mk = (over = {}) => { const cfg = testCfg(over); return new Risk(cfg, { dir: cfg.dataDir, now: () => clock }); };
const haltFile = (r) => fs.existsSync(path.join(path.dirname(r.file), 'HALT'));

test('config: brake knobs default to the user rule and validate', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.lossHalveN, 3);
  assert.equal(cfg.lossHalveFactor, 0.5);
  assert.equal(cfg.wipeHaltFrac, 0.90);
  const over = loadConfig({ LOSS_HALVE_N: '5', LOSS_HALVE_FACTOR: '0.25', WIPE_HALT_FRAC: '0.8' });
  assert.equal(over.lossHalveN, 5); assert.equal(over.lossHalveFactor, 0.25); assert.equal(over.wipeHaltFrac, 0.8);
  assert.ok(validateConfig(loadConfig({ LOSS_HALVE_N: '-1' })).some(e => /LOSS_HALVE_N/.test(e)));
  assert.ok(validateConfig(loadConfig({ LOSS_HALVE_FACTOR: '0' })).some(e => /LOSS_HALVE_FACTOR/.test(e)));
  assert.ok(validateConfig(loadConfig({ WIPE_HALT_FRAC: '1.5' })).some(e => /WIPE_HALT_FRAC/.test(e)));
});

test('counter: only red closes count — greens and scratches do not, and a green does NOT reset the count', () => {
  const r = mk();
  assert.equal(r.recordClose(0.02, 'A', 0.05).red, false);
  assert.equal(r.recordClose(0, 'B', 0.05).red, false); // scratch is not a loss
  assert.equal(r.s.brakeRed, 0);
  assert.equal(r.recordClose(-0.01, 'C', 0.05).red, true);
  assert.equal(r.s.brakeRed, 1);
  r.recordClose(0.03, 'D', 0.05); // a win in between — the D4 streak resets, the brake does not
  assert.equal(r.s.lossStreak, 0);
  assert.equal(r.s.brakeRed, 1);
  r.recordClose(-0.01, 'E', 0.05);
  assert.equal(r.s.brakeRed, 2);
  assert.equal(r.s.sizeHalved, false);
});

test('halving: engages exactly at the 3rd red close and the NEXT size is halved', () => {
  const r = mk();
  const deep = () => r.sizeFor(1_000_000, 150); // deep pool → the effective size, uncapped
  assert.equal(deep(), 0.05);
  r.recordClose(-0.01, 'A', 0.05);
  r.recordClose(-0.02, 'B', 0.05);
  assert.equal(r.s.sizeHalved, false);
  assert.equal(deep(), 0.05);
  const ev = r.recordClose(-0.005, 'C', 0.05);
  assert.equal(ev.halvedNow, true);
  assert.equal(r.s.sizeHalved, true);
  assert.equal(r.effectiveTradeSol(), 0.025);
  assert.equal(deep(), 0.025);
  // further reds keep it halved (no double-halving)
  r.recordClose(-0.01, 'D', 0.025);
  assert.equal(r.effectiveTradeSol(), 0.025);
});

test('persistence: counter and halving survive a restart (same risk.json)', () => {
  const cfg = testCfg();
  let r = new Risk(cfg, { dir: cfg.dataDir, now: () => clock });
  r.recordClose(-0.01, 'A', 0.05); r.recordClose(-0.01, 'B', 0.05); r.recordClose(-0.01, 'C', 0.05);
  assert.equal(r.s.sizeHalved, true);
  r = new Risk(cfg, { dir: cfg.dataDir, now: () => clock }); // restart
  assert.equal(r.s.brakeRed, 3);
  assert.equal(r.s.sizeHalved, true);
  assert.equal(r.effectiveTradeSol(), 0.025);
});

test('lift: clearBrake (/risk/reset) zeroes the counter and releases the halving; the rule re-arms', () => {
  const r = mk();
  for (const m of ['A', 'B', 'C']) r.recordClose(-0.01, m, 0.05);
  assert.equal(r.s.sizeHalved, true);
  r.clearBrake();
  assert.equal(r.s.brakeRed, 0);
  assert.equal(r.s.sizeHalved, false);
  assert.equal(r.effectiveTradeSol(), 0.05);
  for (const m of ['D', 'E', 'F']) r.recordClose(-0.01, m, 0.05);
  assert.equal(r.s.sizeHalved, true); // trips again after three fresh reds
});

test('wipe halt: a full-stake loss writes the HALT latch after the close; a 58% loss does not', () => {
  const r = mk();
  assert.equal(haltFile(r), false);
  const ev1 = r.recordClose(-0.0292, 'NEXA', 0.05); // tonight's worst real close: 58.4% of stake
  assert.equal(ev1.wipeNow, false);
  assert.equal(r.s.brakeWipeHalted, false);
  assert.equal(haltFile(r), false);
  const ev2 = r.recordClose(-0.05, 'RUG', 0.05); // the whole .05 gone (fees push a true rug past 100%)
  assert.equal(ev2.wipeNow, true);
  assert.equal(r.s.brakeWipeHalted, true);
  assert.match(r.s.brakeWipeReason, /wipe halt/);
  assert.equal(haltFile(r), true);
  // the flag persists across a restart; only clearBrakeWipe (the /resume path) clears it
  const r2 = new Risk(r.cfg, { dir: r.cfg.dataDir, now: () => clock });
  assert.equal(r2.s.brakeWipeHalted, true);
  r2.clearBrakeWipe();
  assert.equal(r2.s.brakeWipeHalted, false);
  // and after the resume a second wipe halts again
  r2.recordClose(-0.048, 'RUG2', 0.05);
  assert.equal(r2.s.brakeWipeHalted, true);
});

test('wipe halt: judged against the position\'s own stake — a halved-size wipe also halts', () => {
  const r = mk();
  assert.equal(r.recordClose(-0.023, 'A', 0.025).wipeNow, true); // 92% of a 0.025 stake
  const r2 = mk();
  assert.equal(r2.recordClose(-0.022, 'A', 0.025).wipeNow, false); // 88% — under the line
});

test('wipe halt: never judged without a known stake (no entrySol → no halt, close still counts)', () => {
  const r = mk();
  const ev = r.recordClose(-0.05, 'A'); // legacy call shape: pnl + mint only
  assert.equal(ev.wipeNow, false);
  assert.equal(r.s.brakeWipeHalted, false);
  assert.equal(ev.red, true); // ...but the red close still counts toward the halving
  assert.equal(haltFile(r), false);
});

test('legs off: LOSS_HALVE_N=0 never counts or halves; WIPE_HALT_FRAC=0 never halts', () => {
  const r = mk({ lossHalveN: 0, wipeHaltFrac: 0 });
  for (let i = 0; i < 5; i++) {
    const ev = r.recordClose(-0.05, 'M' + i, 0.05);
    assert.equal(ev.red, false); assert.equal(ev.halvedNow, false); assert.equal(ev.wipeNow, false);
  }
  assert.equal(r.s.brakeRed, 0);
  assert.equal(r.s.sizeHalved, false);
  assert.equal(r.effectiveTradeSol(), 0.05);
  assert.equal(r.s.brakeWipeHalted, false);
  assert.equal(haltFile(r), false);
});

test('snapshot: /state risk exposes the brake state', () => {
  const r = mk();
  r.recordClose(-0.01, 'A', 0.05);
  const snap = r.snapshot();
  assert.equal(snap.brakeRed, 1);
  assert.equal(snap.sizeHalved, false);
  assert.equal(snap.brakeWipeHalted, false);
  assert.equal(snap.brakeWipeReason, null);
});
