import test from 'node:test';
import assert from 'node:assert/strict';
import { runGates, cloneCheck } from '../src/gate.js';
import { testCfg, view } from './helpers.mjs';

const cfg = testCfg();
const NOW = 1_000_000_000_000;
const clones = (n, amount) => Array.from({ length: n }, (_, i) => ({ owner: 'w' + i, address: 'a' + i, amount, pct: 0.05 }));

// Fixtures rebuilt from the RugCheck / DexScreener numbers pulled for DOTF and QI.
const DOTF = {
  view: view({ address: 'DOTF', name: 'Digital Oil Trust Fund', symbol: 'DOTF', mc: 159_580_176, liq: 1_104_583, chgH1: 353145, createdAt: NOW - 11 * 60000, volH24: 544_087 }),
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
test('QI fixture is rejected, and flagged as a clone of the established coin', () => {
  const g = runGates({ view: QI.view, rug: QI.rug, others: [original], cfg, now: NOW });
  assert.equal(g.pass, false);
  const keys = g.fails.map(f => f.split(':')[0]);
  for (const k of ['clones', 'insiders', 'depth', 'vertical', 'clone']) assert.ok(keys.includes(k), `missing ${k} in ${keys}`);
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
test('clone check: same name but OLDER-and-smaller or unrelated coins are not flagged', () => {
  const v = view({ name: 'Quantum Inu', symbol: 'QI', createdAt: NOW - 3 * 3600e3, volH24: 9e6, liq: 1e6 });
  assert.equal(cloneCheck(v, [{ ...original, volH24: 1000, liq: 10 }], cfg).pass, true);   // original is smaller
  assert.equal(cloneCheck(v, [{ ...original, name: 'Totally Different', symbol: 'ZZZ' }], cfg).pass, true);
  assert.equal(cloneCheck(view({ name: 'Quantum Inu', symbol: 'QI', createdAt: NOW - 5 * 60000, volH24: 100, liq: 1000 }), [original], cfg).pass, false);
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

test('stalePopCheck: second-hump rollover vetoed, fresh pops pass (user 2026-10-13, SCI)', async () => {
  const { stalePopCheck } = await import('../src/gate.js');
  const now = 1_000_000_000_000;
  const S = (agoSec, price) => ({ ts: now - agoSec * 1000, price });
  const opts = { staleSec: 60, dropPct: 0.08 };
  // SCI shape: high 90s ago, price 20% below it -> stale
  const sci = [S(150, 60), S(120, 90), S(90, 118), S(60, 95), S(30, 100), S(5, 94)];
  assert.equal(stalePopCheck(sci, 94, now, opts).pass, false);
  // fresh spike: high is the current sample -> pass
  assert.equal(stalePopCheck([S(60, 50), S(30, 80), S(2, 118)], 118, now, opts).pass, true);
  // old high but barely rolled (3%) -> pass (reclaim/continuation)
  assert.equal(stalePopCheck([S(120, 100), S(90, 118), S(30, 112), S(5, 114)], 114, now, opts).pass, true);
  // recent high (30s old) even with a 12% dip -> pass (not yet stale)
  assert.equal(stalePopCheck([S(90, 80), S(30, 118), S(5, 104)], 104, now, opts).pass, true);
  // too few samples -> fail-open
  assert.equal(stalePopCheck([S(90, 118)], 90, now, opts).pass, true);
  assert.equal(stalePopCheck([], 90, now, opts).pass, true);
  // disabled
  assert.equal(stalePopCheck(sci, 94, now, { staleSec: 0, dropPct: 0.08 }).pass, true);
});
