// Graduation watch (user 2026-10-14): fresh pump.fun graduations were invisible —
// Plois graduated 2026-10-14T05:18:08Z and ran +41% in 5m while the bot had never
// seen the mint (graduated/new /reallists lists arrive empty; the scrape is 3-hourly).
// Fixtures use Plois's REAL numbers: created 04:29:28Z (49m on the curve),
// graduated 05:18:08Z, $90.5K mc when next observed, still trading minutes later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GradWatch, freshGraduations } from '../src/gradWatch.js';
import { selectView } from '../src/sources.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const PLOIS = '3a59FjtCPyDbz6UWKR3kixUiZSYbLTK7bw3QoCNmpump';
const OTHER = 'MintYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';
const NOW = 1_800_000_000_000;

// Recorded-shape v3 coin row (fields as the live API returns them).
const coin = (o = {}) => ({
  mint: PLOIS, symbol: 'Plois', name: 'Plois.World', complete: true, is_banned: false,
  created_timestamp: NOW - 51 * 60000,           // Plois: 49m on the curve before graduating
  last_trade_timestamp: NOW - 2 * 60000,        // still trading 2m ago
  usd_market_cap: 90541, market_cap: 845, real_sol_reserves: 0,
  pump_swap_pool: '6aSjRDBMkaoCaxqjgi4caYdfL5F3395w3pipQ1EUx9dN', ...o,
});

// ---- freshGraduations: the pure freshness/transition filter ----
test('grad: a fresh completed coin (Plois shape) is yielded', () => {
  assert.deepEqual(freshGraduations([coin()], testCfg(), NOW, new Set()), [PLOIS]);
});

test('grad: a completed coin whose last trade is older than GRAD_FRESH_MIN is not yielded', () => {
  const stale = coin({ created_timestamp: NOW - 90 * 60000, last_trade_timestamp: NOW - 45 * 60000 });
  assert.deepEqual(freshGraduations([stale], testCfg(), NOW, new Set()), []);
});

test('grad: a not-complete coin is not yielded, however fresh', () => {
  assert.deepEqual(freshGraduations([coin({ complete: false })], testCfg(), NOW, new Set()), []);
});

test('grad: banned and already-seen completions are not yielded', () => {
  assert.deepEqual(freshGraduations([coin({ is_banned: true })], testCfg(), NOW, new Set()), []);
  assert.deepEqual(freshGraduations([coin()], testCfg(), NOW, new Set([PLOIS])), []);
});

test('grad: malformed rows are skipped without throwing', () => {
  const rows = [null, {}, { mint: 'not base58!!', complete: true }, coin({ mint: OTHER })];
  assert.deepEqual(freshGraduations(rows, testCfg(), NOW, new Set()), [OTHER]);
});

// ---- GradWatch poller: priming watermark, transitions, fail-open ----
// These two pin GRAD_BACKFILL_MAX=0 (pure priming): their fixture coin is FRESH,
// so under the default backfill it would be added at prime time — the backfill
// block below covers that; here the watermark/transition mechanics are the point.
function gradRig(rowQueue, cfgOver = {}) {
  const added = [];
  const gw = new GradWatch({
    cfg: testCfg(cfgOver), now: () => NOW, log: () => {},
    onAdd: (m) => { added.push(m); return true; },
    fetchRows: async () => { const r = rowQueue.shift(); if (r instanceof Error) throw r; return r; },
  });
  return { gw, added };
}

test('grad: first poll primes the watermark and adds nothing; a NEW completion on the next poll is added once', async () => {
  const { gw, added } = gradRig([
    [coin()],                                   // poll 1: prime — Plois predates boot as far as we know
    [coin(), coin({ mint: OTHER })],            // poll 2: OTHER is a first-observed completion
    [coin(), coin({ mint: OTHER })],            // poll 3: OTHER already absorbed — no re-add
  ], { gradBackfillMax: 0 });
  await gw.poll(); assert.deepEqual(added, []);
  await gw.poll(); assert.deepEqual(added, [OTHER]);
  await gw.poll(); assert.deepEqual(added, [OTHER]);
  assert.equal(gw.stats.polls, 3); assert.equal(gw.stats.added, 1);
});

