// TOP GUARD (owner order 2026-10-16, "Do not buy a coin if it's at the
// literal fucking top" + "minimize those numbers so it signals as it's
// building up" — the thresholds are his approved set): a candidate within
// TOP_GUARD_DIST_PCT (10) of its trailing-30m sampled high never buys when
// that high was MADE by a >= TOP_GUARD_SURGE_PCT (20) rise inside the 120s
// before it printed and is <= TOP_GUARD_HIGH_MAX_AGE_SEC (300) old. The
// live triggers peak when the vertical peaks, so fills land on the tip —
// blocus (confluence taken at $56,844, the exact top tick of one vertical
// candle out of a day-long range, out -9.7%), MM (confluence taken with
// the entry minute already -13.6% off a seconds-old high), 'long' (pop
// taken at $50,158, $33.9K three minutes later). Judged in Bot.onSignal
// on the post-gates seam from the bot's OWN sampled mc history ONLY — no
// external fetch, so it can never fail open on a 429 or a stamp collapse.
// UNKNOWN (thin history, unmeasured surge base, no current mc) never
// blocks. TOP_GUARD_BLOCK=0 is the kill switch (no stamp, no tally).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { topGuardVerdict } from '../src/gate.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const OPTS = { lookbackMin: 30, surgeWindowSec: 120, maxDistPct: 10, minSurgePct: 20, highMaxAgeSec: 300 };
// one history sample: price follows mc (fixed supply), the way History.record stores them
const S = (ts, mc) => ({ ts, price: mc / 1e6, mc, volM5: 50_000, volH1: 200_000, buysM5: 100, sellsM5: 60, liq: 100_000 });
const flat = (from, to, step, mc) => { const out = []; for (let t = from; t <= to; t += step) out.push(S(t, mc)); return out; };

// ------------------------------------------------------------ config
test('config: top guard defaults ON at the owner-approved lines; env knobs read; validation bounds them', () => {
  const d = loadConfig({});
  assert.equal(d.topGuardBlock, true);
  assert.equal(d.topGuardDistPct, 10);
  assert.equal(d.topGuardSurgePct, 20);
  assert.equal(d.topGuardSurgeWindowSec, 120);
  assert.equal(d.topGuardHighMaxAgeSec, 300);
  assert.equal(d.topGuardLookbackMin, 30);
  assert.equal(loadConfig({ TOP_GUARD_BLOCK: '0' }).topGuardBlock, false);
  assert.equal(loadConfig({ TOP_GUARD_DIST_PCT: '5' }).topGuardDistPct, 5);
  assert.equal(loadConfig({ TOP_GUARD_SURGE_PCT: '30' }).topGuardSurgePct, 30);
  assert.ok(validateConfig({ ...d, topGuardDistPct: 101 }).some(e => e.includes('TOP_GUARD_DIST_PCT')));
  assert.ok(validateConfig({ ...d, topGuardSurgeWindowSec: 0 }).some(e => e.includes('TOP_GUARD_SURGE_WINDOW_SEC')));
  assert.ok(validateConfig({ ...d, topGuardLookbackMin: 91 }).some(e => e.includes('TOP_GUARD_LOOKBACK_MIN')));
  assert.ok(!validateConfig(d).some(e => e.includes('TOP_GUARD')));
});

// ------------------------------------------------------------ verdict helper
test('(a) blocus shape: flat base, one vertical candle to the high, current AT the high — blocked', () => {
  const samples = [
    ...flat(T0 - 25 * 60000, T0 - 120000, 60000, 20_000),
    S(T0 - 110000, 30_000), S(T0 - 70000, 42_000), S(T0 - 30000, 56_844),
  ];
  const v = topGuardVerdict(samples, T0, { currentMc: 56_844, ...OPTS });
  assert.equal(v.pass, false);
  assert.equal(v.unknown, false);
  assert.equal(v.distPct, 0);
  assert.equal(v.surgePct, 184.2);
  assert.equal(v.highAgeSec, 30);
  assert.equal(v.reason, 'at the local top: within 0% of a high made 30s ago by a +184.2% 2-minute surge — not buying the tip');
});

