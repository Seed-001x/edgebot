import test from 'node:test';
import assert from 'node:assert/strict';
import { runGates } from '../src/gate.js';
import { testCfg, view, tmp } from './helpers.mjs';

const cfg = testCfg();
const NOW = 1_000_000_000_000;
const clones = (n, amount) => Array.from({ length: n }, (_, i) => ({ owner: 'w' + i, address: 'a' + i, amount, pct: 0.05 }));

// Fixtures rebuilt from the RugCheck / DexScreener numbers pulled for DOTF and QI.
const DOTF = {
  view: view({ address: 'DOTF', name: 'Digital Oil Trust Fund', symbol: 'DOTF', mc: 159_580_176, liq: 1_104_583, chgH1: 353145, createdAt: NOW - 11 * 60000, volH24: 544_087, volM5: 0 }), // volM5 pinned: the fixture never carried real 5m volume (helper default) — the volume-bypass case is the Eikon suite below
  rug: {
    token: { supply: 999987875747397, decimals: 6, mintAuthority: null, freezeAuthority: null }, creatorBalance: 158144377812626, totalHolders: 2208,
    markets: [{ pubkey: 'POOL', lp: { base: 3467957.25, quote: 5063.08, lpLockedUSD: 1.1e6, lpLockedPct: 100 } }],
    knownAccounts: { POOL: { type: 'AMM' } },
    topHolders: [{ owner: 'CREATOR', address: 'c', amount: 158144377812626, pct: 15.8 }, { owner: 'POOL', address: 'p', amount: 3467957248829, pct: 0.35 }, ...clones(18, 498001881166)],
    insiderNetworks: null,
  },
};
const QI = {
  view: view({ address: 'QI', name: 'Quantum Inu', symbol: 'QI', mc: 9_471_329, liq: 267_637, chgH1: 20900, createdAt: NOW - 13 * 60000, volH24: 123_709 }),
  rug: {
    token: { supply: 999793825174390, decimals: 6 }, creatorBalance: 0, totalHolders: 1167,
    markets: [{ pubkey: 'POOL', lp: { base: 14230007.44, quote: 1220.47, lpLockedUSD: 268015, lpLockedPct: 100 } }],
    knownAccounts: { POOL: { type: 'AMM' } },
    topHolders: [{ owner: 'POOL', address: 'p', amount: 14230007442699, pct: 1.42 }, ...clones(19, 1586200000000)],
    insiderNetworks: [{ currentHolding: 192408048450400 }],
  },
};
const original = { address: 'ORIG', name: 'Quantum Inu', symbol: 'QI', createdAt: NOW - 19 * 3600e3, volH24: 8_000_000, liq: 900_000 };

