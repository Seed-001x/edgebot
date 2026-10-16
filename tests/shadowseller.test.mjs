// Shadow Seller (user order 2026-10-16, RECORD-ONLY): a LEARNED exit judge —
// no ladder rules, no borrowed thresholds. It buckets an open position's
// state (peak band × drawdown band × buy-share-trend sign), consults an
// evidence table built from the bot's own completed history (journal closes
// + tick paths: did HOLDING from that state beat the mark?), and journals
// its first would-sell per position only when the bucket's smoothed EV says
// holding paid worse. Fires pair against the ladder's actual outcome on the
// same remainder at close. These tests pin the grid, the EV math (including
// no-evidence = hold), fire-once, the pairing/delta math, the kill switch,
// and the /shadowseller card shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Bot } from '../src/bot.js';
import { Journal } from '../src/journal.js';
import {
  ShadowSeller, buildEvidence, buildShadowSellerCard, bucketKey, peakBand, drawdownBand, trendBand,
  flowTrend, evOf, shouldFire, pairDelta,
} from '../src/shadowSeller.js';
import { startServer } from '../src/server.js';
import { testCfg, tmp } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const S = 1000;

// ------------------------------------------------------------ the grid
test('shadowseller grid: peak bands at their edges', () => {
  assert.equal(peakBand(1.0), 'p<1.1');
  assert.equal(peakBand(1.0999), 'p<1.1');
  assert.equal(peakBand(1.1), 'p1.1-1.3');
  assert.equal(peakBand(1.3), 'p1.3-1.6');
  assert.equal(peakBand(1.6), 'p1.6-2.2');
  assert.equal(peakBand(2.2), 'p>=2.2');
  assert.equal(peakBand(9), 'p>=2.2');
});

test('shadowseller grid: drawdown bands at their edges', () => {
  assert.equal(drawdownBand(0), 'dd0-5');
  assert.equal(drawdownBand(-0.049), 'dd0-5');
  assert.equal(drawdownBand(-0.05), 'dd5-12');
  assert.equal(drawdownBand(-0.119), 'dd5-12');
  assert.equal(drawdownBand(-0.12), 'dd12-25');
  assert.equal(drawdownBand(-0.25), 'dd>25');
  assert.equal(drawdownBand(-0.9), 'dd>25');
});

test('shadowseller grid: trend sign with its deadband, and the composed key', () => {
  assert.equal(trendBand(0.5), 'up');
  assert.equal(trendBand(0.021), 'up');
  assert.equal(trendBand(0.02), 'flat');
  assert.equal(trendBand(-0.02), 'flat');
  assert.equal(trendBand(-0.021), 'down');
  assert.equal(trendBand(null), 'na');
  assert.equal(bucketKey({ ratio: 1.0, peakRatio: 1.2, shareTrend: -0.5 }), 'p1.1-1.3|dd12-25|down');
  assert.equal(bucketKey({ ratio: 1.0, peakRatio: 1.0, shareTrend: null }), 'p<1.1|dd0-5|na');
});

test('shadowseller flowTrend: mirrors the exits.js 90s first-vs-last share construction', () => {
  const fh = [
    { ts: T0, buys: 40, sells: 10, tx: 50 },
    { ts: T0 + 40 * S, buys: 30, sells: 20, tx: 50 },
    { ts: T0 + 80 * S, buys: 15, sells: 35, tx: 50 },
  ];
  const t = flowTrend(fh, T0 + 80 * S);
  assert.equal(t.shareNow, 0.3);
  assert.equal(t.shareTrend, 0.3 - 0.8);
  assert.equal(t.txTrend, 1);
  // samples older than the window drop out of BOTH ends of the comparison
  const t2 = flowTrend([{ ts: T0 - 200 * S, buys: 99, sells: 1, tx: 100 }, ...fh], T0 + 80 * S);
  assert.equal(t2.shareTrend, 0.3 - 0.8);
  // missing flow = nulls, never zeros
  assert.deepEqual(flowTrend([], T0), { shareNow: null, shareTrend: null, txTrend: null });
  assert.deepEqual(flowTrend([{ ts: T0, buys: null, sells: null, tx: null }], T0), { shareNow: null, shareTrend: null, txTrend: null });
});

