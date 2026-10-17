// ALL SHADOW SIGNALS LIVE (owner order 2026-10-16: "Remove signals that are
// in shadow mode and make them all go live" — scope confirmed: trend + flow +
// confluence + dev-launch). Each flip routes its fires through the STANDARD
// live entry pipeline (same gates, risk, sizing, cooldown, slots, exits as
// pop); each carries a kill switch that restores the pre-flip behavior
// exactly: TREND_LIVE=0, FLOW_ALL_LIVE=0, CONFLUENCE_LIVE=0, DEVLAUNCH_LIVE=0.
// These tests pin, per flip: (a) a fire routes to a live taken-path attempt,
// (b) the kill switch restores shadow/record-only, (c) a guard/gate failure
// journals 'skipped' and does NOT buy. Flow test (d): yenni/poorgoat routing
// is unchanged. The pre-flip suites (shadowSetups, d1, shadowTrades,
// flowshadow) were re-pinned onto the kill switches, not rewritten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { WalletWatch, BASELINE } from '../src/walletWatch.js';
import { loadConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const YENNI = '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG';
const CHAIRMAN = 'Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6';
const POORGOAT = '8k1sAmVUjzaZkxqexeYkCPphjcQobYugQeGmCyvKtHNG';
const EIGHTDEJ = '8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6';
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const riggedRug = { ...healthyRug, topHolders: Array.from({ length: 18 }, (_, i) => ({ owner: 'w' + i, address: 'w' + i, amount: 498001881166, pct: 0.05 })) };

const flush = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

// Full-pipeline rig (flowshadow pattern): real Bot + real onSignal +
// scripted-quote Executor. Views served from a per-mint map.
function pipelineRig({ cfgOver = {}, env = {}, rug = healthyRug } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver }, env);
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => rug, searchByName: async () => [],
  });
  return { bot, clock, views };
}

// Routing rig: onSignal stubbed — pins what the wallet-live tap ROUTES,
// not the downstream gates (pinned in the pipeline tests + gate suites).
function routingRig(cfgOver = {}) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver });
  const clock = { t: T0 };
  const views = new Map();
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  const calls = [];
  bot.onSignal = async (v, sig) => { calls.push({ v, sig }); };
  return { bot, clock, views, calls };
}

const DEV_EV = { id: 'dev-1', kind: 'dev', sub: 'created', ts: T0, dev: 'DEV1', devName: 'mitch dev', mint: 'MINTD', symbol: 'DEVCOIN', launchTs: T0 - 30000, buyTs: T0, buySol: 2.5, mc: 500_000, viewPrice: 1 };
const CNF_EV = { id: 'cnf-1', kind: 'confluence', ts: T0, mint: 'MINTC', symbol: 'CNFCOIN', entryTs: T0, clusters: ['paper', 'multi'], entities: ['E1', 'E2'], names: ['paper', 'multi'], maxSol: 2, walletCount: 3, mc: 500_000, viewPrice: 1 };

// ------------------------------------------------------------ config
test('config: all four flips default LIVE; each kill switch turns only its own path off', () => {
  const d = loadConfig({});
  assert.equal(d.trendLive, true);
  assert.equal(d.flowAllLive, true);
  assert.equal(d.confluenceLive, true);
  assert.equal(d.devlaunchLive, true);
  assert.equal(loadConfig({ TREND_LIVE: '0' }).trendLive, false);
  assert.equal(loadConfig({ FLOW_ALL_LIVE: '0' }).flowAllLive, false);
  assert.equal(loadConfig({ CONFLUENCE_LIVE: '0' }).confluenceLive, false);
  assert.equal(loadConfig({ DEVLAUNCH_LIVE: '0' }).devlaunchLive, false);
  // The production env shape at flip time: TREND_SHADOW=1 set, roster set,
  // flip knobs unset — every path must come up LIVE from code defaults alone.
  const prod = loadConfig({ TREND_SHADOW: '1', TREND_ENABLED: '1', FLOW_LIVE_WALLETS: `${YENNI},${POORGOAT}` });
  assert.equal(prod.trendLive, true, 'trend live despite TREND_SHADOW=1');
  assert.equal(prod.flowAllLive, true, 'flow all-live despite the roster being set');
});

