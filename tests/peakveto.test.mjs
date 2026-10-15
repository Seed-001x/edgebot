// Peak-distance stamps + shadow veto (RECORD-ONLY, user 2026-10-15): every
// signal record's fields block carries distFromPeakPct (distance of the signal
// price under the trailing-60m sampled peak) and peakAgeSec (seconds since that
// peak last printed), plus a peakVeto verdict { wouldBlock, distPct, ageSec }
// computed at PEAK_VETO_DIST_PCT / PEAK_VETO_AGE_SEC. The 2026-10-15 forensic
// found most bad entries were bought after the local high was already in —
// invisible in the stamps the gates judge on. NOTHING branches on the verdict;
// these tests pin the stamp math, the honest-null discipline on thin history,
// the veto line, and the guard that a wouldBlock verdict changes no decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { computeSignalFields } from '../src/signalFields.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view, sample } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const M = 60000;
const VETO = { distPct: 0.15, ageSec: 1800 };
const fields = (samples, v, now, veto = VETO) => computeSignalFields({ samples, view: v, holders: [], now, veto });

// price path: `points` = [minutesBeforeNow, price] pairs, oldest first
const path = (points, now) => points.map(([minAgo, price]) => sample(now - minAgo * M, price)).sort((a, b) => a.ts - b.ts);

test('peak stamps: a coin at its sampled top reads dist 0, age 0, no block', () => {
  const now = T0 + 10 * M;
  const samples = path([[10, 1.0], [8, 1.02], [6, 1.05], [4, 1.08], [2, 1.1], [0, 1.1]], now);
  const f = fields(samples, view({ price: 1.1 }), now);
  assert.equal(f.distFromPeakPct, 0);
  assert.equal(f.peakAgeSec, 0);
  assert.deepEqual(f.peakVeto, { wouldBlock: false, distPct: 0, ageSec: 0 });
});

test('peak stamps: rolled over — 20% under a 25-minute-old peak would block', () => {
  const now = T0 + 35 * M;
  const samples = path([[35, 1.0], [30, 1.1], [25, 1.25], [20, 1.15], [15, 1.1], [10, 1.05], [5, 1.02], [0, 1.0]], now);
  const f = fields(samples, view({ price: 1.0 }), now);
  assert.equal(f.distFromPeakPct, 0.2); // (1.25 - 1.00) / 1.25
  assert.equal(f.peakAgeSec, 1500);
  assert.equal(f.peakVeto.wouldBlock, true);
  assert.equal(f.peakVeto.distPct, 0.2);
  assert.equal(f.peakVeto.ageSec, 1500);
});

test('peak stamps: the veto line is inclusive on both legs, exclusive just past it', () => {
  const mk = (cur, ageMin) => {
    const now = T0 + 60 * M;
    const samples = path([[ageMin, 1.0], [0, cur]], now);
    return fields(samples, view({ price: cur }), now);
  };
  // dist exactly 0.15 (1.00 -> 0.85), age exactly 1800s -> block
  let f = mk(0.85, 30);
  assert.equal(f.distFromPeakPct, 0.15); assert.equal(f.peakAgeSec, 1800); assert.equal(f.peakVeto.wouldBlock, true);
  // age 1801s -> no block
  f = mk(0.85, 30.0167);
  assert.equal(f.peakAgeSec, 1801); assert.equal(f.peakVeto.wouldBlock, false);
  // dist 0.149 -> no block
  f = mk(0.851, 30);
  assert.equal(f.distFromPeakPct, 0.149); assert.equal(f.peakVeto.wouldBlock, false);
});

test('peak stamps: a deep drop under an OLD peak does not block (the veto wants a fresh rollover)', () => {
  const now = T0 + 45 * M;
  const samples = path([[45, 1.0], [44, 0.9], [40, 0.8], [30, 0.75], [15, 0.72], [0, 0.7]], now);
  const f = fields(samples, view({ price: 0.7 }), now);
  assert.equal(f.distFromPeakPct, 0.3);
  assert.equal(f.peakAgeSec, 2700);
  assert.equal(f.peakVeto.wouldBlock, false);
});

test('peak stamps: thin history stays null — unknown never reads as safe or blocked', () => {
  const now = T0;
  for (const samples of [[], [sample(now, 1)], path([[0.1, 1.0], [0, 0.8]], now)]) {
    const f = fields(samples, view({ price: 0.8 }), now);
    assert.equal(f.distFromPeakPct, null, JSON.stringify(samples.map(s => s.ts)));
    assert.equal(f.peakAgeSec, null);
    assert.deepEqual(f.peakVeto, { wouldBlock: false, distPct: null, ageSec: null });
  }
});

