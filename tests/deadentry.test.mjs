// Dead-entry veto stamps + /deadentry scorecard (RECORD-ONLY, user GO
// 2026-10-15): every signal record's fields block carries volM5 (the
// signal's own 5m volume USD), buyVel (buys/min), a deadEntryVeto verdict
// map at FOUR volume lines ($15k/$17.5k/$20k/$25k — the whole curve is
// shadowed because the Job 2d in-sample candidate flipped sign between
// $15k and $17.5k), and a buyVelBlock30 flag. Job 2d found only immediate
// activity intensity separating never-peaked pop entries from movers.
// NOTHING branches on any of it; these tests pin the stamp math, the
// honest-null discipline (unknown is null, never block or pass), the
// scorecard fold/aggregation incl. the both-halves split and the
// collecting-status bar, and the guard that a wouldBlock stamp changes
// no decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { Journal } from '../src/journal.js';
import { computeSignalFields, DEAD_ENTRY_THRESHOLDS_USD, BUY_VEL_BLOCK_PER_MIN } from '../src/signalFields.js';
import { foldStampedPopSignals, buildDeadEntryCard, DEAD_ENTRY_BAR } from '../src/deadEntryLab.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, tmp, view, sample } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const M = 60000;
const fields = (over = {}) => computeSignalFields({ samples: [], view: view(), holders: [], now: T0, ...over });

// ---------- the stamp ----------

test('dead-entry: the shadowed curve is the four ordered lines + the 30/min velocity line', () => {
  assert.deepEqual(DEAD_ENTRY_THRESHOLDS_USD, [15000, 17500, 20000, 25000]);
  assert.equal(BUY_VEL_BLOCK_PER_MIN, 30);
  assert.deepEqual(DEAD_ENTRY_BAR, { vetoedSignals: 300, days: 14 });
});

test('dead-entry stamp: quiet tape blocks at every line', () => {
  const f = fields({ view: view({ volM5: 12000 }) });
  assert.equal(f.volM5, 12000);
  assert.deepEqual(f.deadEntryVeto, { wouldBlock15000: true, wouldBlock17500: true, wouldBlock20000: true, wouldBlock25000: true });
});

test('dead-entry stamp: heavy tape passes at every line', () => {
  const f = fields({ view: view({ volM5: 26000 }) });
  assert.deepEqual(f.deadEntryVeto, { wouldBlock15000: false, wouldBlock17500: false, wouldBlock20000: false, wouldBlock25000: false });
});

test('dead-entry stamp: the lines are strict — exactly at a line passes that line', () => {
  const f = fields({ view: view({ volM5: 17500 }) });
  assert.deepEqual(f.deadEntryVeto, { wouldBlock15000: false, wouldBlock17500: false, wouldBlock20000: true, wouldBlock25000: true });
  const g = fields({ view: view({ volM5: 17499.99 }) });
  assert.equal(g.deadEntryVeto.wouldBlock17500, true);
  assert.equal(g.deadEntryVeto.wouldBlock15000, false);
});

test('dead-entry stamp: zero volume is a real (dead) reading — blocks everywhere, not null', () => {
  const f = fields({ view: view({ volM5: 0 }) });
  assert.equal(f.volM5, 0);
  assert.deepEqual(f.deadEntryVeto, { wouldBlock15000: true, wouldBlock17500: true, wouldBlock20000: true, wouldBlock25000: true });
});

test('dead-entry stamp: unknown volume stays null at every line — never block, never pass', () => {
  for (const v of [view({ volM5: undefined }), view({ volM5: NaN }), view({ volM5: -5 }), null]) {
    const f = fields({ view: v });
    assert.equal(f.volM5, null);
    assert.deepEqual(f.deadEntryVeto, { wouldBlock15000: null, wouldBlock17500: null, wouldBlock20000: null, wouldBlock25000: null });
  }
});

