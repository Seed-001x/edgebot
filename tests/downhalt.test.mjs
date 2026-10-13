import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Risk } from '../src/risk.js';

const cfg = { dailyLossSol: 0, haltAfterCloses: 0, haltDownSol: 0.09, maxPositions: 1, mintCooldownMin: 0, loserCooldownH: 3, closedCooldownH: 3, maxTradesPerHour: 120, minReserveSol: 0.01, tradeSol: 0.1, killEquityFrac: 0 };
const enter = { mint: 'X', walletSol: 5, openCount: 0, sizeSol: 0.1 };

test('down-stop: arms at current P&L, halts the moment P&L falls 0.09 below it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-dd-'));
  let now = 1_800_000_000_000;
  const r = new Risk(cfg, { dir, now: () => now });
  r.s.dayPnlSol = 0.174; r.save();
  assert.equal(r.canEnter(enter).ok, true);            // arms baseline here
  assert.equal(r.s.haltDownBaseline, 0.174);
  r.recordClose(-0.05, 'A');                            // 0.124 — inside the band
  assert.equal(r.s.downHalted, false);
  assert.equal(fs.existsSync(path.join(dir, 'HALT')), false);
  r.recordClose(-0.045, 'B');                           // 0.079 — 0.095 below baseline → HALT
  assert.equal(r.s.downHalted, true);
  assert.equal(fs.existsSync(path.join(dir, 'HALT')), true);
  assert.match(r.canEnter(enter).reason, /down-stop hit/);
  r.clearDownHalt();                                    // human resume releases + re-anchors
  assert.equal(r.s.downHalted, false);
  assert.equal(r.s.haltDownBaseline, r.s.dayPnlSol);
});

test('down-stop off by default (HALT_DOWN_SOL=0)', () => {
  const r = new Risk({ ...cfg, haltDownSol: 0 }, { dir: null, now: () => 1_800_000_000_000 });
  r.recordClose(-0.5, 'A');
  assert.equal(r.s.downHalted, false);
  assert.equal(r.s.haltDownBaseline, null);
});
