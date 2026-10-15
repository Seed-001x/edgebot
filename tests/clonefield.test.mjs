// Clone-field gate (user 2026-10-15, the Nihilism swarm): once a token NAME
// has a decided winner — an older, established same-name token that outweighs
// the candidate — follower clones of that name are skipped at the gate. The
// original Nihilism graduated and ran to $422k while the bot bought two fresh
// same-name clones that died in minutes. These tests pin the rule exactly:
// winner legs (graduated / liquidity / market cap), the age leg (unknown
// timestamps never qualify a rival), the biggest-token exemption, name
// normalization, the 180s per-name search cache (failures never cached), and
// the fail-open contract — plus the bot wiring (journal, stats, knob).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cloneFieldCheck, judgeCloneField, CLONE_FIELD_TTL_MS } from '../src/gate.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const MIN = 60000, H = 3600000;

// A raw DexScreener search pair.
const pair = ({ mint, name, dex = 'pumpfun', liq = 0, mc = null, createdAt = null, chain = 'solana' }) => ({
  chainId: chain, dexId: dex, pairAddress: 'PAIR_' + mint,
  baseToken: { address: mint, name, symbol: 'X' },
  liquidity: { usd: liq }, marketCap: mc, fdv: null, pairCreatedAt: createdAt,
});
// The candidate: a fresh Nihilism clone, 5 minutes old, $53,255 cap.
const cand = (over = {}) => ({ address: 'CAND', name: 'Nihilism', symbol: 'NIHILISM', mc: 53_255, createdAt: T0 - 5 * MIN, ...over });
// The winner: the original — graduated to PumpSwap, $422,522 cap, 14h old.
const winnerPair = (over = {}) => pair({ mint: 'WINNER', name: 'Nihilism', dex: 'pumpswap', liq: 28_982, mc: 422_522, createdAt: T0 - 14 * H, ...over });
const search = (pairs) => async () => ({ pairs });
const run = (v, pairs, over = {}) => cloneFieldCheck(v, { now: T0, searchImpl: search(pairs), cache: new Map(), ...over });

test('clonefield: winner present (older + graduated) blocks with the decided-name reason', async () => {
  const r = await run(cand(), [winnerPair(), pair({ mint: 'CAND', name: 'Nihilism', mc: 53_255, createdAt: T0 - 5 * MIN })]);
  assert.equal(r.pass, false);
  assert.match(r.reason, /^clone of decided name "Nihilism" — winner WINNER at \$422,522 mc vs this coin \$53,255$/);
  assert.equal(r.winnerMint, 'WINNER');
  assert.equal(r.winnerMc, 422_522);
  assert.equal(r.rivals, 1, 'the candidate\'s own pair is not a rival');
  assert.equal(r.lookupFailed, false);
});

test('clonefield: winner via the liquidity leg blocks (still on the curve, deep pool)', async () => {
  const r = await run(cand(), [winnerPair({ dex: 'pumpfun', liq: 36_000, mc: 300_000 })]);
  assert.equal(r.pass, false);
  assert.equal(r.winnerMint, 'WINNER');
});

test('clonefield: winner via the market-cap leg blocks (thin pool, not graduated, $150k+ cap)', async () => {
  const r = await run(cand(), [winnerPair({ dex: 'pumpfun', liq: 2_000, mc: 180_000 })]);
  assert.equal(r.pass, false);
  assert.equal(r.winnerMint, 'WINNER');
});

test('clonefield: candidate that is itself the biggest passes untouched', async () => {
  const r = await run(cand({ mc: 500_000 }), [winnerPair()]);
  assert.equal(r.pass, true);
  assert.match(r.reason, /biggest token of its name group/);
  assert.equal(r.winnerMint, null);
});

test('clonefield: rival older but candidate bigger passes', async () => {
  const r = await run(cand(), [winnerPair({ mc: 40_000, liq: 50_000 })]);
  assert.equal(r.pass, true, 'an established but smaller elder is no winner');
  assert.equal(r.winnerMint, null);
});

test('clonefield: younger rival never blocks, however big', async () => {
  const r = await run(cand(), [winnerPair({ createdAt: T0 - 1 * MIN, mc: 900_000 })]);
  assert.equal(r.pass, true);
  assert.equal(r.winnerMint, null);
});