test('grad: poll failure never throws, adds nothing, and does not prime', async () => {
  const { gw, added } = gradRig([
    new Error('HTTP 429'),                      // poll 1 fails
    null,                                       // poll 2: malformed payload
    [coin()],                                   // poll 3: first SUCCESS primes (still no adds)
    [coin(), coin({ mint: OTHER })],           // poll 4: transition fires
  ], { gradBackfillMax: 0 });
  await gw.poll(); assert.deepEqual(added, []); assert.ok(gw.stats.lastError);
  await gw.poll(); assert.deepEqual(added, []); assert.equal(gw.primed, false);
  await gw.poll(); assert.deepEqual(added, []); assert.equal(gw.primed, true);
  await gw.poll(); assert.deepEqual(added, [OTHER]);
});

// ---- boot backfill (user 2026-10-14: "Add the boot backfill") ----
// UNTXED graduated 01:28 EDT while the watcher booted 01:39 — pure priming filed
// it as history and it stayed invisible until gainers discovery rotated it in.
const mintN = (i) => ('BF' + 'x'.repeat(36) + String(i + 1)).slice(0, 40); // valid base58, distinct per i

test('backfill: prime poll adds a still-fresh completion through onAdd and marks it seen', async () => {
  const { gw, added } = gradRig([
    [coin()],                                   // poll 1 (prime): Plois last traded 2m ago — fresh
    [coin()],                                   // poll 2: already seen — never re-added
  ]);
  await gw.poll(); assert.deepEqual(added, [PLOIS]);
  assert.equal(gw.stats.backfilled, 1); assert.equal(gw.stats.added, 1);
  assert.ok(gw.seenComplete.has(PLOIS));
  await gw.poll(); assert.deepEqual(added, [PLOIS]);
});

test('backfill: prime poll absorbs a stale completion without adding, and later polls never add it', async () => {
  const stale = coin({ created_timestamp: NOW - 4 * 3600e3, last_trade_timestamp: NOW - 3 * 3600e3 });
  const { gw, added } = gradRig([
    [stale],                                    // poll 1 (prime): last trade 3h ago — history
    [stale],                                    // poll 2: seen at prime AND stale — no add
  ]);
  await gw.poll(); assert.deepEqual(added, []);
  assert.equal(gw.stats.backfilled, 0);
  assert.ok(gw.seenComplete.has(PLOIS), 'stale completion is still marked seen');
  await gw.poll(); assert.deepEqual(added, []);
});

test('backfill: prime adds are capped at GRAD_BACKFILL_MAX, freshest first; overflow is seen-not-added', async () => {
  const rows = [0, 1, 2, 3, 4, 5].map(i => coin({ mint: mintN(i), last_trade_timestamp: NOW - (i + 1) * 60000 })); // freshest first, as the API returns
  const { gw, added } = gradRig([
    rows,                                       // poll 1 (prime): 6 fresh completions, cap 3
    rows,                                       // poll 2: everything already seen — no late adds
  ], { gradBackfillMax: 3 });
  await gw.poll();
  assert.deepEqual(added, [mintN(0), mintN(1), mintN(2)]);
  assert.equal(gw.stats.backfilled, 3); assert.equal(gw.stats.added, 3);
  for (let i = 0; i < 6; i++) assert.ok(gw.seenComplete.has(mintN(i)), `mint ${i} marked seen`);
  await gw.poll(); assert.deepEqual(added, [mintN(0), mintN(1), mintN(2)]);
});

test('backfill: GRAD_BACKFILL_MAX=0 is pure priming — a fresh completion at prime is NOT added', async () => {
  const { gw, added } = gradRig([
    [coin()],                                   // poll 1 (prime): fresh, but backfill is off
  ], { gradBackfillMax: 0 });
  await gw.poll(); assert.deepEqual(added, []);
  assert.equal(gw.stats.backfilled, 0);
  assert.ok(gw.seenComplete.has(PLOIS));
});

