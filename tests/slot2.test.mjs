// SECOND SLOT AT 0.025 (owner order 2026-10-17 ~00:28 EDT: "open up one
// more trading slot but .025", minutes after he had set the cap to 1):
// the cap goes back to 2, but the slots are not equal — slot 1 (an entry
// opened with nothing else open) trades the normal tradeSol, and an entry
// opened while one position is already open is the SECOND slot and trades
// SLOT2_SOL (default 0.025). Sizing stays inside the risk pipeline: the
// slot selects the BASE, the risk brake factors whichever base was
// selected exactly as it factors slot 1, and the pool-fraction cap clamps
// both. The slot count is the live positions length — the same count
// canEnter's cap judges, adopted bags included (they sit in that list).
// SLOT2_SOL=0 is the kill switch: uniform sizing, byte-identical to the
// pre-slot stack. A second-slot entry is stamped slot: 2 on the position
// and its journal open record; slot 1 keeps the exact shape of before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { Risk } from '../src/risk.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
let clock = Date.UTC(2026, 9, 17, 4, 0, 0);
const mkRisk = (over = {}) => { const cfg = testCfg(over); return new Risk(cfg, { dir: cfg.dataDir, now: () => clock }); };
const DEEP = 1_000_000, SOLUSD = 150;

// ------------------------------------------------------------ config
test('config: SLOT2_SOL defaults to 0.025, env reads, validation bounds it', () => {
  const d = loadConfig({});
  assert.equal(d.slot2Sol, 0.025);
  assert.equal(loadConfig({ SLOT2_SOL: '0.05' }).slot2Sol, 0.05);
  assert.equal(loadConfig({ SLOT2_SOL: '0' }).slot2Sol, 0);
  assert.ok(validateConfig({ ...d, slot2Sol: -0.01 }).some(e => e.includes('SLOT2_SOL')));
  assert.ok(!validateConfig(d).some(e => e.includes('SLOT2_SOL')));
});

// ------------------------------------------------------------ risk seam
test('(a) zero open: the entry sizes at tradeSol, exactly as before the slot rule', () => {
  const r = mkRisk({ tradeSol: 0.1 });
  assert.equal(r.effectiveTradeSol(0), 0.1);
  assert.equal(r.effectiveTradeSol(), 0.1, 'no-arg call (the /state limits shape) is unchanged');
  assert.equal(r.sizeFor(DEEP, SOLUSD, 0), 0.1);
  assert.equal(r.sizeFor(DEEP, SOLUSD), 0.1, 'no-count call defaults to slot 1');
});

test('(b) one open: the entry sizes at SLOT2_SOL — and only the base changes', () => {
  const r = mkRisk({ tradeSol: 0.1 });
  assert.equal(r.baseTradeSol(1), 0.025);
  assert.equal(r.effectiveTradeSol(1), 0.025);
  assert.equal(r.sizeFor(DEEP, SOLUSD, 1), 0.025);
  // a differently configured slot-2 size is the size that is used
  const r2 = mkRisk({ tradeSol: 0.1, slot2Sol: 0.04 });
  assert.equal(r2.sizeFor(DEEP, SOLUSD, 1), 0.04);
  // the pool-fraction cap clamps slot 2 exactly like slot 1
  const f = r.cfg.maxPoolFraction;
  assert.ok(Math.abs(r.sizeFor(60, SOLUSD, 1) - (60 * f) / SOLUSD) < 1e-9, 'shallow pool: slot 2 shrinks to the same pool fraction');
});

test('(d) brake latched: slot 2 is brake-factored the same way slot 1 is', () => {
  const r = mkRisk({ tradeSol: 0.1 }); // factor 0.5 by default; 3 red closes latch the brake
  r.recordClose(-0.01, 'A', 0.1); r.recordClose(-0.01, 'B', 0.1);
  assert.equal(r.s.sizeHalved, false);
  r.recordClose(-0.01, 'C', 0.1);
  assert.equal(r.s.sizeHalved, true);
  assert.equal(r.effectiveTradeSol(0), 0.05, 'slot 1 halved: 0.1 x 0.5');
  assert.equal(r.effectiveTradeSol(1), 0.0125, 'slot 2 halved: 0.025 x 0.5 — same factor, its own base');
  assert.equal(r.sizeFor(DEEP, SOLUSD, 1), 0.0125);
});

test('(e) kill switch: SLOT2_SOL=0 (or = tradeSol) restores uniform sizing', () => {
  const off = mkRisk({ tradeSol: 0.1, slot2Sol: 0 });
  assert.equal(off.baseTradeSol(1), 0.1);
  assert.equal(off.effectiveTradeSol(1), 0.1);
  assert.equal(off.sizeFor(DEEP, SOLUSD, 1), 0.1, 'off: the second slot sizes exactly like the first');
  const same = mkRisk({ tradeSol: 0.1, slot2Sol: 0.1 });
  assert.equal(same.sizeFor(DEEP, SOLUSD, 1), 0.1);
});