test('dead-entry stamp: the signal metrics figure wins over the view (it is what detection judged)', () => {
  const f = fields({ view: view({ volM5: 50000 }), volM5: 9000 });
  assert.equal(f.volM5, 9000);
  assert.equal(f.deadEntryVeto.wouldBlock15000, true);
  const g = fields({ view: view({ volM5: 50000 }), volM5: null });
  assert.equal(g.volM5, 50000);
  assert.equal(g.deadEntryVeto.wouldBlock15000, false);
});

test('dead-entry stamp: buyVel mirrors buyVelPerMin and the 30/min line is strict', () => {
  const mk = (buysM5) => [10, 5, 0].map(minAgo => sample(T0 - minAgo * M, 1, { buysM5 }));
  let f = fields({ samples: mk(200) }); // 200 buys / 5m = 40/min
  assert.equal(f.buyVelPerMin, 40);
  assert.equal(f.buyVel, 40);
  assert.equal(f.buyVelBlock30, false);
  f = fields({ samples: mk(100) }); // 20/min
  assert.equal(f.buyVel, 20);
  assert.equal(f.buyVelBlock30, true);
  f = fields({ samples: mk(150) }); // exactly 30/min — not below the line
  assert.equal(f.buyVel, 30);
  assert.equal(f.buyVelBlock30, false);
});

test('dead-entry stamp: unknown velocity stays null — flag null, never 0-filled', () => {
  const f = fields({ samples: [] });
  assert.equal(f.buyVel, null);
  assert.equal(f.buyVelBlock30, null);
});

// ---------- the fold ----------

const stampedFields = (volM5, buyVel = null) => ({
  volM5, buyVel,
  deadEntryVeto: Object.fromEntries(DEAD_ENTRY_THRESHOLDS_USD.map(t => [`wouldBlock${t}`, volM5 == null ? null : volM5 < t])),
  buyVelBlock30: buyVel == null ? null : buyVel < BUY_VEL_BLOCK_PER_MIN,
});
const sigRec = (id, ts, over = {}) => ({ id, ts, mint: 'M' + id, symbol: 'S' + id, setup: 'pop', decision: 'skipped', price: 1, mc: 100000, metrics: {}, fields: stampedFields(9000), ...over });

test('dead-entry fold: only stamped pop signals join; outcomes join by id, latest wins', () => {
  const sigs = [
    sigRec('a', T0),
    sigRec('b', T0 + M, { setup: 'trend' }),                    // wrong setup — out
    sigRec('c', T0 + 2 * M, { fields: null }),                  // pre-stamp record — out
    sigRec('d', T0 + 3 * M, { metrics: { fastStream: 1 } }),   // fast pop — in, flagged
    sigRec('e', T0 + 4 * M),                                    // no outcome — pending
  ];
  const outs = [
    { id: 'a', done: true, r60: -0.4, maxRet: 0.1 },
    { id: 'a', done: true, r60: -0.35, maxRet: 0.12 },          // latest wins
    { id: 'd', done: true, r60: 0.2, maxRet: 0.9 },
  ];
  const rows = foldStampedPopSignals(sigs, outs);
  assert.deepEqual(rows.map(r => r.id), ['a', 'd', 'e']);
  assert.equal(rows[0].out.r60, -0.35);
  assert.equal(rows[1].fast, true);
  assert.equal(rows[2].out, null);
});

// ---------- the scorecard ----------

const row = (ts, volM5, out, buyVelBlock30 = null) => ({
  id: 'r' + ts + '-' + volM5, ts, mint: 'M', symbol: 'S', decision: 'taken', fast: false,
  volM5, buyVel: null, veto: stampedFields(volM5).deadEntryVeto, buyVelBlock30, out,
});
const done = (r60, maxRet) => ({ done: true, r60, maxRet });

