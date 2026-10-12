// Fixture from the real "YouTube" token (HJQd…pump), 2026-10-12: curve bought out in one buy,
// wallet farm, ~17k trades/h averaging under $5, dumped -84% in 5 minutes ~18 min after launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGates, instantGradCheck, botFlowCheck, hasHardFail } from '../src/gate.js';
import { testCfg, view } from './helpers.mjs';

const cfg = testCfg();
const NOW = 1_000_000_000_000;

// State at the moment the bot bought (~2:17am, ~18 min old, ~$855k MC). Top-20 holders were still the
// big pre-dump stacks, so the identical-balance farm wallets were NOT visible yet — the old gates passed it.
const ytView = view({
  address: 'YT', name: 'YouTube', symbol: 'YouTube', mc: 855_000, liq: 77_000,
  volH1: 80_200, buysH1: 10_065, sellsH1: 7_329, buysM5: 900, sellsM5: 500,
  chgH1: 174, createdAt: NOW - 18 * 60000, dex: 'pumpswap',
});
const ytRug = {
  token: { supply: 995556913230934, decimals: 6, mintAuthority: null, freezeAuthority: null },
  creatorBalance: 0, totalHolders: 2610, insiderNetworks: null,
  markets: [{ pubkey: 'POOL', lp: { base: 50e6, quote: 340, lpLockedUSD: 77000, lpLockedPct: 100 } }],
  knownAccounts: { POOL: { type: 'AMM' } },
  topHolders: [
    { owner: 'POOL', address: 'p', amount: 50e12, pct: 5 },
    ...Array.from({ length: 12 }, (_, i) => ({ owner: 'b' + i, address: 'b' + i, amount: 2.4e13 - i * 1.7e12, pct: 2.4 - i * 0.17 })),
  ],
};
const ytCurve = { buys: 1, sells: 0 };

test('YouTube at entry: old gates alone would have passed it', () => {
  const g = runGates({ view: ytView, rug: ytRug, cfg: { ...cfg, instantGradMaxBuys: 0, botflowMaxAvgUsd: 0 }, now: NOW });
  assert.equal(g.pass, true, g.fails.join('; '));
});

test('YouTube at entry: blocked by instantGrad and botflow, both hard (cannot be forced)', () => {
  const g = runGates({ view: ytView, rug: ytRug, curve: ytCurve, cfg, now: NOW });
  const keys = g.fails.map(f => f.split(':')[0]);
  assert.ok(keys.includes('instantGrad'), keys.join(','));
  assert.ok(keys.includes('botflow'), keys.join(','));
  assert.equal(hasHardFail(g.fails), true);
});

test('healthy young runner passes the new gates', () => {
  const v = view({ mc: 600_000, liq: 90_000, volH1: 400_000, buysH1: 5_000, sellsH1: 3_500, createdAt: NOW - 40 * 60000 });
  assert.equal(instantGradCheck({ buys: 650, sells: 300 }, 40 / 60).pass, true);
  assert.equal(botFlowCheck(v, 40 / 60).pass, true); // ~$47 avg trade
});

test('new gates fail open and stay out of older coins', () => {
  assert.equal(instantGradCheck(null, 0.2).pass, true);              // no data → never blocks
  assert.equal(instantGradCheck({ buys: 0 }, 0.2).pass, true);       // empty data → never blocks
  assert.equal(instantGradCheck({ buys: 1 }, 30).pass, true);        // >24h old: 24h counts no longer cover the launch
  const busyOld = view({ volH1: 50_000, buysH1: 8_000, sellsH1: 6_000 });
  assert.equal(botFlowCheck(busyOld, 10).pass, true);                // 10h-old coin, small trades → untouched
});