test('backfill: a failed prime poll marks nothing seen and adds nothing; the next success still backfills', async () => {
  const { gw, added } = gradRig([
    new Error('HTTP 429'),                      // poll 1 fails — must not prime
    [coin()],                                   // poll 2: first SUCCESS primes + backfills
  ]);
  await gw.poll(); assert.deepEqual(added, []); assert.ok(gw.stats.lastError);
  assert.equal(gw.primed, false); assert.equal(gw.seenComplete.size, 0);
  await gw.poll(); assert.deepEqual(added, [PLOIS]);
  assert.equal(gw.stats.backfilled, 1);
});

test('backfill: Plois-shaped — graduated minutes before boot, still trading — is backfilled on prime', async () => {
  // The v3 payload has no graduation stamp; the observable shape of "graduated
  // 11m before boot and ran" is: long curve life, complete, last trade 1m ago.
  // (UNTXED's real shape: graduated 01:28 EDT, watcher booted 01:39.)
  const justGraduated = coin({ created_timestamp: NOW - 60 * 60000, last_trade_timestamp: NOW - 1 * 60000 });
  const { gw, added } = gradRig([[justGraduated]]);
  await gw.poll(); assert.deepEqual(added, [PLOIS]);
  assert.equal(gw.stats.backfilled, 1);
});

// ---- selectView: the corpse-pair trap ----
// DexScreener pair shape, trimmed to the fields viewOf/selectView read.
const pair = (o = {}) => ({
  chainId: 'solana', dexId: 'pumpswap', pairAddress: 'PAIR', baseToken: { address: PLOIS, symbol: 'Plois', name: 'Plois.World' },
  priceUsd: '0.00009', marketCap: 90541, fdv: 90541, liquidity: { usd: 20000 },
  volume: { m5: 30000, h1: 60000 }, txns: { m5: { buys: 406, sells: 258 }, h1: { buys: 618, sells: 402 } },
  priceChange: { m5: 41, h1: 65 }, pairCreatedAt: NOW - 13 * 60000, ...o,
});

test('grad view: a LIVE PumpSwap pair beats the higher-liquidity corpse curve pair', () => {
  const corpse = pair({ dexId: 'pumpfun', pairAddress: 'CURVE', liquidity: { usd: 60000 }, txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 618, sells: 402 } } });
  const live = pair({ dexId: 'pumpswap', pairAddress: 'AMM', liquidity: { usd: 20000 } });
  const v = selectView([corpse, live]);
  assert.equal(v.dex, 'pumpswap'); assert.equal(v.pairAddress, 'AMM'); assert.equal(v.liq, 20000);
});

test('grad view: a DEAD amm pair never displaces a live curve pair', () => {
  const curve = pair({ dexId: 'pumpfun', pairAddress: 'CURVE', liquidity: { usd: 95000 }, txns: { m5: { buys: 100, sells: 50 }, h1: { buys: 300, sells: 200 } } });
  const deadAmm = pair({ dexId: 'pumpswap', pairAddress: 'AMM', liquidity: { usd: 90000 }, txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 } } });
  const v = selectView([curve, deadAmm]);
  assert.equal(v.dex, 'pumpfun'); assert.equal(v.pairAddress, 'CURVE');
});

test('grad view: curve-only and amm-only selections are unchanged', () => {
  assert.equal(selectView([pair({ dexId: 'pumpfun' })]).dex, 'pumpfun');
  assert.equal(selectView([pair({ dexId: 'pumpswap' })]).dex, 'pumpswap');
  assert.equal(selectView([]), null);
});

