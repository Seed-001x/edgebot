// INSIDER-COUNT BLOCK + CHG1M SHADOW (owner order 2026-10-16, off the
// last-50 separation study in ~/workspace/analysis-scratch/
// last50-separation-2026-10-16.md):
//   PART A (LIVE): a candidate whose RugCheck graph-insider count
//   (rug.graphInsidersDetected — the entry snapshot's insiderWallets) is
//   >= INSIDER_BLOCK_N (default 3) never buys. Judged in Bot.onSignal after
//   the gate stack resolves to proceed, so every live entry path (they all
//   funnel through onSignal) is covered by the one seam. Unknown counts
//   never block. INSIDER_BLOCK=0 is the kill switch.
//   PART B (RECORD-ONLY): every signal record carries chg1mPct (the bot's
//   own sampled 1-minute price change into the signal) and chg1mShadow
//   ('would-block' | 'pass' | 'unknown'), tallied in stats.shadowChg1m.
//   The verdict is NEVER read for a decision — a would-block signal with a
//   clean gate run still buys (pinned below).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { insiderCountVerdict } from '../src/gate.js';
import { computeSignalFields, CHG1M_WINDOW_MS, CHG1M_TOL_MS } from '../src/signalFields.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const M = 60000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const rugWithInsiders = (n) => ({ ...healthyRug, graphInsidersDetected: n });
const rugNoCount = () => { const r = { ...healthyRug }; delete r.graphInsidersDetected; return r; };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}
// Price was 2.0 a minute ago, 1.3 thirty seconds ago, view prints 1.0 now:
// chg1m = (1.0 / 2.0 - 1) * 100 = -50 — a falling minute.
function seedFallingHistory(bot, mint) {
  const samples = [];
  for (let k = 0; k < 12; k++) {
    const price = k <= 9 ? 2.0 : 1.3;
    samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  }
  bot.history.m.set(mint, samples);
}

function pipelineRig({ cfgOver = {}, env = {}, rug = healthyRug } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, ...cfgOver }, env);
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

