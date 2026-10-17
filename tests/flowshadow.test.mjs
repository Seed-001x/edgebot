// Flow shadow-only split (user 2026-10-15, freeze carve-out): with
// FLOW_LIVE_WALLETS set (live store: yenni + poorgoat), only a SOLO trigger fired
// by a listed wallet may enter live — through exactly the same guards, gates
// and checks every flow trigger faces today. Every other flow trigger (the
// other solos, roster size triggers, confluence) journals as decision
// 'shadow' instead — detected, labelled, outcome-tracked, never bought —
// the trend/liftoff treatment. Knob unset = legacy: all triggers live.
// These tests pin the routing; the gates themselves are pinned elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
// The real flow universe (live env, 2026-10-15): solos + roster. Live-exempt
// set: yenni + poorgoat (poorgoat holds solo status exactly like yenni).
const YENNI = '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG';
const CHAIRMAN = 'Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6';
const POORGOAT = '8k1sAmVUjzaZkxqexeYkCPphjcQobYugQeGmCyvKtHNG';
const EIGHTDEJ = '8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6'; // roster, record-only
const LIVE_PAIR = `${YENNI},${POORGOAT}`;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

const soloAgg = (wallet, name, sol = 0.85) => ({ wallets: [wallet], maxSol: sol, count: 1, kind: 'solo', wallet, walletSol: sol, buyTs: T0, label: `flow: ${name} bought ${sol.toFixed(2)} SOL` });
const YENNI_AGG = soloAgg(YENNI, 'yenni');
const CHAIRMAN_AGG = soloAgg(CHAIRMAN, 'chairman');
const POORGOAT_AGG = soloAgg(POORGOAT, 'poorgoat');
const SIZE_AGG = { wallets: [EIGHTDEJ], maxSol: 1.3, count: 1, kind: 'size', wallet: EIGHTDEJ, walletSol: 1.3, buyTs: T0, label: 'flow: 8deJ…XhU6 bought 1.30 SOL' };
const CONFL_AGG = { wallets: [EIGHTDEJ, CHAIRMAN], maxSol: 0.4, count: 2, kind: 'confluence', wallet: EIGHTDEJ, walletSol: 0.4, buyTs: T0, label: 'flow: 2 tracked wallets bought within 15m (max 0.40 SOL)' };
const CONFL_YENNI_AGG = { wallets: [YENNI, EIGHTDEJ], maxSol: 0.4, count: 2, kind: 'confluence', wallet: YENNI, walletSol: 0.4, buyTs: T0, label: 'flow: 2 tracked wallets bought within 15m (max 0.40 SOL)' };

// Full-pipeline rig (flowsnapshot pattern): real Bot + scripted-quote
// Executor. env carries FLOW_LIVE_WALLETS unless liveEnv says otherwise.
// FLOW_ALL_LIVE:'0' pins the roster mode these tests were written against
// (owner flip 2026-10-16 made all-live the default; the kill switch restores
// this exact behavior — the flip itself is pinned in liveflips.test.mjs).
function rig({ env = { FLOW_LIVE_WALLETS: YENNI, FLOW_ALL_LIVE: '0' } } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0 }, env);
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const v = view({ address: 'MINTF', symbol: 'FLOWT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => m === 'MINTF').map(m => [m, v])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { bot, clock, v };
}

function seedHistory(bot, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set('MINTF', samples);
}

async function fire(bot, agg) {
  await bot.start();
  seedHistory(bot);
  await bot._evalFlow('MINTF', agg);
  return bot.journal.signals.at(-1);
}

// ---- config ----

test('flow shadow config: FLOW_LIVE_WALLETS parses to a trimmed list; unset is null (legacy)', () => {
  assert.equal(loadConfig({}).flowLiveWallets, null);
  assert.deepEqual(loadConfig({ FLOW_LIVE_WALLETS: ` ${YENNI} , ${CHAIRMAN} ` }).flowLiveWallets, [YENNI, CHAIRMAN]);
  assert.deepEqual(loadConfig({ FLOW_LIVE_WALLETS: '' }).flowLiveWallets, [], 'set-but-empty = nobody live (fail-closed)');
});

// ---- the split, bot level ----

test('flow shadow: yenni solo trigger still enters live — taken, position opened', async () => {
  const { bot } = rig();
  const s = await fire(bot, YENNI_AGG);
  assert.equal(s.setup, 'flow');
  assert.equal(s.decision, 'taken', JSON.stringify(s.reasons));
  assert.equal(s.label, YENNI_AGG.label);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].setup, 'flow');
  assert.equal(bot.stats.flow.fires, 1);
  assert.equal(bot.stats.flow.shadow || 0, 0);
});