test('(b) MM shape: +35% surge to a high 1 minute ago, current 8% under it — blocked', () => {
  const samples = [
    ...flat(T0 - 20 * 60000, T0 - 180000, 60000, 24_000),
    S(T0 - 150000, 27_000), S(T0 - 110000, 30_500), S(T0 - 60000, 32_400),
  ];
  const v = topGuardVerdict(samples, T0, { currentMc: 29_808, ...OPTS });
  assert.equal(v.pass, false);
  assert.equal(v.distPct, 8);
  assert.equal(v.surgePct, 35);
  assert.equal(v.highAgeSec, 60);
  assert.equal(v.reason, 'at the local top: within 8% of a high made 60s ago by a +35% 2-minute surge — not buying the tip');
});

test('(c) Simulator-at-signal shape: 19.2% under the high — passes on distance', () => {
  const samples = [
    ...flat(T0 - 20 * 60000, T0 - 240000, 60000, 500_000),
    S(T0 - 180000, 700_000), S(T0 - 120000, 1_000_000),
  ];
  const v = topGuardVerdict(samples, T0, { currentMc: 808_000, ...OPTS });
  assert.equal(v.pass, true);
  assert.equal(v.unknown, false);
  assert.equal(v.distPct, 19.2);
});

test('(d) staircase runner: new highs ground out over the window, no 2-minute surge — passes', () => {
  const samples = [];
  for (let k = 0; k <= 30; k++) samples.push(S(T0 - (30 - k) * 60000, 100_000 + k * 1333));
  const v = topGuardVerdict(samples, T0, { currentMc: 139_990, ...OPTS });
  assert.equal(v.pass, true);
  assert.equal(v.unknown, false);
  assert.equal(v.distPct, 0);
  assert.ok(v.surgePct < 20, `surge ${v.surgePct} must stay under the line`);
});

test('(e) held high: the surge is 12 minutes old, price still at the high — passes on age', () => {
  const samples = [
    ...flat(T0 - 29 * 60000, T0 - 15 * 60000, 60000, 50_000),
    S(T0 - 750000, 60_000), S(T0 - 720000, 75_000),
    ...flat(T0 - 660000, T0, 60000, 74_500),
  ];
  const v = topGuardVerdict(samples, T0, { currentMc: 74_500, ...OPTS });
  assert.equal(v.pass, true);
  assert.equal(v.unknown, false);
  assert.equal(v.highAgeSec, 720);
  assert.equal(v.distPct, 0.7);
  assert.equal(v.surgePct, 25);
});

test('(f) thin history: 3 samples — unknown, never blocks', () => {
  const v = topGuardVerdict([S(T0 - 60000, 10_000), S(T0 - 30000, 20_000), S(T0, 40_000)], T0, { currentMc: 40_000, ...OPTS });
  assert.equal(v.pass, true);
  assert.equal(v.unknown, true);
  assert.equal(v.distPct, null);
  assert.equal(v.surgePct, null);
});

test('top guard: no sample inside the surge-base window — unknown (the surge was never measured)', () => {
  // discovered already at its high: the first print IS the high, then a fade
  const samples = [S(T0 - 600000, 100_000), S(T0 - 480000, 90_000), S(T0 - 360000, 85_000), S(T0 - 240000, 82_000), S(T0 - 120000, 80_000), S(T0, 79_000)];
  const v = topGuardVerdict(samples, T0, { ...OPTS }); // currentMc falls back to the newest sample
  assert.equal(v.pass, true);
  assert.equal(v.unknown, true);
  assert.equal(v.surgePct, null);
  assert.equal(v.distPct, 21);
});

test('(h) at the high but arrived slowly (surge < 20%) — passes', () => {
  const samples = [
    ...flat(T0 - 20 * 60000, T0 - 240000, 60000, 95_000),
    S(T0 - 180000, 97_000), S(T0 - 110000, 98_500), S(T0 - 60000, 99_500), S(T0 - 20000, 100_000),
  ];
  const v = topGuardVerdict(samples, T0, { currentMc: 100_000, ...OPTS });
  assert.equal(v.pass, true);
  assert.equal(v.unknown, false);
  assert.equal(v.distPct, 0);
  assert.ok(v.surgePct < 20, `surge ${v.surgePct} must stay under the line`);
});