test('dead-entry card: vetoed vs passed aggregates run over scored rows only', () => {
  const rows = [
    row(T0, 10000, done(-0.4, 0.1)),          // vetoed at all lines
    row(T0 + 1 * 86400e3, 18000, done(0.1, 0.8)), // vetoed at 20k/25k only
    row(T0 + 2 * 86400e3, 30000, done(0.3, 0.2)), // passed everywhere
    row(T0 + 3 * 86400e3, null, done(-0.9, 0)),    // unknown volume — neither set
    row(T0 + 4 * 86400e3, 9000, null),            // vetoed but still tracking
  ];
  const card = buildDeadEntryCard(rows, T0 + 5 * 86400e3);
  assert.equal(card.stampedPopSignals, 5);
  assert.equal(card.unknownVol, 1);
  assert.equal(card.pendingOutcomes, 1);
  const t15 = card.thresholds[0], t25 = card.thresholds[3];
  assert.equal(t15.threshold, 15000);
  assert.equal(t15.vetoed.n, 2);            // the 10k row + the still-tracking 9k row
  assert.equal(t15.vetoed.scored, 1);
  assert.equal(t15.vetoed.medianR60, -0.4);
  assert.equal(t15.vetoed.sharePeak50, 0);
  assert.equal(t15.passed.n, 2);
  assert.equal(t15.passed.medianR60, 0.2);   // median of 0.1 / 0.3
  assert.equal(t15.passed.sharePeak50, 0.5); // one of two peaked >= +50%
  assert.equal(t15.unknown, 1);
  assert.equal(t25.vetoed.n, 3);            // 10k + 18k + 9k
  assert.equal(card.status.collecting, true);
  assert.equal(card.status.ready, false);
  assert.equal(card.status.progress.vetoedSignals, 3);
});

test('dead-entry card: halves split at the median signal time and cover both sets', () => {
  const rows = [0, 1, 2, 3].map(i => row(T0 + i * 86400e3, i % 2 ? 30000 : 9000, done(i % 2 ? 0.5 : -0.5, 0)));
  const card = buildDeadEntryCard(rows, T0 + 4 * 86400e3);
  const [h1, h2] = card.thresholds[0].halves;
  assert.equal(h1.vetoed.n + h2.vetoed.n, 2);
  assert.equal(h1.passed.n + h2.passed.n, 2);
  assert.equal(h1.vetoed.medianR60, -0.5);
  assert.equal(h2.passed.medianR60, 0.5);
});

test('dead-entry card: the buyVel rule row splits blocked / passed / unknown', () => {
  const rows = [
    row(T0, 50000, done(-0.2, 0), true),
    row(T0 + M, 50000, done(0.4, 0.7), false),
    row(T0 + 2 * M, 50000, done(0, 0), null),
  ];
  const card = buildDeadEntryCard(rows, T0 + 3 * M);
  assert.equal(card.buyVelRule.line, 30);
  assert.equal(card.buyVelRule.vetoed.n, 1);
  assert.equal(card.buyVelRule.vetoed.medianR60, -0.2);
  assert.equal(card.buyVelRule.passed.n, 1);
  assert.equal(card.buyVelRule.passed.sharePeak50, 1);
  assert.equal(card.buyVelRule.unknown, 1);
});

test('dead-entry card: READY only when BOTH bar legs hold — never before', () => {
  const mk = (n, spanDays) => Array.from({ length: n }, (_, i) => row(T0 + Math.floor(i * spanDays * 86400e3 / Math.max(1, n - 1)), 9000, done(-0.3, 0)));
  let card = buildDeadEntryCard(mk(300, 10), T0 + 10 * 86400e3);   // vetoed bar met, days short
  assert.equal(card.status.ready, false);
  assert.equal(card.status.collecting, true);
  card = buildDeadEntryCard(mk(299, 20), T0 + 20 * 86400e3);       // days met, vetoed short
  assert.equal(card.status.ready, false);
  card = buildDeadEntryCard(mk(300, 20), T0 + 20 * 86400e3);       // both legs
  assert.equal(card.status.ready, true);
  assert.equal(card.status.collecting, false);
  card = buildDeadEntryCard([], T0);                               // nothing collected yet
  assert.equal(card.stampedPopSignals, 0);
  assert.equal(card.status.ready, false);
  assert.equal(card.firstStampTs, null);
});

// ---------- journal level: the card folds the full files ----------