// ---- graduation handoff: watched coin flips curve → AMM, TTL refreshes ----
const T0 = 1_000_000_000_000;
function handoffRig() {
  const cfg = testCfg();
  const clock = { t: T0 };
  const market = { dex: 'pumpfun' };
  let discoverOn = true;
  const exec = new Executor(cfg, { quote: async (input) => (input === SOL_MINT ? { outAmount: '1000000000', priceImpactPct: '0.01' } : { outAmount: '0' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(discoverOn ? new Map([['MINT1', 'test']]) : new Map(), { counts: {} }),
    fetchViews: async () => new Map([['MINT1', view({ dex: market.dex, price: 1, mc: 60000, volM5: 0, volH1: 0, buysM5: 0, sellsM5: 0, chgM5: 0, chgH1: 0, createdAt: T0 - 3600e3 })]]),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  return { bot, clock, market, setDiscover: (on) => { discoverOn = on; } };
}

test('handoff: a watched coin that graduates gets a fresh TTL from the flip and survives the prune', async () => {
  const r = handoffRig();
  await r.bot.start();
  await r.bot.discoverTick();                       // MINT1 watched at T0, on the curve
  await r.bot.pollTick();                            // curve view seen
  r.clock.t += 15 * 60000;                           // 15m pass on the curve (TTL is 20m)
  r.market.dex = 'pumpswap';                         // it graduates
  await r.bot.pollTick();                            // the flip
  assert.equal(r.bot.watch.get('MINT1').ts, r.clock.t, 'watch entry refreshed at graduation');
  assert.equal(r.bot.stats.gradHandoffs, 1);
  r.setDiscover(false);
  r.clock.t += 15 * 60000;                           // 30m since first watch — dead without the refresh
  await r.bot.discoverTick();
  assert.ok(r.bot.watch.has('MINT1'), 'refreshed entry survives the TTL prune');
});

test('handoff: the flip is one-shot, and a coin never seen on the curve gets no refresh', async () => {
  const r = handoffRig();
  await r.bot.start();
  await r.bot.discoverTick();
  await r.bot.pollTick();                            // curve
  r.market.dex = 'pumpswap';
  await r.bot.pollTick();                            // flip → refreshed once
  assert.equal(r.bot.stats.gradHandoffs, 1);
  r.bot.watch.set('MINT1', { ts: T0, source: 'test' }); // age the entry by hand
  await r.bot.pollTick();                            // still pumpswap — no second refresh
  assert.equal(r.bot.watch.get('MINT1').ts, T0);
  assert.equal(r.bot.stats.gradHandoffs, 1);

  const r2 = handoffRig();
  await r2.bot.start();
  await r2.bot.discoverTick();
  r2.market.dex = 'pumpswap';                        // first-ever view is already graduated
  await r2.bot.pollTick();
  assert.equal(r2.bot.stats.gradHandoffs || 0, 0);
  assert.equal(r2.bot.watch.get('MINT1').ts, T0);
});

// ---- config knobs ----
test('grad config: defaults, env override, and validation', () => {
  const d = loadConfig({});
  assert.equal(d.gradWatchEnabled, true); assert.equal(d.gradPollSec, 120); assert.equal(d.gradFreshMin, 30);
  assert.equal(d.gradBackfillMax, 50);
  assert.equal(loadConfig({ GRAD_WATCH_ENABLED: '0' }).gradWatchEnabled, false);
  assert.equal(loadConfig({ GRAD_POLL_SEC: '180' }).gradPollSec, 180);
  assert.equal(loadConfig({ GRAD_BACKFILL_MAX: '10' }).gradBackfillMax, 10);
  assert.equal(loadConfig({ GRAD_BACKFILL_MAX: '0' }).gradBackfillMax, 0);
  assert.ok(validateConfig(loadConfig({ GRAD_POLL_SEC: '10' })).some(e => e.includes('GRAD_POLL_SEC')));
  assert.ok(validateConfig(loadConfig({ GRAD_FRESH_MIN: '0' })).some(e => e.includes('GRAD_FRESH_MIN')));
  assert.ok(validateConfig(loadConfig({ GRAD_BACKFILL_MAX: '-1' })).some(e => e.includes('GRAD_BACKFILL_MAX')));
  assert.deepEqual(validateConfig(d), []);
});