// ------------------------------------------------------------ 1. trend
test('trend (a): a trend signal routes live — taken, position opened, no shadow journal', async () => {
  const { bot, views } = pipelineRig();
  const v = view({ address: 'MINTT', symbol: 'TRENDT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 });
  views.set('MINTT', v);
  await bot.start();
  seedHistory(bot, 'MINTT');
  await bot.onSignal(v, { setup: 'trend', strength: 5.5, metrics: { chgH1: 55, chgM5: 4, buyRatioM5: 0.66, volH1: 250000 } });
  const rec = bot.journal.signals.find(s => s.setup === 'trend');
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].setup, 'trend');
  assert.equal(bot.stats.entries, 1);
  assert.equal(bot.stats.shadowSignals.trend || 0, 0, 'no shadow journaling for a live trend fire');
});

test('trend (b): TREND_LIVE=0 restores shadow routing exactly — journal shadow, no buy, no slot', async () => {
  const { bot, views } = pipelineRig({ cfgOver: { trendShadow: 1, trendLive: false } });
  const v = view({ address: 'MINTT', symbol: 'TRENDT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 });
  views.set('MINTT', v);
  await bot.start();
  seedHistory(bot, 'MINTT');
  await bot.onSignal(v, { setup: 'trend', strength: 5.5, metrics: { chgH1: 55, chgM5: 4, buyRatioM5: 0.66, volH1: 250000 } });
  const rec = bot.journal.signals.find(s => s.setup === 'trend');
  assert.equal(rec.decision, 'shadow');
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.stats.entries, 0);
  assert.equal(bot.stats.shadowSignals.trend, 1);
  // shadowedSetup unit surface: default cfg live, kill switch shadowed, liftoff untouched
  const { bot: b2 } = pipelineRig();
  assert.equal(b2.shadowedSetup('trend'), false);
  const { bot: b3 } = pipelineRig({ cfgOver: { trendLive: false } });
  assert.equal(b3.shadowedSetup('trend'), true);
});

test('trend (c): a gate failure on a live trend fire journals skipped and does not buy', async () => {
  const { bot, views } = pipelineRig({ rug: riggedRug });
  const v = view({ address: 'MINTT', symbol: 'TRENDT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 });
  views.set('MINTT', v);
  await bot.start();
  seedHistory(bot, 'MINTT');
  await bot.onSignal(v, { setup: 'trend', strength: 5.5, metrics: { chgH1: 55, chgM5: 4, buyRatioM5: 0.66, volH1: 250000 } });
  const rec = bot.journal.signals.find(s => s.setup === 'trend');
  assert.equal(rec.decision, 'skipped');
  assert.equal(rec.gatePass, false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.stats.entries, 0);
});

// ------------------------------------------------------------ 2. flow all-live
const soloAgg = (wallet, name, sol = 0.85) => ({ wallets: [wallet], maxSol: sol, count: 1, kind: 'solo', wallet, walletSol: sol, buyTs: T0, label: `flow: ${name} bought ${sol.toFixed(2)} SOL` });

function flowRig(env = { FLOW_LIVE_WALLETS: YENNI }) {
  const r = pipelineRig({ env });
  r.views.set('MINTF', view({ address: 'MINTF', symbol: 'FLOWT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  return r;
}
async function flowFire(bot, agg) {
  await bot.start();
  seedHistory(bot, 'MINTF');
  await bot._evalFlow('MINTF', agg);
  return bot.journal.signals.at(-1);
}

test('flow (a): non-roster solo (chairman) routes live under the default — taken, fires counted', async () => {
  const { bot } = flowRig();
  const s = await flowFire(bot, soloAgg(CHAIRMAN, 'chairman'));
  assert.equal(s.decision, 'taken', JSON.stringify(s.reasons));
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].setup, 'flow');
  assert.equal(bot.stats.flow.fires, 1);
  assert.equal(bot.stats.flow.shadow || 0, 0);
});

test('flow (a): size + confluence trigger kinds route live too — every tracked-wallet fire', async () => {
  const size = { wallets: [EIGHTDEJ], maxSol: 1.3, count: 1, kind: 'size', wallet: EIGHTDEJ, walletSol: 1.3, buyTs: T0, label: 'flow: 8deJ…XhU6 bought 1.30 SOL' };
  const { bot: b1 } = flowRig();
  const s1 = await flowFire(b1, size);
  assert.equal(s1.decision, 'taken', JSON.stringify(s1.reasons));
  const confl = { wallets: [EIGHTDEJ, CHAIRMAN], maxSol: 0.4, count: 2, kind: 'confluence', wallet: EIGHTDEJ, walletSol: 0.4, buyTs: T0, label: 'flow: 2 tracked wallets bought within 15m (max 0.40 SOL)' };
  const { bot: b2 } = flowRig();
  const s2 = await flowFire(b2, confl);
  assert.equal(s2.decision, 'taken', JSON.stringify(s2.reasons));
  assert.equal(b2.positions.length, 1);
});

test('flow (b): FLOW_ALL_LIVE=0 restores the roster exactly — chairman shadow, yenni live', async () => {
  const env = { FLOW_LIVE_WALLETS: YENNI, FLOW_ALL_LIVE: '0' };
  const { bot: b1 } = flowRig(env);
  const s1 = await flowFire(b1, soloAgg(CHAIRMAN, 'chairman'));
  assert.equal(s1.decision, 'shadow');
  assert.equal(b1.positions.length, 0);
  assert.equal(b1.stats.flow.shadow, 1);
  const { bot: b2 } = flowRig(env);
  const s2 = await flowFire(b2, soloAgg(YENNI, 'yenni'));
  assert.equal(s2.decision, 'taken', JSON.stringify(s2.reasons));
  // flowLiveTrigger unit surface under the kill switch = the pre-flip roster math
  assert.equal(b2.flowLiveTrigger({ kind: 'solo', wallet: YENNI }), true);
  assert.equal(b2.flowLiveTrigger({ kind: 'solo', wallet: CHAIRMAN }), false);
  assert.equal(b2.flowLiveTrigger({ kind: 'confluence', wallet: YENNI }), false);
  assert.equal(b2.flowLiveTrigger(null), false);
});

test('flow (d): yenni + poorgoat routing is unchanged by the flip (taken either way)', async () => {
  for (const env of [{ FLOW_LIVE_WALLETS: YENNI }, { FLOW_LIVE_WALLETS: `${YENNI},${POORGOAT}`, FLOW_ALL_LIVE: '0' }]) {
    const { bot } = flowRig(env);
    const s = await flowFire(bot, soloAgg(POORGOAT, 'poorgoat'));
    assert.equal(s.decision, 'taken', JSON.stringify(s.reasons));
    assert.equal(bot.positions.length, 1);
    assert.equal(bot.stats.flow.fires, 1);
  }
});

test('flow (c): a gate failure on an all-live flow fire journals skipped and does not buy', async () => {
  const r = pipelineRig({ env: { FLOW_LIVE_WALLETS: YENNI }, rug: riggedRug });
  r.views.set('MINTF', view({ address: 'MINTF', symbol: 'FLOWT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  await r.bot.start();
  seedHistory(r.bot, 'MINTF');
  await r.bot._evalFlow('MINTF', soloAgg(CHAIRMAN, 'chairman'));
  const s = r.bot.journal.signals.at(-1);
  assert.equal(s.decision, 'skipped');
  assert.equal(s.gatePass, false);
  assert.equal(r.bot.positions.length, 0);
});

// ------------------------------------------------------------ 3+4. wallet-event live (routing)
test('devlaunch (a): a dev event routes into onSignal as setup devlaunch, context carried', async () => {
  const { bot, views, calls } = routingRig();
  views.set('MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  bot._evalWalletLive(DEV_EV);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'devlaunch');
  assert.equal(calls[0].sig.strength, 2.5);
  assert.equal(calls[0].sig.metrics.devlaunch.devName, 'mitch dev');
  assert.equal(calls[0].sig.metrics.devlaunch.sub, 'created');
  assert.equal(calls[0].sig.metrics.devlaunch.eventId, 'dev-1');
  assert.match(calls[0].sig.label, /devlaunch: mitch dev/);
  assert.equal(bot.stats.walletLive.devlaunch.fires, 1);
  assert.equal(bot.lastSignal.get('MINTD'), T0);
});

test('confluence (a): a confluence event routes into onSignal as setup confluence, context carried', async () => {
  const { bot, views, calls } = routingRig();
  views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'confluence');
  assert.equal(calls[0].sig.strength, 2);
  assert.deepEqual(calls[0].sig.metrics.confluence.clusters, ['paper', 'multi']);
  assert.equal(calls[0].sig.metrics.confluence.walletCount, 3);
  assert.equal(bot.stats.walletLive.confluence.fires, 1);
});

test('wallet-live (b): each kill switch silences only its own kind — the other still routes', async () => {
  const r1 = routingRig({ devlaunchLive: false });
  r1.views.set('MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN' }));
  r1.views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN' }));
  r1.bot._evalWalletLive(DEV_EV);
  r1.bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(r1.calls.length, 1);
  assert.equal(r1.calls[0].sig.setup, 'confluence');
  assert.equal(r1.bot.stats.walletLive.devlaunch.evals, 0, 'devlaunch never even evaluated');

  const r2 = routingRig({ confluenceLive: false });
  r2.views.set('MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN' }));
  r2.views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN' }));
  r2.bot._evalWalletLive(DEV_EV);
  r2.bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(r2.calls.length, 1);
  assert.equal(r2.calls[0].sig.setup, 'devlaunch');
  assert.equal(r2.bot.stats.walletLive.confluence.evals, 0, 'confluence never even evaluated');
});

test('wallet-live (c): eligible() floor failure journals skipped with the reason — no buy routed', async () => {
  const { bot, views, calls } = routingRig();
  views.set('MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN', mc: 100, liq: 10 })); // under MIN_MC + liq floors
  bot._evalWalletLive(DEV_EV);
  await flush();
  assert.equal(calls.length, 0);
  const rec = bot.journal.signals.find(s => s.setup === 'devlaunch');
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r.startsWith('devlaunch-live:')), JSON.stringify(rec.reasons));
  assert.equal(bot.stats.walletLive.devlaunch.skipped, 1);
});