async function popFire(rig, { mint = 'MINTP', symbol = 'POPT' } = {}) {
  const v = view({ address: mint, symbol, mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

// ------------------------------------------------------------ config
test('config: insider block defaults ON at 3; env knobs read; validation bounds the line', () => {
  const d = loadConfig({});
  assert.equal(d.insiderBlock, true);
  assert.equal(d.insiderBlockN, 3);
  assert.equal(loadConfig({ INSIDER_BLOCK: '0' }).insiderBlock, false);
  assert.equal(loadConfig({ INSIDER_BLOCK_N: '7' }).insiderBlockN, 7);
  assert.ok(validateConfig({ ...d, insiderBlockN: 0 }).some(e => e.includes('INSIDER_BLOCK_N')));
  assert.ok(!validateConfig(d).some(e => e.includes('INSIDER_BLOCK_N')));
});

// ------------------------------------------------------------ verdict helper
test('insiderCountVerdict: >= line blocks, under passes, missing count is unknown and never blocks', () => {
  assert.deepEqual(insiderCountVerdict({ graphInsidersDetected: 5 }, 3), { pass: false, insiders: 5, unknown: false, reason: 'insiders 5 >= 3 — blocked' });
  assert.equal(insiderCountVerdict({ graphInsidersDetected: 3 }, 3).pass, false, 'boundary: exactly at the line blocks');
  assert.equal(insiderCountVerdict({ graphInsidersDetected: 2 }, 3).pass, true);
  assert.equal(insiderCountVerdict({ graphInsidersDetected: 0 }, 3).pass, true);
  const nullRug = insiderCountVerdict(null, 3);
  assert.deepEqual({ pass: nullRug.pass, insiders: nullRug.insiders, unknown: nullRug.unknown }, { pass: true, insiders: null, unknown: true });
  assert.equal(insiderCountVerdict({}, 3).unknown, true, 'report without the field = unknown');
  assert.equal(insiderCountVerdict({ graphInsidersDetected: 'many' }, 3).unknown, true, 'non-numeric = unknown, never invented');
});

// ------------------------------------------------------------ PART A pipeline
test('insider block: 5 insiders — skipped with the block reason, no buy, tally + record stamp', async () => {
  const rig = pipelineRig({ rug: rugWithInsiders(5) });
  const rec = await popFire(rig);
  assert.equal(rec.decision, 'skipped', JSON.stringify(rec.reasons));
  assert.deepEqual(rec.reasons, ['insiders 5 >= 3 — blocked']);
  assert.equal(rec.gatePass, true, 'the gate stack itself passed — the block is what stopped it');
  assert.equal(rec.gates.insiderBlock.pass, false);
  assert.equal(rec.gates.insiderBlock.insiders, 5);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.stats.entries, 0);
  assert.deepEqual(rig.bot.stats.insiderBlock, { blocked: 1, unknown: 0 });
});

test('insider block: boundary — exactly 3 blocks, 2 buys', async () => {
  const r3 = pipelineRig({ rug: rugWithInsiders(3) });
  const rec3 = await popFire(r3);
  assert.equal(rec3.decision, 'skipped');
  assert.deepEqual(rec3.reasons, ['insiders 3 >= 3 — blocked']);
  const r2 = pipelineRig({ rug: rugWithInsiders(2) });
  const rec2 = await popFire(r2);
  assert.equal(rec2.decision, 'taken', JSON.stringify(rec2.reasons));
  assert.equal(rec2.gates.insiderBlock.pass, true);
  assert.equal(rec2.gates.insiderBlock.insiders, 2);
  assert.equal(r2.bot.positions.length, 1);
  assert.equal(r2.bot.stats.entries, 1);
  assert.deepEqual(r2.bot.stats.insiderBlock, { blocked: 0, unknown: 0 });
});

test('insider block: count unavailable — entry proceeds, record says unknown, tally counts it', async () => {
  const rig = pipelineRig({ rug: rugNoCount() });
  const rec = await popFire(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.insiderBlock.pass, true);
  assert.equal(rec.gates.insiderBlock.insiders, null);
  assert.equal(rec.gates.insiderBlock.unknown, true);
  assert.deepEqual(rig.bot.stats.insiderBlock, { blocked: 0, unknown: 1 });
});

test('insider block: kill switch INSIDER_BLOCK=0 — 9 insiders buy, records exactly as before', async () => {
  const rig = pipelineRig({ cfgOver: { insiderBlock: false }, rug: rugWithInsiders(9) });
  const rec = await popFire(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.insiderBlock, undefined, 'no verdict stamped when the block is off');
  assert.equal(rig.bot.stats.insiderBlock, undefined, 'no tally when the block is off');
  assert.equal(rig.bot.positions.length, 1);
});

test('insider block: INSIDER_BLOCK_N moves the line — 5 buys at line 6, 6 blocks', async () => {
  const r5 = pipelineRig({ cfgOver: { insiderBlockN: 6 }, rug: rugWithInsiders(5) });
  assert.equal((await popFire(r5)).decision, 'taken');
  const r6 = pipelineRig({ cfgOver: { insiderBlockN: 6 }, rug: rugWithInsiders(6) });
  const rec6 = await popFire(r6);
  assert.equal(rec6.decision, 'skipped');
  assert.deepEqual(rec6.reasons, ['insiders 6 >= 6 — blocked']);
});

test('insider block: binds the flow path too (chairman solo routes through onSignal)', async () => {
  const CHAIRMAN = 'Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6';
  const rig = pipelineRig({ env: { FLOW_LIVE_WALLETS: '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG' }, rug: rugWithInsiders(7) });
  rig.views.set('MINTF', view({ address: 'MINTF', symbol: 'FLOWT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 }));
  await rig.bot.start();
  seedHistory(rig.bot, 'MINTF');
  await rig.bot._evalFlow('MINTF', { wallets: [CHAIRMAN], maxSol: 0.85, count: 1, kind: 'solo', wallet: CHAIRMAN, walletSol: 0.85, buyTs: T0, label: 'flow: chairman bought 0.85 SOL' });
  const rec = rig.bot.journal.signals.at(-1);
  assert.equal(rec.setup, 'flow');
  assert.equal(rec.decision, 'skipped', JSON.stringify(rec.reasons));
  assert.deepEqual(rec.reasons, ['insiders 7 >= 3 — blocked']);
  assert.equal(rig.bot.positions.length, 0);
});

// ------------------------------------------------------------ PART B fields (pure)
test('chg1m: computed from the bot samples — rising minute passes, falling would-blocks, flat passes', () => {
  const samples = [{ ts: T0 - CHG1M_WINDOW_MS, price: 1.0 }];
  const up = computeSignalFields({ samples, view: view({ price: 1.1 }), holders: [], now: T0 });
  assert.equal(up.chg1mPct, 10);
  assert.equal(up.chg1mShadow, 'pass');
  const down = computeSignalFields({ samples, view: view({ price: 0.9 }), holders: [], now: T0 });
  assert.equal(down.chg1mPct, -10);
  assert.equal(down.chg1mShadow, 'would-block');
  const flat = computeSignalFields({ samples, view: view({ price: 1.0 }), holders: [], now: T0 });
  assert.equal(flat.chg1mPct, 0);
  assert.equal(flat.chg1mShadow, 'pass', '0 is not a falling minute');
});

test('chg1m: closest sample to the 60s target wins; tolerance gates thin history to unknown', () => {
  // candidates at -90s (1.0), -62s (2.0), -10s (3.0): the -62s sample is the 60s-ago price
  const samples = [{ ts: T0 - 90000, price: 1.0 }, { ts: T0 - 62000, price: 2.0 }, { ts: T0 - 10000, price: 3.0 }];
  const f = computeSignalFields({ samples, view: view({ price: 2.2 }), holders: [], now: T0 });
  assert.equal(f.chg1mPct, 10, 'judged against the -62s sample, not the endpoints');
  // a sample 15s off the target is inside tolerance
  const near = computeSignalFields({ samples: [{ ts: T0 - 75000, price: 2.0 }], view: view({ price: 1.0 }), holders: [], now: T0 });
  assert.equal(near.chg1mPct, -50);
  // the newest sample is only 20s old — 40s from the target, outside tolerance
  const thin = computeSignalFields({ samples: [{ ts: T0 - 20000, price: 1.0 }], view: view({ price: 2.0 }), holders: [], now: T0 });
  assert.equal(thin.chg1mPct, null);
  assert.equal(thin.chg1mShadow, 'unknown', 'thin history never fabricates a number');
  const none = computeSignalFields({ samples: [], view: view({}), holders: [], now: T0 });
  assert.equal(none.chg1mPct, null);
  assert.equal(none.chg1mShadow, 'unknown');
  assert.ok(CHG1M_TOL_MS < CHG1M_WINDOW_MS);
});

// ------------------------------------------------------------ PART B pipeline (inertness + tally)
test('chg1m shadow: flat minute stamps pass on the taken record and tallies', async () => {
  const rig = pipelineRig({ rug: rugWithInsiders(0) });
  const rec = await popFire(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.fields.chg1mPct, 0);
  assert.equal(rec.fields.chg1mShadow, 'pass');
  assert.equal(rig.bot.stats.shadowChg1m.pass, 1);
  assert.equal(rig.bot.stats.shadowChg1m.wouldBlock, 0);
});

test('chg1m shadow INERTNESS PIN: a would-block (falling) minute with clean gates STILL BUYS', async () => {
  const rig = pipelineRig({ rug: rugWithInsiders(0) });
  const v = view({ address: 'MINTP', symbol: 'POPT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 });
  rig.views.set('MINTP', v);
  await rig.bot.start();
  seedFallingHistory(rig.bot, 'MINTP');
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  const rec = rig.bot.journal.signals.at(-1);
  assert.equal(rec.fields.chg1mPct, -50, JSON.stringify(rec.fields));
  assert.equal(rec.fields.chg1mShadow, 'would-block');
  assert.equal(rec.decision, 'taken', 'the shadow verdict must never stop a buy in this build');
  assert.equal(rig.bot.positions.length, 1);
  assert.equal(rig.bot.stats.shadowChg1m.wouldBlock, 1);
});

test('chg1m shadow: no sampled history — record says unknown, tally counts unknown', async () => {
  const rig = pipelineRig({ rug: rugWithInsiders(0) });
  const v = view({ address: 'MINTP', symbol: 'POPT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3 });
  rig.views.set('MINTP', v);
  await rig.bot.start();
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  const rec = rig.bot.journal.signals.at(-1);
  assert.equal(rec.fields.chg1mPct, null);
  assert.equal(rec.fields.chg1mShadow, 'unknown');
  assert.equal(rig.bot.stats.shadowChg1m.unknown, 1);
});