test('clonefield: older but unestablished rival does not block (small pool, small cap, on curve)', async () => {
  const r = await run(cand(), [winnerPair({ dex: 'pumpfun', liq: 100, mc: 60_000 })]);
  assert.equal(r.pass, true);
  assert.equal(r.winnerMint, null);
});

test('clonefield: unknown pairCreatedAt disqualifies the rival — the mc leg alone is not enough', async () => {
  const r = await run(cand(), [winnerPair({ createdAt: null, mc: 900_000 })]);
  assert.equal(r.pass, true);
  assert.equal(r.winnerMint, null);
  const r2 = await run(cand({ createdAt: null }), [winnerPair()]);
  assert.equal(r2.pass, true, 'unknown candidate age also fails the age leg open');
});

test('clonefield: search failure passes open and reports lookupFailed (throw, null body, junk body)', async () => {
  for (const impl of [async () => { throw new Error('boom'); }, async () => null, async () => ({ pairs: 'junk' })]) {
    const r = await cloneFieldCheck(cand(), { now: T0, searchImpl: impl, cache: new Map() });
    assert.equal(r.pass, true);
    assert.equal(r.lookupFailed, true);
    assert.match(r.reason, /fail-open/);
  }
});

test('clonefield: name normalization — case and punctuation do not hide a winner', async () => {
  const r = await run(cand(), [winnerPair({ name: 'NIHILISM' })]);
  assert.equal(r.pass, false, 'NIHILISM vs Nihilism is the same name');
  const r2 = await run(cand({ name: 'Nihilism!' }), [winnerPair({ name: 'nihilism ' })]);
  assert.equal(r2.pass, false, 'punctuation/whitespace strip before comparison');
});

test('clonefield: own mint, other chains and other names are not rivals', async () => {
  const r = await run(cand(), [
    pair({ mint: 'CAND', name: 'Nihilism', dex: 'pumpswap', liq: 9e6, mc: 9e6, createdAt: T0 - 90 * H }),
    pair({ mint: 'ETH1', name: 'Nihilism', dex: 'uniswap', liq: 9e6, mc: 9e6, createdAt: T0 - 90 * H, chain: 'ethereum' }),
    pair({ mint: 'OTHER', name: 'Nihilism Coin', dex: 'pumpswap', liq: 9e6, mc: 9e6, createdAt: T0 - 90 * H }),
  ]);
  assert.equal(r.pass, true);
  assert.equal(r.rivals, 0);
  assert.match(r.reason, /no same-name rivals/);
});

test('clonefield: the strongest of several winners is the one journaled', async () => {
  const r = await run(cand(), [
    winnerPair({ mint: 'W_SMALL', mc: 200_000 }),
    winnerPair({ mint: 'W_BIG', mc: 800_000 }),
  ]);
  assert.equal(r.pass, false);
  assert.equal(r.winnerMint, 'W_BIG');
  assert.equal(r.rivals, 2);
});

test('clonefield: search results cache per name for 180s — a second candidate does not refetch', async () => {
  let calls = 0;
  const cache = new Map();
  const counting = async () => { calls++; return { pairs: [winnerPair()] }; };
  const a = await cloneFieldCheck(cand(), { now: T0, searchImpl: counting, cache });
  assert.equal(a.pass, false);
  const b = await cloneFieldCheck(cand({ address: 'CAND2' }), { now: T0 + 60_000, searchImpl: counting, cache });
  assert.equal(b.pass, false);
  assert.equal(calls, 1, 'second candidate inside the window rides the cache');
  const c = await cloneFieldCheck(cand({ address: 'CAND3' }), { now: T0 + CLONE_FIELD_TTL_MS + 1000, searchImpl: counting, cache });
  assert.equal(c.pass, false);
  assert.equal(calls, 2, 'after the TTL the field is re-read');
});

test('clonefield: failures are never cached — the next candidate retries the lookup', async () => {
  let calls = 0;
  const cache = new Map();
  const flaky = async () => { calls++; if (calls === 1) throw new Error('ds down'); return { pairs: [winnerPair()] }; };
  const a = await cloneFieldCheck(cand(), { now: T0, searchImpl: flaky, cache });
  assert.equal(a.pass, true); assert.equal(a.lookupFailed, true);
  const b = await cloneFieldCheck(cand({ address: 'CAND2' }), { now: T0 + 1000, searchImpl: flaky, cache });
  assert.equal(b.pass, false, 'the retry sees the winner and blocks');
  assert.equal(calls, 2);
});