test('wallet-live (c): already-held and in-cooldown mints journal skipped — no buy routed', async () => {
  const r1 = routingRig();
  r1.views.set('MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN', mc: 500_000, liq: 100_000 }));
  r1.bot.positions.push({ mint: 'MINTD', symbol: 'DEVCOIN' });
  r1.bot._evalWalletLive(DEV_EV);
  await flush();
  assert.equal(r1.calls.length, 0);
  assert.equal(r1.bot.journal.signals.at(-1).decision, 'skipped');
  assert.match(r1.bot.journal.signals.at(-1).reasons.join(' '), /already holding/);

  const r2 = routingRig();
  r2.views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN', mc: 500_000, liq: 100_000 }));
  r2.bot.lastSignal.set('MINTC', T0 - 60000); // signaled 1m ago — inside the cooldown
  r2.bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(r2.calls.length, 0);
  assert.equal(r2.bot.journal.signals.at(-1).decision, 'skipped');
  assert.match(r2.bot.journal.signals.at(-1).reasons.join(' '), /already signaled/);
});

test('wallet-live: no view at fire time queues a retry — a late view still routes; expiry journals skipped', async () => {
  const { bot, clock, views, calls } = routingRig();
  bot._evalWalletLive(DEV_EV); // MINTD has no view yet
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.walletPending.size, 1);
  assert.equal(bot.stats.walletLive.devlaunch.noView, 1);
  clock.t += 60000;
  views.set('MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  await bot._walletRetryTick(clock.t);
  await flush();
  assert.equal(calls.length, 1, 'the retried eval routes once a view exists');
  assert.equal(bot.walletPending.size, 0);

  const r2 = routingRig();
  r2.bot._evalWalletLive(CNF_EV); // MINTC never gets a view
  await flush();
  r2.clock.t += 6 * 60000; // past the 5m retry window
  await r2.bot._walletRetryTick(r2.clock.t);
  assert.equal(r2.calls.length, 0);
  assert.equal(r2.bot.stats.walletLive.confluence.noViewFinal, 1);
  const rec = r2.bot.journal.signals.find(s => s.setup === 'confluence');
  assert.equal(rec.decision, 'skipped');
  assert.match(rec.reasons.join(' '), /no market view within 5m/);
});