// ------------------------------------------------------------ EV math
test('shadowseller EV: smoothing prior pulls toward zero; no evidence is no opinion', () => {
  assert.equal(evOf(null), null);
  assert.equal(evOf({ n: 0, sum: -5 }), null);
  assert.equal(evOf({ n: 8, sum: -1.8 }, 10), -0.1);
  assert.equal(evOf({ n: 8, sum: -1.8 }, 0), -0.225);
  // the same raw mean reads weaker under a stronger prior — evidence must be earned
  assert.ok(Math.abs(evOf({ n: 8, sum: -1.8 }, 100)) < Math.abs(evOf({ n: 8, sum: -1.8 }, 10)));
});

test('shadowseller shouldFire: needs BOTH the sample floor AND a negative EV', () => {
  assert.equal(shouldFire(null, { minN: 8, priorK: 10 }), false);
  assert.equal(shouldFire({ n: 7, sum: -7 }, { minN: 8, priorK: 10 }), false, 'richly negative but under-sampled = hold');
  assert.equal(shouldFire({ n: 8, sum: -1.8 }, { minN: 8, priorK: 10 }), true);
  assert.equal(shouldFire({ n: 40, sum: 2 }, { minN: 8, priorK: 10 }), false, 'holding paid better = hold');
  assert.equal(shouldFire({ n: 40, sum: 0 }, { minN: 8, priorK: 10 }), false, 'a wash is not a sell');
});

// ------------------------------------------------------------ evidence build
// Position A: peaked 1.2, sat at ratio 1.0 with flow fading, ladder's only
// sell returned 0.03 on a 0.05 mark — holding paid -40% per unit from there.
function historyA() {
  const ticks = [], trades = [];
  for (let i = 0; i <= 11; i++) {
    ticks.push({ id: 'A', mint: 'MA', ts: T0 + i * 10 * S, valueSol: 0.05, ratio: 1.0, peak: 1.2, buysM5: 30 - i, sellsM5: 10 + i });
  }
  trades.push({ type: 'sell', id: 'A', solOut: 0.03, ts: T0 + 120 * S });
  trades.push({ type: 'close', id: 'A', entrySol: 0.05, exitSol: 0.03, pnlSol: -0.02, ts: T0 + 120 * S });
  return { ticks, trades };
}

test('shadowseller evidence: holding-paid-worse history lands negative in the right bucket', () => {
  const { ticks, trades } = historyA();
  const table = buildEvidence({ ticks, trades, txFeeSol: 0 });
  const b = table.get('p1.1-1.3|dd12-25|down');
  assert.ok(b, 'the faded-flow samples bucket together');
  assert.ok(b.n >= 8, `expected a solid sample, got ${b && b.n}`);
  // every one of those ticks: holdNet 0.03 vs mark 0.05 -> -0.4 per unit
  assert.ok(Math.abs(b.sum / b.n - -0.4) < 1e-9, `mean diff ${b.sum / b.n}`);
  assert.equal(shouldFire(b, { minN: 8, priorK: 10 }), true);
  // the very first tick has no in-window predecessor: its trend is 'na', its own bucket
  const na = table.get('p1.1-1.3|dd12-25|na');
  assert.ok(na && na.n === 1);
});

test('shadowseller evidence: holding-paid-better history stays positive', () => {
  const ticks = [], trades = [];
  for (let i = 0; i <= 5; i++) {
    ticks.push({ id: 'B', mint: 'MB', ts: T0 + i * 10 * S, valueSol: 0.05, ratio: 1.0, peak: 1.05, buysM5: 10 + i, sellsM5: 30 - i });
  }
  trades.push({ type: 'sell', id: 'B', solOut: 0.09, ts: T0 + 60 * S });
  trades.push({ type: 'close', id: 'B', entrySol: 0.05, exitSol: 0.09, pnlSol: 0.04, ts: T0 + 60 * S });
  const table = buildEvidence({ ticks, trades, txFeeSol: 0 });
  const b = table.get('p<1.1|dd0-5|up');
  assert.ok(b && b.n >= 4);
  assert.ok(Math.abs(b.sum / b.n - 0.8) < 1e-9);
  assert.equal(shouldFire(b, { minN: 2, priorK: 10 }), false);
});

