import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Risk } from '../src/risk.js';

const cfg = { dailyLossSol: 0, haltAfterCloses: 0, haltDownSol: 0.09, maxPositions: 1, mintCooldownMin: 0, loserCooldownH: 3, closedCooldownH: 3, maxTradesPerHour: 120, minReserveSol: 0.01, tradeSol: 0.1, killEquityFrac: 0 };
const enter = { mint: 'X', walletSol: 5, openCount: 0, sizeSol: 0.1 };

test('balance halt: anchors at current equity, halts when equity falls 0.09 below it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-bal-'));
  const r = new Risk(cfg, { dir, now: () => 1_800_000_000_000 });
  r.checkBalanceHalt(1.5, 0);                       // anchors at 1.5
  assert.equal(r.s.haltBalBaseline, 1.5);
  r.checkBalanceHalt(1.42, 0);                      // down 0.08 — inside the band
  assert.equal(r.s.downHalted, false);
  r.checkBalanceHalt(1.40, 0);                      // down 0.10 → HALT
  assert.equal(r.s.downHalted, true);
  assert.equal(fs.existsSync(path.join(dir, 'HALT')), true);
  assert.match(r.canEnter(enter).reason, /balance down-stop/);
  r.clearDownHalt();
  assert.equal(r.s.downHalted, false);
  assert.equal(r.s.haltBalBaseline, null);          // re-anchors on next check
});

test('balance halt: opening a position does not fake a drop (equity = wallet + open cost)', () => {
  const r = new Risk(cfg, { dir: null, now: () => 1_800_000_000_000 });
  r.checkBalanceHalt(1.5, 0);                       // anchor 1.5, nothing open
  r.checkBalanceHalt(1.4, 0.1);                     // 0.1 moved into a position — equity unchanged
  assert.equal(r.s.downHalted, false);
  r.checkBalanceHalt(1.30, 0.1);                    // equity 1.40 — down 0.10 → halt
  assert.equal(r.s.downHalted, true);
});

test('balance halt off by default (HALT_DOWN_SOL=0)', () => {
  const r = new Risk({ ...cfg, haltDownSol: 0 }, { dir: null, now: () => 1_800_000_000_000 });
  r.checkBalanceHalt(0.01, 0);
  assert.equal(r.s.downHalted, false);
  assert.equal(r.s.haltBalBaseline, null);
});