test('peak stamps: samples older than the 60m window do not set the peak', () => {
  const now = T0 + 90 * M;
  const samples = path([[70, 5.0], [30, 1.0], [20, 1.0], [10, 1.0], [0, 1.0]], now);
  const f = fields(samples, view({ price: 1.0 }), now);
  assert.equal(f.distFromPeakPct, 0); // the 5.0 print is outside the trailing hour
  assert.equal(f.peakAgeSec, 0);
});

test('peak stamps: no veto lines supplied — stamps still computed, verdict null', () => {
  const now = T0 + 35 * M;
  const samples = path([[35, 1.0], [25, 1.25], [0, 1.0]], now);
  const f = computeSignalFields({ samples, view: view({ price: 1.0 }), holders: [], now });
  assert.equal(f.distFromPeakPct, 0.2);
  assert.equal(f.peakAgeSec, 1500);
  assert.equal(f.peakVeto, null);
});

test('peak veto config: defaults are the design-note lines (0.15 / 1800), env overrides, bad values rejected', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.peakVetoDistPct, 0.15);
  assert.equal(cfg.peakVetoAgeSec, 1800);
  assert.equal(loadConfig({ PEAK_VETO_DIST_PCT: '0.25' }).peakVetoDistPct, 0.25);
  assert.ok(validateConfig(loadConfig({ PEAK_VETO_DIST_PCT: '1.5' })).some(e => e.includes('PEAK_VETO_DIST_PCT')));
  assert.ok(validateConfig(loadConfig({ PEAK_VETO_AGE_SEC: '-5' })).some(e => e.includes('PEAK_VETO_AGE_SEC')));
});

// ---- bot level: the shadow cannot change a decision ----

const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const AGG = { wallets: ['W1'], maxSol: 5, count: 1, kind: 'solo', label: 'flow: W1 bought 5 SOL' };

function rig({ viewOver = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02 });
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const v = view({ address: 'MINTF', symbol: 'FLOWT', mc: 500_000, liq: 100_000, price: 1, createdAt: T0 - 10 * 3600e3, ...viewOver });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => m === 'MINTF' || m === 'MINTN').map(m => [m, m === 'MINTF' ? v : view({ address: 'MINTN', symbol: 'NEW', mc: 500_000, liq: 100_000, price: 1, createdAt: T0 - 10 * 3600e3 })])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { bot, clock, v };
}

test('peak veto guard: a wouldBlock verdict on the record changes NOTHING — the entry still lands', async () => {
  const { bot } = rig({ viewOver: { chgM5: 10 } });
  await bot.start();
  // sampled rollover on MINTF: peak 1.25 twenty-five minutes ago, price back to 1.00
  const samples = [];
  for (let k = 0; k <= 35; k++) {
    const ts = T0 - (35 - k) * M;
    const price = k <= 10 ? 1 + 0.025 * k : Math.max(1.0, 1.25 - 0.025 * (k - 10));
    samples.push({ ts, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  }
  bot.history.m.set('MINTF', samples);
  await bot._evalFlow('MINTF', AGG);
  const s = bot.journal.signals.at(-1);
  assert.equal(s.fields.distFromPeakPct, 0.2);
  assert.equal(s.fields.peakVeto.wouldBlock, true, 'shadow says block…');
  assert.equal(s.decision, 'taken', '…and the entry lands anyway — the verdict is record-only');
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.stats.peakVeto.stamped, 1);
  assert.equal(bot.stats.peakVeto.wouldBlock, 1);
  assert.equal(bot.stats.peakVeto.unstamped, 0);
});

test('peak veto counters: a signal with no sampled history counts as unstamped, verdict inert', async () => {
  const { bot } = rig({ viewOver: { chgM5: 10 } });
  await bot.start();
  await bot._evalFlow('MINTN', AGG);
  const s = bot.journal.signals.at(-1);
  assert.equal(s.fields.distFromPeakPct, null);
  assert.deepEqual(s.fields.peakVeto, { wouldBlock: false, distPct: null, ageSec: null });
  assert.ok(bot.stats.peakVeto.unstamped >= 1);
  assert.equal(bot.stats.peakVeto.wouldBlock, 0);
});
