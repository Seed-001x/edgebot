// Flow-entry snapshot collapse check (user 2026-10-15, from the DACITY forensic):
// a flow entry fires on a tracked wallet's buy and carries no detector price-shape
// of its own, so before this fix nothing in the shared stack read the downside of
// its own entry snapshot — DACITY was taken with chgM5 -41.8% in that snapshot
// (~62% under its 09:17 peak) and bled out -0.0109. The fix judges flow entries on
// that same print (gate.js flowSnapshotCheck, FLOW_SNAPSHOT_MIN_CHG_M5). These
// tests pin: the DACITY replay skips with the new stamp and opens nothing, dip-
// follows and healthy flow entries still land, the knob lifts the check, and
// non-flow setups are untouched by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { flowSnapshotCheck } from '../src/gate.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const AGG = { wallets: ['6yVb...JBqm'], maxSol: 5.51, count: 1, kind: 'solo', label: 'flow: 6yVb…JBqm bought 5.51 SOL' };

// Full-pipeline rig (e2e pattern): real Bot + scripted-quote Executor, one
// controlled view for MINTF. tradeSol 0.02 matches the rig's sell-back calibration.
function rig({ viewOver = {}, cfgOver = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, ...cfgOver });
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const v = view({ address: 'MINTF', symbol: 'FLOWT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, ...viewOver });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => m === 'MINTF').map(m => [m, v])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { bot, clock, v };
}

// Give MINTF enough sampled history that the fresh check stands down the way it
// did for DACITY's second signal ("enough sampled history — sampled guards judge").
function seedHistory(bot, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set('MINTF', samples);
}

// ---- unit: the check itself ----

test('flowSnapshot unit: a DACITY print (-41.8%) fails at the default floor', () => {
  const r = flowSnapshotCheck(view({ chgM5: -41.8 }), { minChgM5: -20 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /coin collapsing \(chgM5 -41\.8%/);
});

test('flowSnapshot unit: at the floor fails, just above it passes', () => {
  assert.equal(flowSnapshotCheck(view({ chgM5: -20 }), { minChgM5: -20 }).pass, false);
  assert.equal(flowSnapshotCheck(view({ chgM5: -19.9 }), { minChgM5: -20 }).pass, true);
});

test('flowSnapshot unit: dip-follows and risers pass; missing print passes; knob off passes', () => {
  assert.equal(flowSnapshotCheck(view({ chgM5: -11.86 }), { minChgM5: -20 }).pass, true); // Tralalero's dip-follow
  assert.equal(flowSnapshotCheck(view({ chgM5: 35.19 }), { minChgM5: -20 }).pass, true);
  assert.equal(flowSnapshotCheck(view({ chgM5: null }), { minChgM5: -20 }).pass, true);
  assert.equal(flowSnapshotCheck(view({ chgM5: -41.8 }), { minChgM5: 0 }).pass, true); // 0 = off
  assert.equal(flowSnapshotCheck(null, { minChgM5: -20 }).pass, true);
});

test('flowSnapshot config: default is -20, env overrides, positive values rejected', () => {
  assert.equal(loadConfig({}).flowSnapshotMinChgM5, -20);
  assert.equal(loadConfig({ FLOW_SNAPSHOT_MIN_CHG_M5: '-10' }).flowSnapshotMinChgM5, -10);
  assert.equal(validateConfig(loadConfig({})).length, 0);
  assert.ok(validateConfig(loadConfig({ FLOW_SNAPSHOT_MIN_CHG_M5: '5' })).some(e => e.includes('FLOW_SNAPSHOT_MIN_CHG_M5')));
});

// ---- bot level: the DACITY replay ----

test('flowSnapshot replay: DACITY shape (chgM5 -41.8, hot hour, sampled history) is skipped with the new stamp, no entry', async () => {
  const { bot } = rig({ viewOver: { chgM5: -41.8, chgH1: 98.7, volM5: 132_700, buysM5: 958, sellsM5: 833 } });
  await bot.start();
  seedHistory(bot);
  await bot._evalFlow('MINTF', AGG);
  assert.equal(bot.positions.length, 0, 'no position opened');
  assert.equal(bot.journal.trades.filter(t => t.type === 'open').length, 0, 'no open journaled');
  const s = bot.journal.signals.at(-1);
  assert.equal(s.setup, 'flow');
  assert.equal(s.decision, 'skipped');
  assert.ok(s.reasons.some(r => r === 'flow snapshot: coin collapsing (chgM5 -41.8% — at/below the -20% floor)'), JSON.stringify(s.reasons));
  // the fresh check stood down exactly as it did live — sampled history existed
  assert.equal(s.gates.fresh.pass, true, JSON.stringify(s.gates && s.gates.fresh));
  assert.equal(s.gates.flowSnapshot.pass, false);
  assert.match(s.gates.flowSnapshot.reason, /^flow snapshot: coin collapsing/);
});

test('flowSnapshot: a dip-follow at Tralalero\u2019s print (-11.86%) is NOT blocked — the entry lands', async () => {
  const { bot } = rig({ viewOver: { chgM5: -11.86, chgH1: -11.86 } });
  await bot.start();
  seedHistory(bot);
  await bot._evalFlow('MINTF', AGG);
  const s = bot.journal.signals.at(-1);
  assert.equal(s.decision, 'taken', JSON.stringify(s.reasons));
  assert.equal(s.gates.flowSnapshot.pass, true);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].setup, 'flow');
});

test('flowSnapshot: a healthy flow entry (+18.5%) lands; just above the floor (-19.9%) lands', async () => {
  for (const chgM5 of [18.46, -19.9]) {
    const { bot } = rig({ viewOver: { chgM5 } });
    await bot.start();
    seedHistory(bot);
    await bot._evalFlow('MINTF', AGG);
    assert.equal(bot.journal.signals.at(-1).decision, 'taken', `chgM5 ${chgM5}`);
    assert.equal(bot.positions.length, 1);
  }
});

test('flowSnapshot: knob off (0) lets even a collapse print through the check', async () => {
  const { bot } = rig({ viewOver: { chgM5: -41.8, chgH1: 98.7 }, cfgOver: { flowSnapshotMinChgM5: 0 } });
  await bot.start();
  seedHistory(bot);
  await bot._evalFlow('MINTF', AGG);
  const s = bot.journal.signals.at(-1);
  assert.equal(s.decision, 'taken', JSON.stringify(s.reasons));
  assert.equal(s.gates.flowSnapshot.pass, true);
  assert.match(s.gates.flowSnapshot.reason, /check off/);
});

test('flowSnapshot: non-flow setups never see the check (pop at a collapse print is judged exactly as before)', async () => {
  const { bot, v } = rig({ viewOver: { chgM5: -41.8, chgH1: 98.7 } });
  await bot.start();
  seedHistory(bot);
  await bot.onSignal(v, { setup: 'pop', strength: 30, metrics: { gainPct: 30, drawFromPeak: 0.01, buyRatioM5: 0.75, volM5: 50_000, volH1: 50_000 } });
  const s = bot.journal.signals.at(-1);
  assert.equal(s.setup, 'pop');
  assert.ok(!('flowSnapshot' in (s.gates || {})), 'no flowSnapshot leg on a pop record');
  assert.ok(!s.reasons.some(r => r.startsWith('flow snapshot')), 'no flow snapshot skip reason');
});