test('clonefield: judgeCloneField is pure over the payload (grouping by token, earliest pair is the age)', () => {
  // The winner token shows TWO pairs: a young shallow one and its old deep one.
  // The token's age is its earliest pair; its weight is its deepest pair.
  const j = judgeCloneField(cand(), [
    pair({ mint: 'WINNER', name: 'Nihilism', dex: 'pumpfun', liq: 500, mc: 60_000, createdAt: T0 - 20 * MIN }),
    pair({ mint: 'WINNER', name: 'Nihilism', dex: 'pumpswap', liq: 28_982, mc: 422_522, createdAt: T0 - 2 * H }),
  ], {});
  assert.equal(j.rivals, 1, 'two pairs of one token are one rival');
  assert.equal(j.winner.mint, 'WINNER');
  assert.equal(j.winner.mc, 422_522);
});

// ---------------------------------------------------------------- bot wiring
const BT0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function rig(cfgOver = {}, searchImpl = null) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver });
  const clock = { t: BT0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const cfCache = new Map();
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug,
    cloneFieldCheck: (v, o) => cloneFieldCheck(v, { ...o, searchImpl, cache: cfCache }),
  });
  return { cfg, bot, clock };
}
const botCand = () => view({ name: 'Nihilism', symbol: 'NIHILISM', mc: 53_255, createdAt: BT0 - 5 * MIN });
const botWinnerBody = () => ({ pairs: [pair({ mint: 'WINNER', name: 'Nihilism', dex: 'pumpswap', liq: 28_982, mc: 422_522, createdAt: BT0 - 14 * H })] });

test('clonefield bot: a vamp is skipped at the gate with the verdict journaled and counted', async () => {
  const { bot } = rig({}, async () => botWinnerBody());
  await bot.start();
  await bot.onSignal(botCand(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(bot.positions.length, 0, 'no position opens');
  assert.equal(bot.stats.entries, 0);
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec, 'skip journaled');
  assert.ok(rec.reasons[0].startsWith('cloneField: clone of decided name'), JSON.stringify(rec.reasons));
  assert.equal(rec.gates.cloneField.pass, false);
  assert.equal(rec.gates.cloneField.winnerMint, 'WINNER');
  assert.equal(rec.gates.cloneField.winnerMc, 422_522);
  assert.equal(rec.gates.cloneField.rivals, 1);
  assert.deepEqual(rec.metrics.cloneField, { rivals: 1, winnerMint: 'WINNER', winnerMc: 422_522 });
  assert.equal(bot.stats.cloneField.blocked, 1);
  assert.equal(bot.stats.cloneField.lookupFailed, 0);
});

test('clonefield bot: a failed lookup passes the candidate open, counts once, and the shadow verdict carries it', async () => {
  const { cfg, bot } = rig({}, async () => { throw new Error('ds down'); });
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(BT0)); // stop the pipeline at the risk layer, freeze1b-style
  await bot.start();
  await bot.onSignal(botCand(), { setup: 'pop', strength: 1, metrics: {} });
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec, 'skip journaled (by risk, not by the clone gate)');
  assert.deepEqual(rec.reasons, ['risk: HALT file present'], 'the failed lookup did not block');
  assert.equal(bot.stats.cloneField.lookupFailed, 1, 'only the live evaluation counts');
  assert.equal(bot.stats.cloneField.blocked, 0);
  assert.ok(rec.shadowGates && rec.shadowGates.cloneField, 'shadow gate verdict carries the clone-field result');
  assert.equal(rec.shadowGates.cloneField.pass, true);
  assert.match(rec.shadowGates.cloneField.reason, /fail-open/);
});

test('clonefield bot: CLONE_FIELD=0 — the gate is never consulted', async () => {
  let calls = 0;
  const { cfg, bot } = rig({ cloneField: 0 }, async () => { calls++; return botWinnerBody(); });
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(BT0));
  await bot.start();
  await bot.onSignal(botCand(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(calls, 0, 'no search is made while the knob is off');
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec);
  assert.equal(rec.gates.cloneField, undefined);
  assert.equal(bot.stats.cloneField, undefined);
});
