import test from 'node:test';
import assert from 'node:assert/strict';
import { Risk } from '../src/risk.js';

const cfg = { dailyLossSol: 0, maxPositions: 1, mintCooldownMin: 5, loserCooldownH: 3, closedCooldownH: 3, maxTradesPerHour: 120, minReserveSol: 0.01, tradeSol: 0.1, killEquityFrac: 0 };
const base = { walletSol: 5, openCount: 0, sizeSol: 0.1 };

test('re-entry blocked for 3h after a WINNING close, not just losses', () => {
  let now = 1_000_000_000;
  const r = new Risk(cfg, { dir: null, now: () => now });
  r.recordClose(+0.02, 'MINT_A');
  const res = r.canEnter({ mint: 'MINT_A', ...base });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no re-entry for 3h/);
  now += 2.9 * 3600000;
  assert.equal(r.canEnter({ mint: 'MINT_A', ...base }).ok, false);
  now += 0.2 * 3600000;
  assert.equal(r.canEnter({ mint: 'MINT_A', ...base }).ok, true);
});

test('other mints unaffected; seedClosed covers pre-restart closes', () => {
  let now = 5_000_000_000;
  const r = new Risk(cfg, { dir: null, now: () => now });
  r.seedClosed('MINT_B', now - 30 * 60000);
  assert.equal(r.canEnter({ mint: 'MINT_B', ...base }).ok, false);
  assert.equal(r.canEnter({ mint: 'MINT_C', ...base }).ok, true);
  r.seedClosed('MINT_OLD', now - 10 * 3600000); // outside window — ignored
  assert.equal(r.canEnter({ mint: 'MINT_OLD', ...base }).ok, true);
});