test('DOTF fixture is rejected for the right reasons', () => {
  const g = runGates({ view: DOTF.view, rug: DOTF.rug, cfg, now: NOW });
  assert.equal(g.pass, false);
  const keys = g.fails.map(f => f.split(':')[0]);
  for (const k of ['clones', 'creator', 'depth', 'vertical']) assert.ok(keys.includes(k), `missing ${k} in ${keys}`);
  assert.match(g.fails.find(f => f.startsWith('creator')), /9\d\.\d% of pool/);
});
test('QI fixture is rejected on its remaining gates — no clone leg (copycat filter removed)', () => {
  const g = runGates({ view: QI.view, rug: QI.rug, cfg, now: NOW });
  assert.equal(g.pass, false);
  const keys = g.fails.map(f => f.split(':')[0]);
  for (const k of ['clones', 'insiders', 'depth', 'vertical']) assert.ok(keys.includes(k), `missing ${k} in ${keys}`);
  assert.ok(!keys.includes('clone'), `clone leg leaked into fails: ${keys}`);
  assert.equal(g.checks.clone, undefined);
});
test('healthy 3-day-old coin passes', () => {
  const v = view({ createdAt: NOW - 72 * 3600e3, chgH1: 40 });
  const holders = Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 }));
  const rug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 3000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: [{ owner: 'POOL', address: 'p', amount: 1e14, pct: 10 }, ...holders], insiderNetworks: [] };
  const g = runGates({ view: v, rug, cfg, now: NOW });
  assert.deepEqual(g.fails, []); assert.equal(g.pass, true);
});
test('young coin with no RugCheck report is blocked; older one is allowed with a warning', () => {
  const young = runGates({ view: view({ createdAt: NOW - 30 * 60000 }), rug: null, cfg, now: NOW });
  assert.ok(young.fails.some(f => f.startsWith('report')));
  const old = runGates({ view: view({ createdAt: NOW - 48 * 3600e3 }), rug: null, cfg, now: NOW });
  assert.equal(old.pass, true); assert.ok(old.warnings.length > 0);
});
test('open mint/freeze authority and LP not locked are hard fails', () => {
  const rug = { token: { supply: 1e15, decimals: 6, mintAuthority: 'x', freezeAuthority: 'y' }, creatorBalance: 0, totalHolders: 900, markets: [{ pubkey: 'P', lp: { base: 1e8, quote: 1000, lpLockedUSD: 1, lpLockedPct: 10 } }], topHolders: [], insiderNetworks: [] };
  const g = runGates({ view: view({ createdAt: NOW - 72 * 3600e3 }), rug, cfg, now: NOW });
  const keys = g.fails.map(f => f.split(':')[0]);
  for (const k of ['mintAuthority', 'freezeAuthority', 'lp']) assert.ok(keys.includes(k));
});
test('copycat (clone) filter REMOVED (user 2026-10-14): no cloneCheck export, and the gate stack has no clone leg even with an established original in the room', async () => {
  const gate = await import('../src/gate.js');
  // The filter failed a younger, smaller coin carrying an established coin's name/ticker
  // when an older same-name coin had >= CLONE_MIN_VOL_MULTIPLE (2x) its 24h volume or
  // liquidity. The user ordered it out: copycats are judged by the normal gates.
  assert.equal(gate.cloneCheck, undefined);
  // The old filter's exact block shape, from this file's fixtures: QI (13 min old) against
  // the older, far bigger `original` used to add a 'clone' fail on top of QI's real fails.
  // Hand runGates the original and prove the clone leg no longer exists in the result —
  // while the unrelated holder-cluster leg ('clones') still fires on the same fixture.
  const g = runGates({ view: QI.view, rug: QI.rug, others: [original], cfg, now: NOW });
  assert.equal(g.checks.clone, undefined);
  assert.ok(!g.fails.some(f => f.startsWith('clone:')), `clone fail leaked: ${g.fails}`);
  assert.ok(g.fails.some(f => f.startsWith('clones:')), `holder-cluster leg should still fire: ${g.fails}`);
});

test('tempRuleViolation: one-trade MC cap and crash ban', async () => {
  const { tempRuleViolation } = await import('../src/gate.js');
  const rules = { maxMc: 100000, maxDropPct: 70 };
  assert.equal(tempRuleViolation({ mc: 50000, chgH6: 10 }, { drawFromPeak: 0.1 }, rules), null);
  assert.match(tempRuleViolation({ mc: 150000, chgH6: 10 }, { drawFromPeak: 0.1 }, rules), /one-trade cap/);
  assert.match(tempRuleViolation({ mc: 50000, chgH6: 10 }, { drawFromPeak: 0.75 }, rules), /crash ban/);
  assert.match(tempRuleViolation({ mc: 50000, chgH6: -82 }, { drawFromPeak: 0.1 }, rules), /crash ban/);
  assert.equal(tempRuleViolation({ mc: 999999 }, { drawFromPeak: 0.99 }, null), null);
  assert.equal(tempRuleViolation({ mc: null, chgH6: null }, {}, rules), null);
});

