import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor, impliedMove } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg } from './helpers.mjs';

const quote = (buyOut, sellOut) => async (i) => (i === SOL_MINT ? { outAmount: String(buyOut), priceImpactPct: '0.01' } : { outAmount: String(sellOut) });

test('shadow roundTrip prices spend vs sell-back', async () => {
  const ex = new Executor(testCfg(), { quote: quote(1_000_000, 19_000_000) });
  const rt = await ex.roundTrip('M', 0.02);
  assert.equal(rt.tokensOut, 1_000_000n); assert.ok(Math.abs(rt.ratio - 0.95) < 1e-9); assert.ok(Math.abs(rt.impactPct - 1) < 1e-9);
});
test('shadow buy/sell moves the simulated balance and never signs', async () => {
  const ex = new Executor(testCfg({ shadowStartSol: 1 }), { quote: quote(1_000_000, 30_000_000) });
  const f = await ex.buy('M', 0.02);
  assert.equal(f.simulated, true); assert.equal(f.sig, null); assert.ok(Math.abs((await ex.solBalance()) - 0.98) < 1e-9);
  const s = await ex.sell('M', f.tokensRaw);
  assert.ok(Math.abs(s.solOut - 0.03) < 1e-9); assert.ok(Math.abs((await ex.solBalance()) - 1.01) < 1e-9);
});
test('markValue is a live SELL quote; zero tokens = zero value', async () => {
  const ex = new Executor(testCfg(), { quote: quote(0, 25_000_000) });
  assert.ok(Math.abs(await ex.markValue('M', '1000') - 0.025) < 1e-9);
  assert.equal(await ex.markValue('M', '0'), 0);
});
test('no sell route → roundTrip throws (caller treats as do-not-trade)', async () => {
  const ex = new Executor(testCfg(), { quote: async (i) => { if (i === SOL_MINT) return { outAmount: '5' }; throw new Error('no route'); } });
  await assert.rejects(ex.roundTrip('M', 0.02), /no route/);
});
const hasSolana = await import('@solana/web3.js').then(() => true).catch(() => false);

test('real mode without a key fails closed', async () => {
  const ex = new Executor(testCfg({ realMode: true }), { env: {}, rpc: async () => ({ value: 0 }) });
  await assert.rejects(ex.solBalance(), /WALLET_PRIVATE_KEY not set/);
});
test('a malformed key is rejected without echoing it', { skip: !hasSolana && '@solana/web3.js not installed in this sandbox' }, async () => {
  const bad = new Executor(testCfg({ realMode: true }), { env: { WALLET_PRIVATE_KEY: 'SUPERSECRETNOTAKEY' }, rpc: async () => ({}) });
  await assert.rejects(bad.address(), (e) => /not a valid/.test(e.message) && !/SUPERSECRET/.test(e.message));
});

test('impliedMove: live quote at the decision price = no move', () => {
  // decision: $0.05/token, SOL at $200 -> 0.00025 SOL/token. 0.1 SOL buys 400 tokens (6 dp).
  const mv = impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: '400000000', sizeSol: 0.1, decimals: 6 });
  assert.ok(Math.abs(mv) < 1e-9);
});
test('impliedMove: NEVER case — quote 95% below decision price reads as a dump', () => {
  // decided at $49k MC price $0.049; live quote buys 20x the tokens per SOL -> price is 1/20th
  const mv = impliedMove({ decisionPriceUsd: 0.049, solUsd: 200, outAmountRaw: String(0.1 / (0.049 / 200) * 20 * 1e6), sizeSol: 0.1, decimals: 6 });
  assert.ok(mv < -0.9, `expected ~-0.95, got ${mv}`);
});
test('impliedMove: quote above decision price reads as a pump', () => {
  const mv = impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: '200000000', sizeSol: 0.1, decimals: 6 });
  assert.ok(Math.abs(mv - 1) < 1e-9); // half the tokens per SOL = price doubled
});
test('impliedMove: unusable inputs return null (guard falls open to the view check)', () => {
  assert.equal(impliedMove({ decisionPriceUsd: 0, solUsd: 200, outAmountRaw: '100', sizeSol: 0.1, decimals: 6 }), null);
  assert.equal(impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: '0', sizeSol: 0.1, decimals: 6 }), null);
  assert.equal(impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: undefined, sizeSol: 0.1, decimals: 6 }), null);
  assert.equal(impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: '100', sizeSol: 0.1, decimals: NaN }), null);
});