// ------------------------------------------------------------ pipeline rig
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function pipelineRig({ cfgOver = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.1, baseMode: 0, maxPositions: 2, slot2Sol: 0.025, ...cfgOver });
  const clock = { t: T0 };
  // proportional stub: 1 raw unit per lamport in, 95% back out — the
  // round-trip ratio is 0.95 at ANY size (the fixed-value stub other rigs
  // use only clears the 80% round-trip line at their small tradeSol)
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: String(Math.floor(Number(amount))), priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(Number(amount) * 0.95)), priceImpactPct: '0.01' });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  const deps = {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
    fetchCurveLife: async () => null,
  };
  const bot = new Bot(cfg, deps);
  return { bot, clock, views };
}

const S = (ts, mc) => ({ ts, price: mc / 1e6, mc, volM5: 50_000, volH1: 200_000, buysM5: 100, sellsM5: 60, liq: 100_000 });
const thin = (mc) => [S(T0 - 90000, mc - 20_000), S(T0 - 45000, mc - 10_000), S(T0 - 5000, mc)];

async function fire(rig, { mint, symbol, mc = 500_000 }) {
  const v = view({ address: mint, symbol, mc, price: mc / 1e6, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  rig.bot.history.m.set(mint, thin(mc));
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

test('(a)+(b) pipeline: first entry full size unstamped, second entry 0.025 stamped slot 2', async () => {
  const rig = pipelineRig();
  const rec1 = await fire(rig, { mint: 'MINTAAA', symbol: 'FIRST' });
  assert.equal(rec1.decision, 'taken', JSON.stringify(rec1.reasons));
  assert.equal(rec1.metrics.sizeSol, 0.1, 'slot 1 sizes at tradeSol');
  assert.equal(rig.bot.positions.length, 1);
  assert.equal(rig.bot.positions[0].entrySol, 0.1);
  assert.equal(rig.bot.positions[0].slot, undefined, 'slot 1 keeps the position shape of before');
  const open1 = rig.bot.journal.trades.find(t => t.type === 'open' && t.mint === 'MINTAAA');
  assert.equal(open1.slot, undefined, 'slot 1 open record carries no slot stamp');

  const rec2 = await fire(rig, { mint: 'MINTBBB', symbol: 'SECOND' });
  assert.equal(rec2.decision, 'taken', JSON.stringify(rec2.reasons));
  assert.equal(rec2.metrics.sizeSol, 0.025, 'the second concurrent entry sizes at SLOT2_SOL');
  assert.equal(rig.bot.positions.length, 2);
  assert.equal(rig.bot.positions[1].entrySol, 0.025);
  assert.equal(rig.bot.positions[1].slot, 2, 'the position is stamped slot 2');
  const open2 = rig.bot.journal.trades.find(t => t.type === 'open' && t.mint === 'MINTBBB');
  assert.equal(open2.slot, 2, 'the journal open record is stamped slot 2');
  assert.equal(open2.entrySol, 0.025);
});

test('(c) pipeline: the cap still refuses a third concurrent entry', async () => {
  const rig = pipelineRig();
  await fire(rig, { mint: 'MINTAAA', symbol: 'FIRST' });
  await fire(rig, { mint: 'MINTBBB', symbol: 'SECOND' });
  const rec3 = await fire(rig, { mint: 'MINTCCC', symbol: 'THIRD' });
  assert.equal(rec3.decision, 'skipped');
  assert.ok(rec3.reasons.some(r => /max 2 positions/.test(r)), JSON.stringify(rec3.reasons));
  assert.equal(rig.bot.positions.length, 2);
  assert.equal(rig.bot.stats.entries, 2);
});

test('(f) pipeline: an adopted position occupies slot 1 — the next entry sizes as slot 2', async () => {
  const rig = pipelineRig();
  await rig.bot.start();
  // the adoption shape: pushed straight into the positions list (bot.js
  // _reconcileZeroConfirmed adoption), where the cap counts it
  rig.bot.positions.push({ id: 'HELDXX-1', mint: 'HELDXXX', symbol: 'HELD', setup: 'pop', entryTs: T0 - 60000, entrySol: 0.05, tokensRaw: '1000', entryTokensRaw: '1000', remainingFrac: 0.5, peakRatio: 1, tp1Done: false, tp2Done: false, adopted: true });
  const rec = await fire(rig, { mint: 'MINTBBB', symbol: 'SECOND' });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.metrics.sizeSol, 0.025, 'counting is shared with the cap: adopted counts, so this is slot 2');
  assert.equal(rig.bot.positions.at(-1).slot, 2);
});

test('(e) pipeline: SLOT2_SOL=0 — the second entry sizes at tradeSol and carries no stamp', async () => {
  const rig = pipelineRig({ cfgOver: { slot2Sol: 0 } });
  await fire(rig, { mint: 'MINTAAA', symbol: 'FIRST' });
  const rec2 = await fire(rig, { mint: 'MINTBBB', symbol: 'SECOND' });
  assert.equal(rec2.decision, 'taken', JSON.stringify(rec2.reasons));
  assert.equal(rig.bot.positions[1].entrySol, 0.1, 'kill switch off: uniform sizing restored');
  assert.equal(rig.bot.positions[1].slot, undefined, 'kill switch off: no stamp either — the record is the pre-slot shape');
  const open2 = rig.bot.journal.trades.find(t => t.type === 'open' && t.mint === 'MINTBBB');
  assert.equal(open2.slot, undefined);
});