test('top guard: boundary — dist exactly 10, surge exactly +20, high exactly 300s old — blocks', () => {
  const samples = [
    ...flat(T0 - 25 * 60000, T0 - 480000, 60000, 90_000),
    S(T0 - 360000, 100_000), S(T0 - 300000, 120_000),
  ];
  const v = topGuardVerdict(samples, T0, { currentMc: 108_000, ...OPTS });
  assert.equal(v.pass, false);
  assert.equal(v.distPct, 10);
  assert.equal(v.surgePct, 20);
  assert.equal(v.highAgeSec, 300);
});

// ------------------------------------------------------------ pipeline rig
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function pipelineRig({ cfgOver = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver });
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
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

async function fire(rig, { mint = 'MINTG', symbol = 'TOPG', mc, samples }) {
  const v = view({ address: mint, symbol, mc, price: mc / 1e6, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  rig.bot.history.m.set(mint, samples);
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

// a gentle range for ~26 minutes, then a vertical candle into the signal:
// extension vs the hour base stays sane, the 2-minute surge is +32%
function blocusSamples() {
  const out = [];
  for (let t = T0 - 26 * 60000; t <= T0 - 180000; t += 30000) out.push(S(t, (Math.round(t / 30000) % 2 === 0) ? 390_000 : 410_000));
  out.push(S(T0 - 110000, 430_000), S(T0 - 80000, 470_000), S(T0 - 50000, 520_000), S(T0 - 20000, 568_440));
  return out;
}

test('seam: blocus shape through onSignal — skipped with the top-guard reason, stamp + tally, no buy', async () => {
  const rig = pipelineRig();
  const rec = await fire(rig, { mc: 568_440, samples: blocusSamples() });
  assert.equal(rec.decision, 'skipped', JSON.stringify(rec.reasons));
  assert.deepEqual(rec.reasons, ['at the local top: within 0% of a high made 20s ago by a +32.2% 2-minute surge — not buying the tip']);
  assert.equal(rec.gatePass, true, 'the gate stack itself passed — the guard is what stopped it');
  assert.equal(rec.gates.topGuard.pass, false);
  assert.equal(rec.gates.topGuard.distPct, 0);
  assert.equal(rec.gates.topGuard.surgePct, 32.2);
  assert.equal(rec.gates.topGuard.highAgeSec, 20);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.stats.entries, 0);
  assert.deepEqual(rig.bot.stats.topGuard, { blocked: 1, passed: 0, unknown: 0 });
});

test('seam: grinding rise to the high (no 2m surge) — taken, stamp says pass, tally counts it', async () => {
  const rig = pipelineRig();
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push(S(T0 - (11 - k) * 30000, 480_000 + k * 1818));
  const rec = await fire(rig, { mc: 500_000, samples });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.topGuard.pass, true);
  assert.ok(rec.gates.topGuard.surgePct < 20);
  assert.equal(rig.bot.positions.length, 1);
  assert.equal(rig.bot.stats.entries, 1);
  assert.deepEqual(rig.bot.stats.topGuard, { blocked: 0, passed: 1, unknown: 0 });
});

test('seam: thin history — unknown never blocks, the stamp and tally say unknown', async () => {
  const rig = pipelineRig();
  const samples = [S(T0 - 90000, 480_000), S(T0 - 45000, 490_000), S(T0 - 5000, 500_000)];
  const rec = await fire(rig, { mc: 500_000, samples });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.topGuard.pass, true);
  assert.equal(rec.gates.topGuard.unknown, true);
  assert.deepEqual(rig.bot.stats.topGuard, { blocked: 0, passed: 0, unknown: 1 });
});

test('(g) kill switch off: the blocus shape buys — no stamp, no tally', async () => {
  const rig = pipelineRig({ cfgOver: { topGuardBlock: false } });
  const rec = await fire(rig, { mc: 568_440, samples: blocusSamples() });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.topGuard, undefined, 'no verdict stamped when the guard is off');
  assert.equal(rig.bot.stats.topGuard, undefined, 'no tally when the guard is off');
  assert.equal(rig.bot.positions.length, 1);
});
