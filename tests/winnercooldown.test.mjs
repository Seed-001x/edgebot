import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Risk } from '../src/risk.js';
import { loadConfig } from '../src/config.js';

// Winner re-buy block (user 2026-10-15: 'let it apply for the wins as well').
// Mirrors the live shape: loser/winner window 1h, flat any-close sit-out 10m.
const cfg = { dailyLossSol: 0, maxPositions: 1, mintCooldownMin: 0, loserCooldownH: 1, winnerCooldownH: 1, closedCooldownH: 10 / 60, maxTradesPerHour: 120, minReserveSol: 0.01, tradeSol: 0.05, killEquityFrac: 0 };
const base = { walletSol: 5, openCount: 0, sizeSol: 0.05 };
const H = 3600000, M = 60000;

test('winner close → re-buy blocked inside 1h with the win wording (the HIMA shape)', () => {
  let now = 1_000_000_000_000;
  const r = new Risk(cfg, { dir: null, now: () => now });
  r.recordClose(+0.0063, 'HIMA'); // HIMA's actual green close
  now += 21 * M; // past the flat 10m sit-out, inside the hour — where the bad rebuy happened
  const res = r.canEnter({ mint: 'HIMA', ...base });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'closed this coin 21m ago (no re-buy for 1h)');
});

test('winner close → re-signal after 1h passes', () => {
  let now = 1_000_000_000_000;
  const r = new Risk(cfg, { dir: null, now: () => now });
  r.recordClose(+0.0063, 'HIMA');
  now += 59 * M;
  assert.equal(r.canEnter({ mint: 'HIMA', ...base }).ok, false);
  now += 2 * M; // 61m after the close
  assert.equal(r.canEnter({ mint: 'HIMA', ...base }).ok, true);
});

test('loser behavior unchanged: byte-identical stamp, same window', () => {
  let now = 1_000_000_000_000;
  const r = new Risk(cfg, { dir: null, now: () => now });
  r.recordClose(-0.01, 'LOSER');
  now += 21 * M;
  const res = r.canEnter({ mint: 'LOSER', ...base });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'lost on this coin 21m ago (no re-buy for 1h)');
  now += 40 * M;
  assert.equal(r.canEnter({ mint: 'LOSER', ...base }).ok, true);
});

test('scratch close (pnl == 0) anchors neither block — only the flat sit-out applies', () => {
  let now = 1_000_000_000_000;
  const r = new Risk(cfg, { dir: null, now: () => now });
  r.recordClose(0, 'SCRATCH');
  now += 5 * M;
  assert.match(r.canEnter({ mint: 'SCRATCH', ...base }).reason, /no re-entry for 10m/);
  now += 6 * M; // 11m after the close: inside the hour, but a scratch is not a win
  assert.equal(r.canEnter({ mint: 'SCRATCH', ...base }).ok, true);
});

test('a later loss re-anchors: win then loss → the loser stamp governs', () => {
  let now = 1_000_000_000_000;
  const r = new Risk(cfg, { dir: null, now: () => now });
  r.recordClose(+0.02, 'FLIP');
  now += 30 * M;
  r.recordClose(-0.01, 'FLIP');
  assert.equal(r.s.wins.FLIP, undefined);
  now += 20 * M;
  assert.equal(r.canEnter({ mint: 'FLIP', ...base }).reason, 'lost on this coin 20m ago (no re-buy for 1h)');
});

test('winner block survives a restart (persisted in risk.json, like losers)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnercd-'));
  let now = 1_000_000_000_000;
  const r1 = new Risk(cfg, { dir, now: () => now });
  r1.recordClose(+0.02, 'PERSIST');
  now += 30 * M;
  const r2 = new Risk(cfg, { dir, now: () => now });
  assert.equal(r2.canEnter({ mint: 'PERSIST', ...base }).reason, 'closed this coin 30m ago (no re-buy for 1h)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WINNER_COOLDOWN_H=0 turns the winner block off (flat sit-out still applies)', () => {
  let now = 1_000_000_000_000;
  const r = new Risk({ ...cfg, winnerCooldownH: 0 }, { dir: null, now: () => now });
  r.recordClose(+0.02, 'OFF');
  now += 5 * M;
  assert.equal(r.canEnter({ mint: 'OFF', ...base }).ok, false); // 10m sit-out
  now += 16 * M; // 21m: the HIMA rebuy moment — allowed with the block off
  assert.equal(r.canEnter({ mint: 'OFF', ...base }).ok, true);
});

test('config: winnerCooldownH defaults to the loser window; WINNER_COOLDOWN_H overrides', () => {
  assert.equal(loadConfig({}).winnerCooldownH, loadConfig({}).loserCooldownH);
  const one = loadConfig({ LOSER_COOLDOWN_H: '1' });
  assert.equal(one.loserCooldownH, 1);
  assert.equal(one.winnerCooldownH, 1); // the live shape: no WINNER_COOLDOWN_H in the store
  assert.equal(loadConfig({ LOSER_COOLDOWN_H: '1', WINNER_COOLDOWN_H: '2' }).winnerCooldownH, 2);
  assert.equal(loadConfig({ WINNER_COOLDOWN_H: '0' }).winnerCooldownH, 0);
});