test('shadowseller evidence: the fee the ladder pays per extra sell counts against holding', () => {
  // two sells after the tick (0.02 + 0.03) vs one shadow sell now: with a
  // 0.005 fee the hold side pays one EXTRA fee -> diff shifts by -fee/mark
  const ticks = [{ id: 'F', mint: 'MF', ts: T0, valueSol: 0.05, ratio: 1.0, peak: 1.0, buysM5: 10, sellsM5: 10 }];
  const trades = [
    { type: 'sell', id: 'F', solOut: 0.02, ts: T0 + 10 * S },
    { type: 'sell', id: 'F', solOut: 0.03, ts: T0 + 20 * S },
    { type: 'close', id: 'F', entrySol: 0.05, exitSol: 0.05, pnlSol: 0, ts: T0 + 20 * S },
  ];
  const free = buildEvidence({ ticks, trades, txFeeSol: 0 });
  const feed = buildEvidence({ ticks, trades, txFeeSol: 0.005 });
  const dFree = free.get('p<1.1|dd0-5|na').sum;
  const dFee = feed.get('p<1.1|dd0-5|na').sum;
  assert.ok(Math.abs(dFree - 0) < 1e-9, 'gross, the two paths tie');
  assert.ok(Math.abs(dFee - -0.1) < 1e-9, 'net of the extra sell fee, holding paid 10% of the mark worse');
});

test('shadowseller evidence: manual closes and unreconciled books teach nothing', () => {
  const ticks = [
    { id: 'M', mint: 'MM', ts: T0, valueSol: 0.05, ratio: 1.0, peak: 1.2, buysM5: 5, sellsM5: 40 },
    { id: 'X', mint: 'MX', ts: T0, valueSol: 0.05, ratio: 1.0, peak: 1.2, buysM5: 5, sellsM5: 40 },
  ];
  const trades = [
    { type: 'close', id: 'M', entrySol: 0.05, pnlSol: -0.01, ts: T0 + 60 * S }, // manual: no sells journaled
    { type: 'sell', id: 'X', solOut: 0.03, ts: T0 + 60 * S },
    { type: 'close', id: 'X', entrySol: 0.05, exitSol: 0.09, pnlSol: 0.04, ts: T0 + 60 * S }, // sells say 0.03, close says 0.09
  ];
  const table = buildEvidence({ ticks, trades, txFeeSol: 0 });
  assert.equal(table.size, 0);
});

test('shadowseller evidence: a tick after the last sell (nothing still held) contributes nothing', () => {
  const ticks = [
    { id: 'L', mint: 'ML', ts: T0, valueSol: 0.05, ratio: 1.0, peak: 1.0, buysM5: 10, sellsM5: 10 },
    { id: 'L', mint: 'ML', ts: T0 + 30 * S, valueSol: 0.001, ratio: 0.02, peak: 1.0, buysM5: 10, sellsM5: 10 },
  ];
  const trades = [
    { type: 'sell', id: 'L', solOut: 0.04, ts: T0 + 20 * S },
    { type: 'close', id: 'L', entrySol: 0.05, exitSol: 0.04, pnlSol: -0.01, ts: T0 + 20 * S },
  ];
  const table = buildEvidence({ ticks, trades, txFeeSol: 0 });
  const total = [...table.values()].reduce((a, b) => a + b.n, 0);
  assert.equal(total, 1, 'only the tick with proceeds still ahead of it counts');
});

// ------------------------------------------------------------ pairing math
test('shadowseller pairDelta: shadow net vs the ladder net on the same remainder', () => {
  const d = pairDelta({
    fire: { remainderSol: 0.04, realizedSolAtFire: 0.02, feesSolAtFire: 0.001 },
    close: { exitSolTotal: 0.05, feesSol: 0.002 },
    txFeeSol: 0.0005,
  });
  assert.ok(Math.abs(d.shadowNet - 0.0395) < 1e-12);
  assert.ok(Math.abs(d.holdNet - 0.029) < 1e-12);
  assert.ok(Math.abs(d.deltaSol - 0.0105) < 1e-12);
  assert.equal(d.shadowWin, true);
  // an unresolvable close total pairs as null, never as a fabricated number
  assert.equal(pairDelta({ fire: { remainderSol: 0.04 }, close: { exitSolTotal: null }, txFeeSol: 0 }), null);
  assert.equal(pairDelta({ fire: { remainderSol: 0 }, close: { exitSolTotal: 0.05 }, txFeeSol: 0 }), null);
});