test('dead-entry journal: card folds signals.jsonl + outcomes.jsonl, pop + stamped only', () => {
  const dir = tmp();
  const line = (o) => JSON.stringify(o) + '\n';
  const sigs = [
    sigRec('s1', T0 - 30 * M, { fields: stampedFields(9000) }),
    sigRec('s2', T0 - 25 * M, { fields: stampedFields(40000) }),
    sigRec('s3', T0 - 20 * M, { setup: 'trend', fields: stampedFields(9000) }),
    sigRec('s4', T0 - 15 * M, { fields: null }),
  ];
  fs.writeFileSync(path.join(dir, 'signals.jsonl'), sigs.map(line).join(''));
  fs.writeFileSync(path.join(dir, 'outcomes.jsonl'), [
    { id: 's1', done: true, r60: -0.4, maxRet: 0.1 },
    { id: 's2', done: true, r60: 0.2, maxRet: 0.8 },
  ].map(line).join(''));
  const j = new Journal(dir, { now: () => T0 });
  const card = j.deadEntryCard();
  assert.equal(card.enabled, true);
  assert.equal(card.stampedPopSignals, 2);
  assert.equal(card.thresholds[0].vetoed.n, 1);
  assert.equal(card.thresholds[0].vetoed.medianR60, -0.4);
  assert.equal(card.thresholds[0].passed.n, 1);
  assert.equal(card.thresholds[0].passed.sharePeak50, 1);
  assert.equal(card.status.collecting, true);
  assert.equal(j.deadEntryCard(), card, 'cached within the window');
});

// ---------- bot level: the stamp changes NOTHING ----------

const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const AGG = { wallets: ['W1'], maxSol: 5, count: 1, kind: 'solo', label: 'flow: W1 bought 5 SOL' };

function rig({ viewOver = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0 });
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
    fetchViews: async (mints) => new Map(mints.filter(m => m === 'MINTF').map(m => [m, v])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { bot, clock, v };
}

test('dead-entry guard: a wouldBlock stamp on the record changes NOTHING — the entry still lands', async () => {
  const { bot } = rig({ viewOver: { chgM5: 10, volM5: 8000 } });
  await bot.start();
  await bot._evalFlow('MINTF', AGG);
  const s = bot.journal.signals.at(-1);
  assert.equal(s.fields.volM5, 8000);
  assert.equal(s.fields.deadEntryVeto.wouldBlock15000, true, 'shadow says block…');
  assert.equal(s.decision, 'taken', '…and the entry lands anyway — the stamp is record-only');
  assert.equal(bot.positions.length, 1);
});

test('dead-entry bot: a pop skip record carries the metrics figure, not the view figure', async () => {
  const { bot, v } = rig();
  await bot.start();
  bot.skip(v, { setup: 'pop', strength: 25, metrics: { volM5: 12000, gainPct: 25 } }, ['test skip']);
  const s = bot.journal.signals.at(-1);
  assert.equal(s.decision, 'skipped');
  assert.equal(s.fields.volM5, 12000);
  assert.deepEqual(s.fields.deadEntryVeto, { wouldBlock15000: true, wouldBlock17500: true, wouldBlock20000: true, wouldBlock25000: true });
});

test('dead-entry bot: a fast-pop record whose SOL/USD conversion failed never stamps SOL as USD', async () => {
  const { bot, v } = rig(); // view volM5 = 50,000
  await bot.start();
  // unconverted: metrics.volM5 still holds the raw 25 SOL stream figure
  bot.skip(v, { setup: 'pop', strength: 40, metrics: { fastStream: 1, volM5: 25, streamVolSol: 25 } }, ['test skip']);
  let s = bot.journal.signals.at(-1);
  assert.equal(s.fields.volM5, 50000, 'falls back to the view USD figure — 25 SOL is not $25');
  assert.equal(s.fields.deadEntryVeto.wouldBlock15000, false);
  // converted: metrics.volM5 is the genuine USD figure and wins
  bot.skip(v, { setup: 'pop', strength: 40, metrics: { fastStream: 1, volM5: 4875, streamVolSol: 25 } }, ['test skip']);
  s = bot.journal.signals.at(-1);
  assert.equal(s.fields.volM5, 4875);
  assert.equal(s.fields.deadEntryVeto.wouldBlock15000, true);
});
