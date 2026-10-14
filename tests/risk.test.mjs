import test from 'node:test';
import assert from 'node:assert/strict';
import { Risk } from '../src/risk.js';
import { testCfg, tmp } from './helpers.mjs';

let clock = Date.UTC(2026, 9, 9, 12, 0, 0);
const mk = (over = {}) => { const cfg = testCfg(over); return new Risk(cfg, { dir: cfg.dataDir, now: () => clock }); };
const ok = (r, o = {}) => r.canEnter({ mint: 'M', walletSol: 1, openCount: 0, sizeSol: 0.02, ...o });

test('allows a normal entry', () => assert.equal(ok(mk()).ok, true));
test('max positions', () => assert.match(ok(mk(), { openCount: 3 }).reason, /positions/));
test('reserve: never spends the last of the fees', () => assert.match(ok(mk(), { walletSol: 0.03 }).reason, /reserve/));
test('HALT blocks', () => assert.match(ok(mk(), { halted: true }).reason, /HALT/));
test('daily loss cap halts new entries, and resets next UTC day', () => {
  const r = mk(); r.recordClose(-0.03); assert.equal(ok(r).ok, true);
  r.recordClose(-0.03); assert.match(ok(r).reason, /daily loss/);
  clock += 24 * 3600e3; assert.equal(ok(r).ok, true);
});
test('hourly trade cap and per-mint cooldown', () => {
  const r = mk({ maxTradesPerHour: 2 });
  r.recordEntry('A'); r.recordEntry('B');
  assert.match(ok(r, { mint: 'C' }).reason, /hourly/);
  const r2 = mk(); r2.recordEntry('M'); assert.match(ok(r2).reason, /cooldown/);
});
test('kill switch trips below equity fraction and is permanent (persisted)', () => {
  const cfg = testCfg(); const dir = cfg.dataDir;
  let r = new Risk(cfg, { dir, now: () => clock });
  r.initEquity(1.0); r.checkKill(0.6, 0); assert.equal(r.s.killed, false);
  r.checkKill(0.3, 0.1); assert.equal(r.s.killed, true);
  r = new Risk(cfg, { dir, now: () => clock });   // restart
  assert.match(ok(r).reason, /kill switch/);
});
test('state survives a restart (daily loss cannot be reset by restarting)', () => {
  const cfg = testCfg(); let r = new Risk(cfg, { dir: cfg.dataDir, now: () => clock });
  r.recordClose(-0.07); r = new Risk(cfg, { dir: cfg.dataDir, now: () => clock });
  assert.match(ok(r).reason, /daily loss/);
});
test('size is capped by pool depth', () => {
  const r = mk();
  assert.equal(r.sizeFor(1_000_000, 150), 0.02);                    // deep pool → configured size
  assert.ok(Math.abs(r.sizeFor(150, 150) - 0.01) < 1e-9);           // 1% of a $150 pool = $1.50 = 0.01 SOL
  const big = mk({ tradeSol: 5 });                                  // if someone raises the size, the pool cap binds
  assert.ok(Math.abs(big.sizeFor(15_000, 150) - 1) < 1e-9);         // 1% of $15k = $150 = 1 SOL
});

test('cooldowns: no re-buy of a loser within 6h; NO re-entry after ANY close within 3h (user, 2026-10-12)', async () => {
  const { Risk } = await import('../src/risk.js');
  const { testCfg } = await import('./helpers.mjs');
  let t = 1_000_000_000_000;
  const r = new Risk(testCfg({ mintCooldownMin: 0 }), { now: () => t });
  const args = (mint) => ({ mint, walletSol: 1, openCount: 0, sizeSol: 0.1 });
  r.recordClose(-0.017, 'LOSER'); r.recordClose(0.02, 'WINNER');
  assert.match(r.canEnter(args('LOSER')).reason, /lost on this coin/);
  assert.match(r.canEnter(args('WINNER')).reason, /no re-entry for 3h/); // winners blocked too — the 2 journal re-entries both lost
  t += 3 * 3600000 + 1000;
  assert.equal(r.canEnter(args('WINNER')).ok, true);  // winner free after 3h
  assert.equal(r.canEnter(args('LOSER')).ok, false);  // loser still under the 6h loser cooldown
  t += 3 * 3600000;
  assert.equal(r.canEnter(args('LOSER')).ok, true);
});