// ------------------------------------------------------------ the judge, end to end
function judgeRig(cfgOver = {}) {
  const dir = tmp();
  const cfg = testCfg({ shadowSellerMinN: 2, shadowSellerPriorK: 0, txFeeSol: 0, ...cfgOver }, { DATA_DIR: dir });
  const journal = new Journal(dir, { now: () => T0 });
  const { ticks, trades } = historyA();
  fs.writeFileSync(journal.f.ticks, ticks.map(t => JSON.stringify(t)).join('\n') + '\n');
  for (const t of trades) journal.trade(t);
  const seller = new ShadowSeller({ cfg, journal, now: () => T0 + 200 * S, log: () => {} });
  return { cfg, journal, seller };
}
const fadedPos = () => ({
  id: 'LIVE1', mint: 'MA', symbol: 'AAA', setup: 'pop', entrySol: 0.05, remainingFrac: 1,
  entryTs: T0, peakRatio: 1.2, tp1Done: false, tp2Done: false, realizedSol: 0, feesSol: 0,
  flowHist: [
    { ts: T0 + 120 * S, buys: 40, sells: 10, tx: 50 },
    { ts: T0 + 200 * S, buys: 15, sells: 35, tx: 50 },
  ],
});

test('shadowseller judge: fires once on a condemned bucket, journals fire + state, pairs at close', () => {
  const { journal, seller } = judgeRig();
  const pos = fadedPos();
  const fire = seller.observe(pos, { valueSol: 0.05, view: { buysM5: 15, sellsM5: 35, mc: 42000, liq: 9000 }, n: T0 + 200 * S });
  assert.ok(fire, 'the condemned bucket fires');
  assert.equal(fire.kind, 'fire');
  assert.equal(fire.bucket, 'p1.1-1.3|dd12-25|down');
  assert.ok(fire.evidenceN >= 8);
  assert.ok(fire.evidenceEv < 0);
  assert.equal(fire.remainderSol, 0.05);
  // the snapshot carries the full state, with honest fields
  assert.equal(fire.snapshot.ratio, 1);
  assert.equal(fire.snapshot.peakRatio, 1.2);
  assert.equal(fire.snapshot.drawdown, -0.1667);
  assert.equal(fire.snapshot.heldSec, 200);
  assert.equal(fire.snapshot.secSincePeak, null, 'the peak predates the judge\'s first sight of the position — unknown, not invented');
  assert.equal(fire.snapshot.tp1Done, false);
  assert.equal(fire.snapshot.shareNow, 0.3);
  assert.equal(fire.snapshot.shareTrend, -0.5);
  assert.equal(fire.snapshot.mc, 42000);
  assert.equal(fire.snapshot.setup, 'pop');
  // fire-once: the same position never fires twice
  assert.equal(seller.observe(pos, { valueSol: 0.04, view: {}, n: T0 + 210 * S }), null);
  assert.equal(journal.shadowSells.filter(r => r.kind === 'fire').length, 1);
  // pairing at close: the ladder held the remainder to 0.03 — the shadow was right by 0.02
  const paired = seller.noteClose(pos, { exitSol: 0.03, feesSol: 0, entrySol: 0.05, pnlSol: -0.02, ts: T0 + 300 * S, reason: 'momentum failure', heldMin: 5 });
  assert.ok(paired && paired.paired);
  assert.equal(paired.deltaSol, 0.02);
  assert.equal(paired.shadowWin, true);
  assert.equal(paired.bucket, fire.bucket);
  const card = seller.card();
  assert.equal(card.totals.fires, 1);
  assert.equal(card.totals.paired, 1);
  assert.equal(card.totals.shadowWins, 1);
  assert.equal(card.totals.deltaSol, 0.02);
  assert.equal(card.ready, false);
  assert.equal(card.recent.length, 1);
});

