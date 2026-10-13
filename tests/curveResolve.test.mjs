import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurve } from '../src/sources.js';

const NOW = 1_800_000_000_000;
const cfg = { rpcUrls: ['http://rpc'], instantGradMaxBuys: 5 };
const pair = (dexId, extra = {}) => ({ dexId, txns: { h24: { buys: 0, sells: 0 } }, ...extra });
const freshAmm = () => pair('pumpswap', { pairCreatedAt: NOW - 3 * 60000 });
const oldAmm = () => pair('pumpswap', { pairCreatedAt: NOW - 48 * 3600000 });

test('CATBOT regression: fresh grad, DexScreener shows bundled count 12 — chain truth (3) wins', async () => {
  const curve = pair('pumpfun', { txns: { h24: { buys: 12, sells: 0 } } });
  const chain = async () => ({ buys: 3, buyIxs: 12, sells: 0, source: 'chain' });
  const out = await resolveCurve([curve, freshAmm()], cfg, chain, NOW);
  assert.equal(out.buys, 3);
  assert.equal(out.source, 'chain');
});

test('fresh grad, chain unavailable — DexScreener count is the fallback', async () => {
  const curve = pair('pumpfun', { txns: { h24: { buys: 40, sells: 2 } } });
  const out = await resolveCurve([curve, freshAmm()], cfg, async () => null, NOW);
  assert.deepEqual(out, { buys: 40, sells: 2 });
});

test('old graduation — chain is never consulted', async () => {
  let called = false;
  const curve = pair('pumpfun', { txns: { h24: { buys: 9, sells: 0 } } });
  const out = await resolveCurve([curve, oldAmm()], cfg, async () => { called = true; return { buys: 1 }; }, NOW);
  assert.equal(called, false);
  assert.equal(out.buys, 9);
});

test('AMM pair not indexed yet (indexer lag) — chain still judges', async () => {
  const curve = pair('pumpfun');
  const out = await resolveCurve([curve], cfg, async () => ({ buys: 2, buyIxs: 9, sells: 0, source: 'chain' }), NOW);
  assert.equal(out.buys, 2);
});

test('no pairs at all — unknown, fail-open', async () => {
  assert.equal(await resolveCurve([], cfg, async () => ({ buys: 1 }), NOW), null);
  assert.equal(await resolveCurve(null, cfg, null, NOW), null);
});