test('blockedNameWord: whole-word name block (user 2026-10-13, CI/SCI)', async () => {
  const { blockedNameWord } = await import('../src/gate.js');
  assert.equal(blockedNameWord('Crypto Inu', ['inu']), 'inu');
  assert.equal(blockedNameWord('Super Crypto Inu', ['inu']), 'inu');
  assert.equal(blockedNameWord('SHIBA INU', ['inu']), 'inu');
  assert.equal(blockedNameWord('Baby-Inu Coin', ['inu']), 'inu');
  assert.equal(blockedNameWord('Continuum', ['inu']), null);   // letters inside a word don't count
  assert.equal(blockedNameWord('Minute', ['inu']), null);
  assert.equal(blockedNameWord('Dogecoin', ['inu']), null);
  assert.equal(blockedNameWord('Inu', []), null);               // empty list = off
  assert.equal(blockedNameWord(null, ['inu']), null);
  assert.equal(blockedNameWord('Crypto Inu', null), null);
});

test('stale-pop veto REMOVED (user 2026-10-14, CODE): no stalePopCheck export, and a second-hump history passes the surviving sampled guards', async () => {
  const gate = await import('../src/gate.js');
  // The veto (added 2026-10-13 for SCI) was deleted on the user's order after it rejected
  // CODE's second signal: a pop may no longer be skipped for staleness, anywhere.
  assert.equal(gate.stalePopCheck, undefined);
  const now = NOW;
  const S = (agoSec, price) => ({ ts: now - agoSec * 1000, price });
  // CODE shape: sampled high 330s old, price now 28% below it — the veto's exact target.
  const code = [S(360, 1.20), S(330, 1.39), S(300, 1.32), S(270, 1.26), S(240, 1.20), S(210, 1.15), S(180, 1.10), S(150, 1.07), S(120, 1.04), S(90, 1.02), S(60, 1.01), S(30, 1.00), S(0, 1.00)];
  // Prove the fixture really is the old veto's shape (60s+ old high, 8%+ rolloff):
  const peak = Math.max(...code.map(s => s.price));
  const peakTs = code.find(s => s.price === peak).ts;
  assert.equal((now - peakTs) / 1000, 330);
  assert.ok(Math.abs((1 - 1.00 / peak) - 0.28) < 0.01, `drop ${(1 - 1.00 / peak).toFixed(3)}`);
  // The surviving sample-judged guards judge this history on their own terms and pass it:
  // extension is measured from the trailing base (here the current price IS the base),
  // and fresh-history sees enough samples to judge (and nothing extended in the aggregates).
  assert.equal(gate.extensionCheck(code, 1.00, now, { maxExt: 1.5 }).pass, true);
  assert.equal(gate.freshHistoryCheck(code, view({ price: 1.00 }), now, { maxChgM5: 25, smallMc: 30000, m5ShareH1: 0.7 }).pass, true);
});

test('extensionCheck: extreme extension above the 1h base vetoed, near-base entries pass (user 2026-10-13, OTTO)', async () => {
  const { extensionCheck } = await import('../src/gate.js');
  const now = 1_000_000_000_000;
  const S = (agoSec, price) => ({ ts: now - agoSec * 1000, price });
  const opts = { maxExt: 1.5 };
  // OTTO shape: long base sampled flat at 24, entry print at 86 = +258% over the base low -> vetoed
  const otto = [];
  for (let a = 3300; a >= 300; a -= 300) otto.push(S(a, 24 + (a % 3) * 4));
  otto.push(S(60, 60), S(5, 86));
  assert.equal(extensionCheck(otto, 86, now, opts).pass, false);
  // same base, entry at 55 = +129% over the low -> passes
  assert.equal(extensionCheck(otto, 55, now, opts).pass, true);
  // steady climber whose base rose with it: trailing-hour low is recent -> modest extension -> pass
  const grind = [];
  for (let a = 3300; a >= 60; a -= 300) grind.push(S(a, 100 - (3300 - a) / 60));
  grind.push(S(5, 100));
  assert.equal(extensionCheck(grind, 100, now, opts).pass, true);
  // thin history -> fail-open (no base to judge)
  assert.equal(extensionCheck([S(60, 50), S(5, 300)], 300, now, opts).pass, true);
  // short span (all samples inside 2 minutes) -> fail-open
  const burst = [];
  for (let i = 0; i < 12; i++) burst.push(S(100 - i * 8, 10 + i));
  assert.equal(extensionCheck(burst, 200, now, opts).pass, true);
  // disabled
  assert.equal(extensionCheck(otto, 86, now, { maxExt: 0 }).pass, true);
});