// ------------------------------------------------------------ 3+4. wallet-event live (full pipeline)
test('devlaunch (a) full pipeline: event opens a real position under setup devlaunch', async () => {
  const { bot, views } = pipelineRig();
  views.set('MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  await bot.start();
  seedHistory(bot, 'MINTD');
  bot._evalWalletLive(DEV_EV);
  await flush(20);
  const rec = bot.journal.signals.find(s => s.setup === 'devlaunch');
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].setup, 'devlaunch');
  assert.equal(bot.stats.walletLive.devlaunch.fires, 1);
});

test('confluence (a) full pipeline: event opens a real position under setup confluence', async () => {
  const { bot, views } = pipelineRig();
  views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  await bot.start();
  seedHistory(bot, 'MINTC');
  bot._evalWalletLive(CNF_EV);
  await flush(20);
  const rec = bot.journal.signals.find(s => s.setup === 'confluence');
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].setup, 'confluence');
});

test('devlaunch (c) full pipeline: a gate failure journals skipped and does not buy', async () => {
  const { bot, views } = pipelineRig({ rug: riggedRug });
  views.set('MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  await bot.start();
  seedHistory(bot, 'MINTD');
  bot._evalWalletLive(DEV_EV);
  await flush(20);
  const rec = bot.journal.signals.find(s => s.setup === 'devlaunch');
  assert.equal(rec.decision, 'skipped');
  assert.equal(rec.gatePass, false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.stats.entries, 0);
});

// ------------------------------------------------------------ walletWatch seam
const WW_SETS = {
  baseline: BASELINE,
  devs: [{ address: 'DEV1', name: 'mitch dev' }],
  survivors: [
    { entity: 'E1', name: 'paper', cluster: 'paper', wallets: ['W1'] },
    { entity: 'E2', name: 'multi', cluster: 'multi', wallets: ['W2', 'W3'] },
  ],
};

function watchRig(over = {}) {
  const cfg = testCfg({});
  const clock = { t: T0 };
  const views = new Map([['MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN', pairAddress: 'POOL1' })], ['MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN', pairAddress: 'POOL2' })]]);
  const ww = new WalletWatch({
    cfg, dir: tmp(), now: () => clock.t, sets: WW_SETS,
    rpcFn: async () => [],
    fetchViews: async (ms) => new Map(ms.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchCoin: async () => ({ creator: 'DEV1', createdTs: T0 - 30000, symbol: 'DEVCOIN' }),
    fetchCandles: async () => [],
    shadowGates: async () => ({ gates: {}, gatePass: true }),
    log: () => {},
    ...over,
  });
  return { ww, clock };
}