// ---- D4 cold-market streak pause (user 2026-10-13) ----
test('D4: four straight losses pause entries; three do not', () => {
  const r = mk();
  r.recordClose(-0.01); r.recordClose(-0.02); r.recordClose(-0.003);
  assert.equal(ok(r).ok, true);
  r.recordClose(-0.017);
  const res = ok(r);
  assert.equal(res.ok, false); assert.match(res.reason, /streak pause/);
  assert.equal(r.snapshot().lossStreak, 4); assert.equal(r.snapshot().streakPaused, true);
});
test('D4: a win resets the streak — L L W L L L never reaches four', () => {
  const r = mk();
  r.recordClose(-0.01); r.recordClose(-0.01); r.recordClose(0.02);
  r.recordClose(-0.01); r.recordClose(-0.01); r.recordClose(-0.01);
  assert.equal(ok(r).ok, true); assert.equal(r.snapshot().lossStreak, 3);
});
test('D4: resume needs the minimum pause served AND breadth sustained; a dip restarts the heat clock', () => {
  const r = mk();
  for (let i = 0; i < 4; i++) r.recordClose(-0.01);
  assert.equal(r.snapshot().streakPaused, true);
  clock += 10 * 60000; // +10m: hot, but minimum pause (15m) not served
  assert.equal(r.noteBreadth(0.6, 500), null); assert.equal(r.snapshot().streakPaused, true);
  clock += 6 * 60000; // +16m: heat clock starts
  assert.equal(r.noteBreadth(0.6, 500), null);
  clock += 5 * 60000; // +21m: dip below the line — clock restarts
  assert.equal(r.noteBreadth(0.3, 500), null);
  clock += 1 * 60000; // +22m: hot again, clock restarts here
  assert.equal(r.noteBreadth(0.6, 500), null);
  clock += 9 * 60000; // +31m: 9m sustained — not enough
  assert.equal(r.noteBreadth(0.6, 500), null); assert.equal(r.snapshot().streakPaused, true);
  clock += 1 * 60000; // +32m: 10m sustained — resume
  assert.equal(r.noteBreadth(0.6, 500), 'resumed');
  assert.equal(r.snapshot().streakPaused, false); assert.equal(r.snapshot().lossStreak, 0);
  assert.equal(ok(r).ok, true);
});
test('D4: breadth from too few coins does not resume', () => {
  const r = mk();
  for (let i = 0; i < 4; i++) r.recordClose(-0.01);
  clock += 20 * 60000;
  assert.equal(r.noteBreadth(0.9, 10), null); // 90% green but only 10 coins reporting (< 50)
  clock += 15 * 60000;
  assert.equal(r.noteBreadth(0.9, 10), null);
  assert.equal(r.snapshot().streakPaused, true);
});
test('D4: a streak resume never releases a balance halt — that layer is the user\'s alone', () => {
  const r = mk();
  for (let i = 0; i < 4; i++) r.recordClose(-0.01);
  r.s.downHalted = true;
  clock += 20 * 60000; r.noteBreadth(0.6, 500);
  clock += 11 * 60000;
  assert.equal(r.noteBreadth(0.6, 500), 'resumed'); // streak layer lifts…
  assert.match(ok(r).reason, /balance down-stop/); // …but entries stay blocked by the balance halt
});
test('D4: a manual resume clears the pause and the streak', () => {
  const r = mk();
  for (let i = 0; i < 4; i++) r.recordClose(-0.01);
  assert.equal(r.snapshot().streakPaused, true);
  r.clearStreakPause();
  assert.equal(r.snapshot().streakPaused, false); assert.equal(r.snapshot().lossStreak, 0);
  assert.equal(ok(r).ok, true);
});
test('D4: STREAK_PAUSE_N=0 disables the pause entirely', () => {
  const r = mk({ streakPauseN: 0 });
  for (let i = 0; i < 9; i++) r.recordClose(-0.01);
  assert.equal(r.snapshot().streakPaused, false); assert.equal(ok(r).ok, true);
});