test('shallowDipCheck: the rollover zone just under the top is vetoed; the top, new highs and real dips pass (user 2026-10-14)', async () => {
  const { shallowDipCheck } = await import('../src/gate.js');
  const now = NOW;
  const S = (agoSec, price) => ({ ts: now - agoSec * 1000, price });
  const opts = { maxPct: 0.10, windowMin: 60 };
  // sampled top 100 printed 10 minutes ago, solid history around it (span 19 min)
  const hist = [S(1200, 92), S(900, 96), S(600, 100), S(300, 97), S(60, 96)];
  // at the top and breaking above it: no veto (strength is buyable)
  assert.equal(shallowDipCheck(hist, 100, now, opts).pass, true);
  assert.equal(shallowDipCheck(hist, 104, now, opts).pass, true);
  // his example: -5% under the top — the rollover spot — vetoed
  const v = shallowDipCheck(hist, 95, now, opts);
  assert.equal(v.pass, false);
  assert.match(v.reason, /-5\.0% under the trailing 60m top/);
  // just inside the zone (-9% under) is still vetoed
  assert.equal(shallowDipCheck(hist, 91, now, opts).pass, false);
  // the boundary: exactly -10% under falls on the ALLOWED side — the veto zone is
  // strictly 0 < distance < 0.10, so 0.10 exactly is a real dip, not a rollover
  assert.equal(shallowDipCheck(hist, 90, now, opts).pass, true);
  // deeper dips pass on distance (each setup's volume / buy-inflow legs judge them)
  assert.equal(shallowDipCheck(hist, 85, now, opts).pass, true);
  assert.equal(shallowDipCheck(hist, 50, now, opts).pass, true);
  // the SCI/CODE second-hump shape — a fresh signal 28% under its sampled high, the old
  // stale-pop veto's exact target — is NOT vetoed by the replacement rule
  const code = [S(360, 1.20), S(330, 1.39), S(300, 1.32), S(270, 1.26), S(240, 1.20), S(210, 1.15), S(180, 1.10), S(150, 1.07), S(120, 1.04), S(90, 1.02), S(60, 1.01), S(30, 1.00), S(0, 1.00)];
  const c = shallowDipCheck(code, 1.00, now, opts);
  assert.equal(c.pass, true);
  assert.ok(Math.abs(c.dist - 0.28) < 0.01, `dist ${c.dist}`);
  // a top sampled outside the trailing window does not count as the recent top
  const oldTop = [S(3700, 100), S(600, 57), S(300, 56), S(60, 57)];
  assert.equal(shallowDipCheck(oldTop, 57, now, opts).pass, true);
  // thin history fails open: fewer than 3 samples, and a sampled span under 60s
  assert.equal(shallowDipCheck([S(60, 100), S(0, 95)], 95, now, opts).pass, true);
  assert.equal(shallowDipCheck([S(50, 100), S(25, 98), S(0, 95)], 95, now, opts).pass, true);
  // disabled
  assert.equal(shallowDipCheck(hist, 95, now, { maxPct: 0 }).pass, true);
});