test('flow shadow: identical chairman solo trigger journals as shadow — no position, no SOL', async () => {
  const { bot } = rig();
  const s = await fire(bot, CHAIRMAN_AGG);
  assert.equal(s.setup, 'flow');
  assert.equal(s.decision, 'shadow');
  assert.match(s.reasons[0], /^shadow: flow is shadow-only for this wallet/);
  assert.equal(s.label, CHAIRMAN_AGG.label, 'flow label intact on the shadow record');
  assert.equal(s.metrics.wallet, CHAIRMAN);
  assert.equal(bot.positions.length, 0, 'no live position');
  assert.equal(bot.journal.trades.filter(t => t.type === 'open').length, 0, 'no open journaled');
  assert.equal(bot.stats.entries, 0);
  assert.equal(bot.stats.flow.fires || 0, 0);
  assert.equal(bot.stats.flow.shadow, 1);
  assert.equal(bot.stats.shadowSignals.flow, 1);
  assert.ok(bot.journal.pending.has(s.id), 'shadow signal is outcome-tracked (r5/r15/r60)');
});

test('flow shadow: roster size trigger (8deJ) journals as shadow', async () => {
  const { bot } = rig();
  const s = await fire(bot, SIZE_AGG);
  assert.equal(s.decision, 'shadow');
  assert.equal(s.label, 'flow: 8deJ…XhU6 bought 1.30 SOL');
  assert.equal(bot.positions.length, 0);
});

test('flow shadow: poorgoat solo trigger enters live when listed alongside yenni (same status as yenni)', async () => {
  const { bot } = rig({ env: { FLOW_LIVE_WALLETS: LIVE_PAIR, FLOW_ALL_LIVE: '0' } });
  const s = await fire(bot, POORGOAT_AGG); // 0.85 SOL — under the roster size bar; only solo status fires it at all
  assert.equal(s.decision, 'taken', JSON.stringify(s.reasons));
  assert.equal(s.label, 'flow: poorgoat bought 0.85 SOL');
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].setup, 'flow');
  assert.equal(bot.stats.flow.fires, 1);
});

test('flow shadow: poorgoat solo trigger is shadow when the live set names yenni alone', async () => {
  const { bot } = rig(); // default rig env: FLOW_LIVE_WALLETS = yenni only
  const s = await fire(bot, POORGOAT_AGG);
  assert.equal(s.decision, 'shadow');
  assert.equal(bot.positions.length, 0);
});

test('flow shadow: confluence journals as shadow — even when yenni is the deciding buy', async () => {
  for (const agg of [CONFL_AGG, CONFL_YENNI_AGG]) {
    const { bot } = rig();
    const s = await fire(bot, agg);
    assert.equal(s.decision, 'shadow', `kind confluence wallet ${agg.wallet}`);
    assert.equal(bot.positions.length, 0);
  }
});

test('flow shadow: a yenni SIZE-shaped trigger is not live either — solo kind only', async () => {
  const { bot } = rig();
  assert.equal(bot.flowLiveTrigger({ kind: 'size', wallet: YENNI }), false);
  assert.equal(bot.flowLiveTrigger({ kind: 'solo', wallet: YENNI }), true);
  assert.equal(bot.flowLiveTrigger({ kind: 'solo', wallet: CHAIRMAN }), false);
  assert.equal(bot.flowLiveTrigger({ kind: 'solo', wallet: null }), false);
  assert.equal(bot.flowLiveTrigger(null), false);
});

test('flow shadow: set-but-empty live set makes even yenni shadow (fail-closed)', async () => {
  const { bot } = rig({ env: { FLOW_LIVE_WALLETS: '', FLOW_ALL_LIVE: '0' } });
  const s = await fire(bot, YENNI_AGG);
  assert.equal(s.decision, 'shadow');
  assert.equal(bot.positions.length, 0);
});

test('flow shadow: knob unset (legacy) — chairman solo trigger enters live as before', async () => {
  const { bot } = rig({ env: {} });
  const s = await fire(bot, CHAIRMAN_AGG);
  assert.equal(s.decision, 'taken', JSON.stringify(s.reasons));
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.stats.flow.fires, 1);
});

test('flow shadow: guard-blocked shadow trigger still journals record-only skipped (cooldown doctrine unchanged)', async () => {
  const { bot, clock } = rig();
  await bot.start();
  seedHistory(bot);
  bot.lastSignal.set('MINTF', clock.t - 60000); // signaled 1m ago — inside the 10m guard
  await bot._evalFlow('MINTF', CHAIRMAN_AGG);
  const s = bot.journal.signals.at(-1);
  assert.equal(s.decision, 'skipped');
  assert.match(s.reasons[0], /already signaled/);
  assert.equal(s.label, CHAIRMAN_AGG.label);
  assert.equal(bot.stats.flow.recordOnly, 1);
  assert.equal(bot.positions.length, 0);
});

test('flow shadow: a chairman shadow signal sets the same per-mint cooldown a live one would (yenni path unchanged)', async () => {
  const { bot } = rig();
  await bot.start();
  seedHistory(bot);
  await bot._evalFlow('MINTF', CHAIRMAN_AGG); // shadow — but the guard stamp lands exactly as today
  assert.equal(bot.journal.signals.at(-1).decision, 'shadow');
  await bot._evalFlow('MINTF', YENNI_AGG); // same mint, same instant: the standing cooldown judges it
  const s = bot.journal.signals.at(-1);
  assert.equal(s.decision, 'skipped');
  assert.match(s.reasons[0], /already signaled/);
  assert.equal(bot.positions.length, 0, 'yenni did not bypass the cooldown the shadow trigger set');
});