test('walletwatch seam: a dev-launch event fires liveEval with the journaled event; the event record is unchanged', async () => {
  const seen = [];
  const { ww } = watchRig({ liveEval: (ev) => seen.push(ev) });
  await ww.onDevBuy('DEV1', { mint: 'MINTD', sol: 2.5 }, T0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'dev');
  assert.equal(seen[0].mint, 'MINTD');
  assert.equal(seen[0], [...ww.events.values()][0], 'the tap receives the journaled event itself');
});

test('walletwatch seam: a confluence event fires liveEval; without the dep the module is byte-identical record-only', async () => {
  const seen = [];
  const { ww } = watchRig({ liveEval: (ev) => seen.push(ev) });
  ww.onSurvivorBuy('W1', { mint: 'MINTC', sol: 1 }, T0);
  ww.onSurvivorBuy('W2', { mint: 'MINTC', sol: 2 }, T0 + 60000);
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'confluence');
  assert.equal(seen[0].mint, 'MINTC');

  const plain = watchRig(); // no liveEval dep — pre-flip behavior
  await plain.ww.onDevBuy('DEV1', { mint: 'MINTD', sol: 2.5 }, T0);
  assert.equal(plain.ww.events.size, 1);
  assert.equal(plain.ww.liveEval, null);
});

test('walletwatch seam: /devwatch snapshot stamps the live routing state from cfg', () => {
  const { ww } = watchRig();
  assert.deepEqual(ww.snapshot().liveRouting, { devlaunch: true, confluence: true });
  const off = new WalletWatch({
    cfg: testCfg({}, { DEVLAUNCH_LIVE: '0', CONFLUENCE_LIVE: '0' }), dir: tmp(), now: () => T0, sets: WW_SETS,
    rpcFn: async () => [], fetchViews: async () => new Map(), fetchCoin: async () => null, fetchCandles: async () => [], log: () => {},
  });
  assert.deepEqual(off.snapshot().liveRouting, { devlaunch: false, confluence: false });
});

test('bot wiring: the Bot passes its live tap into WalletWatch', () => {
  const { bot } = routingRig();
  assert.equal(typeof bot.walletWatch.liveEval, 'function');
});