// ---- A3 fresh-history fail-closed (entry fixes 2026-10-13) ----
test('A3: BORING replay — no samples, +41.6% in 5m vs +13.8% on the hour at $14.5k — is rejected', async () => {
  const { freshHistoryCheck } = await import('../src/gate.js');
  const r = freshHistoryCheck([], { chgM5: 41.6, chgH1: 13.78, mc: 14_494 }, NOW);
  assert.equal(r.pass, false);
});
test('A3: a small cap whose whole hour is one 5m candle is rejected even under the m5 cap', async () => {
  const { freshHistoryCheck } = await import('../src/gate.js');
  const r = freshHistoryCheck([], { chgM5: 20, chgH1: 24, mc: 20_000 }, NOW);
  assert.equal(r.pass, false);
});
test('A3: thin history with calm aggregates passes; ample history is judged by the sampled guards', async () => {
  const { freshHistoryCheck } = await import('../src/gate.js');
  assert.equal(freshHistoryCheck([], { chgM5: 10, chgH1: 40, mc: 50_000 }, NOW).pass, true);
  const samples = Array.from({ length: 12 }, (_, i) => ({ ts: NOW - (11 - i) * 60000, price: 1 }));
  const r = freshHistoryCheck(samples, { chgM5: 90, chgH1: 95, mc: 14_000 }, NOW);
  assert.equal(r.pass, true); assert.equal(r.judged, true);
});

// ---- Creator-veto volume bypass (user 2026-10-14, Eikon) ----
// Eikon was skipped at $53K purely on the creator gate (15.7% of supply, could pull
// 44.9% of pool SOL) while doing $39,103 of volume in 5 minutes; it then ran ~5.8x
// and the bot bought it at $307K and lost. The veto now lifts when 5m volume >=
// CREATOR_VOL_BYPASS_USD (default $25,000) and leaves a warning on the record.
// linkedDumpMaxDrain is raised in this fixture ONLY to isolate the creator gate:
// the same stack also drives linkedDump, which stays a hard gate on its own cap.
const eikonCfg = (over = {}, env = {}) => testCfg({ linkedDumpMaxDrain: 0.5, ...over }, env);
const EIKON_RUG = {
  token: { supply: 1e12, decimals: 6, mintAuthority: null, freezeAuthority: null },
  creatorBalance: 157_000_000_000, // 157,000 UI of a 1,000,000 UI supply = 15.7%
  totalHolders: 850,
  markets: [{ pubkey: 'POOL', lp: { base: 192_666, quote: 2_900, lpLockedUSD: 55_000, lpLockedPct: 100 } }],
  knownAccounts: { POOL: { type: 'AMM' } },
  topHolders: [
    { owner: 'POOL', address: 'p', amount: 192_666_000_000, pct: 19.3 },
    { owner: 'CREATOR', address: 'c', amount: 157_000_000_000, pct: 15.7 },
    { owner: 'h1', address: 'h1', amount: 40_000_000_000, pct: 4.0 },
    { owner: 'h2', address: 'h2', amount: 31_000_000_000, pct: 3.1 },
    { owner: 'h3', address: 'h3', amount: 22_000_000_000, pct: 2.2 },
    { owner: 'h4', address: 'h4', amount: 13_000_000_000, pct: 1.3 },
    { owner: 'h5', address: 'h5', amount: 7_000_000_000, pct: 0.7 },
  ],
  insiderNetworks: [],
};
const eikonView = (o = {}) => view({ address: '63A9mFGpX4Mws6TznZm4287P4vTsTxQ5NvcJPsbXpump', name: 'Eikon', symbol: 'EIKON', mc: 53_064, liq: 26_000, volM5: 39_103, volH1: 39_905, buysH1: 400, sellsH1: 237, chgH1: 30, createdAt: NOW - 3 * 3600e3, ...o });