test('shadowseller judge: no evidence = hold, however bad the state looks', () => {
  const dir = tmp();
  const cfg = testCfg({ txFeeSol: 0 }, { DATA_DIR: dir });
  const journal = new Journal(dir, { now: () => T0 });
  const seller = new ShadowSeller({ cfg, journal, now: () => T0, log: () => {} });
  assert.equal(seller.table.size, 0);
  const pos = { ...fadedPos(), peakRatio: 3, flowHist: [{ ts: T0, buys: 0, sells: 50, tx: 50 }] };
  assert.equal(seller.observe(pos, { valueSol: 0.005, view: {}, n: T0 }), null);
  assert.equal(journal.shadowSells.length, 0);
});

test('shadowseller judge: a bucket the history vindicates = hold', () => {
  const { seller } = judgeRig();
  // same faded peak/drawdown, but flow RISING — history A never condemned that bucket
  const pos = fadedPos();
  pos.flowHist = [
    { ts: T0 + 120 * S, buys: 10, sells: 40, tx: 50 },
    { ts: T0 + 200 * S, buys: 40, sells: 10, tx: 50 },
  ];
  assert.equal(seller.observe(pos, { valueSol: 0.05, view: {}, n: T0 + 200 * S }), null);
});

test('shadowseller card: post-exit move joins at read time; ready at 30 paired', () => {
  const recs = [];
  for (let i = 0; i < 30; i++) {
    recs.push({ kind: 'fire', id: `P${i}`, ts: T0 + i });
    recs.push({ kind: 'paired', id: `P${i}`, ts: T0 + i + 1, paired: true, deltaSol: 0.001, shadowWin: true, bucket: 'b', remainderSol: 0.05 });
  }
  const card = buildShadowSellerCard(recs, (id) => id === 'P29' ? { peakMovePct: 12.3, lastMovePct: -4 } : null, T0);
  assert.equal(card.totals.fires, 30);
  assert.equal(card.totals.paired, 30);
  assert.equal(card.totals.shadowWins, 30);
  assert.ok(Math.abs(card.totals.deltaSol - 0.03) < 1e-9);
  assert.equal(card.ready, true);
  assert.equal(card.recent[0].id, 'P29');
  assert.equal(card.recent[0].postExitPeakPct, 12.3);
  assert.equal(card.recent[0].postExitLastPct, -4);
  assert.equal(card.recent[1].postExitPeakPct, null, 'no post-exit record yet = null, not a number');
});

// ------------------------------------------------------------ bot wiring + endpoint + kill switch
function rig(cfgOver = {}) {
  const cfg = testCfg({ ...cfgOver });
  const clock = { t: T0 };
  const exec = { solBalance: async () => 1 };
  const bot = new Bot(cfg, { now: () => clock.t, exec });
  return { cfg, clock, bot };
}

test('shadowseller: shipped defaults are on (min 8 samples, prior 10, refit 15m)', () => {
  const cfg = testCfg({});
  assert.equal(cfg.shadowSeller, 1);
  assert.equal(cfg.shadowSellerMinN, 8);
  assert.equal(cfg.shadowSellerPriorK, 10);
  assert.equal(cfg.shadowSellerRefitMin, 15);
});

test('shadowseller: GET /shadowseller serves the card shape', async () => {
  const { bot } = rig();
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const card = await (await fetch(base + '/shadowseller')).json();
    assert.equal(card.enabled, true);
    assert.deepEqual(card.totals, { fires: 0, paired: 0, shadowWins: 0, deltaSol: 0 });
    assert.deepEqual(card.recent, []);
    assert.equal(card.ready, false);
  } finally { srv.close(); }
});

test('shadowseller: SHADOW_SELLER=0 disables observing, records, and the card', async () => {
  const { bot } = rig({ shadowSeller: 0 });
  assert.equal(bot.shadowSeller.enabled, false);
  const pos = fadedPos();
  assert.equal(bot.shadowSeller.observe(pos, { valueSol: 0.05, view: {}, n: T0 }), null);
  assert.equal(bot.journal.shadowSells.length, 0);
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const card = await (await fetch(base + '/shadowseller')).json();
    assert.deepEqual(card, { enabled: false });
  } finally { srv.close(); }
});