test('creator bypass: Eikon fixture — 15.7% creator + $39,103/5m volume is NOT vetoed, warning attached', () => {
  const g = runGates({ view: eikonView(), rug: EIKON_RUG, cfg: eikonCfg(), now: NOW });
  assert.equal(g.checks.creator.pass, true);
  assert.equal(g.checks.creator.bypassed, true);
  assert.ok(!g.fails.some(f => f.startsWith('creator')), `creator fail leaked: ${g.fails}`);
  assert.ok(g.warnings.some(w => w === 'creator: holds 15.7% — veto bypassed by 5m volume $39,103 (>= $25,000)'), `warnings: ${g.warnings}`);
  assert.equal(g.pass, true);
});
test('creator bypass: volume exactly at the $25,000 bar also bypasses (>=)', () => {
  const g = runGates({ view: eikonView({ volM5: 25_000 }), rug: EIKON_RUG, cfg: eikonCfg(), now: NOW });
  assert.equal(g.checks.creator.pass, true);
  assert.equal(g.checks.creator.bypassed, true);
});
test('creator bypass: same creator stack with only $10,000/5m volume is still vetoed with the original reason', () => {
  const g = runGates({ view: eikonView({ volM5: 10_000 }), rug: EIKON_RUG, cfg: eikonCfg(), now: NOW });
  assert.equal(g.pass, false);
  assert.equal(g.checks.creator.pass, false);
  assert.match(g.fails.find(f => f.startsWith('creator')), /creator holds 15\.7% of supply, could pull 44\.9% of pool SOL/);
  assert.ok(!g.warnings.some(w => w.includes('veto bypassed')));
});
test('creator bypass: zero or missing 5m volume never bypasses', () => {
  const zero = runGates({ view: eikonView({ volM5: 0 }), rug: EIKON_RUG, cfg: eikonCfg(), now: NOW });
  assert.equal(zero.checks.creator.pass, false);
  const v = eikonView(); delete v.volM5;
  const missing = runGates({ view: v, rug: EIKON_RUG, cfg: eikonCfg(), now: NOW });
  assert.equal(missing.checks.creator.pass, false);
});
test('creator bypass: CREATOR_VOL_BYPASS_USD=0 disables the bypass (today\'s behavior); default is 25000', () => {
  const off = eikonCfg({}, { CREATOR_VOL_BYPASS_USD: '0' });
  assert.equal(off.creatorVolBypassUsd, 0);
  const g = runGates({ view: eikonView(), rug: EIKON_RUG, cfg: off, now: NOW });
  assert.equal(g.checks.creator.pass, false);
  assert.match(g.fails.find(f => f.startsWith('creator')), /could pull 44\.9% of pool SOL/);
  assert.equal(testCfg().creatorVolBypassUsd, 25000);
});
test('creator bypass: a small creator stack (5%) passes on its own at any volume, with no bypass warning', () => {
  const rug = {
    ...EIKON_RUG,
    creatorBalance: 50_000_000_000, // 5% of supply
    markets: [{ pubkey: 'POOL', lp: { base: 1_000_000, quote: 19_000, lpLockedUSD: 55_000, lpLockedPct: 100 } }],
    topHolders: EIKON_RUG.topHolders.map(h => h.owner === 'CREATOR' ? { ...h, amount: 50_000_000_000, pct: 5.0 } : h),
  };
  for (const volM5 of [0, 100_000]) {
    const g = runGates({ view: eikonView({ volM5 }), rug, cfg: eikonCfg(), now: NOW });
    assert.equal(g.checks.creator.pass, true);
    assert.equal(g.checks.creator.bypassed, undefined);
    assert.ok(!g.warnings.some(w => w.includes('veto bypassed')));
  }
});
test('creator bypass: negative CREATOR_VOL_BYPASS_USD is a config error', async () => {
  const { loadConfig, validateConfig } = await import('../src/config.js');
  const bad = { ...loadConfig({ DATA_DIR: tmp(), CREATOR_VOL_BYPASS_USD: '-5' }) };
  assert.ok(validateConfig(bad).some(e => e.includes('CREATOR_VOL_BYPASS_USD')));
});
