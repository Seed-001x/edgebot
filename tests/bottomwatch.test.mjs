// bottomwatch.test.mjs — the BOTTOM TRACKER (user order 2026-10-16,
// RECORD-ONLY): watched coins dumped >= BOTTOM_DROP_PCT off their sampled
// peak open an episode; the low must hold quiet BOTTOM_QUIET_MIN before
// the first move >= BOTTOM_MOVE_PCT off it (with buy flow back, when flow
// is known) journals a 'first move' mark to bottom_marks.jsonl, scored
// forward by the structure watch's own candle tailer. Pins: the episode
// threshold, the quiet clock (incl. reset on a new low), the flow rule
// and the flowKnown:false price-alone mark, one mark per episode, source
// tagging, scoring finalization, recovery/stale episode ends, the kill
// switch, config validation, and the inertness pin — feeding the tracker
// a full dump-to-mark sequence produces no signals, no positions, and no
// journal writes outside bottom_marks.jsonl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BottomWatch, flowOf, foldBottomJournal, buildBottomCard, qualifiesPeak, recoveredPctOf, BOTTOM_READY_N } from '../src/bottomWatch.js';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, view, tmp } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const M = 60000;
const MINT = 'BottomMint1111111111111111111111111111111';

function rig({ cfgOver = {}, wasExited = null, fetchCandles = null, resolvePool = null } = {}) {
  const dir = tmp();
  const journal = new Journal(dir);
  const clock = { t: T0 };
  const bw = new BottomWatch({ cfg: { bottomWatch: 1, bottomDropPct: 50, bottomQuietMin: 3, bottomMovePct: 18, bottomExpireMin: 60, ...cfgOver }, journal, dir, now: () => clock.t, wasExited, fetchCandles, resolvePool });
  const recs = () => { try { return fs.readFileSync(path.join(dir, 'bottom_marks.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const obs = (price, over = {}) => bw.observe(view({ address: MINT, symbol: 'BTM', price, mc: price * 10000, buysM5: 30, sellsM5: 10, ...over }), clock.t);
  return { dir, journal, clock, bw, recs, obs };
}

// peak 100 at T0, then a dump to `low` that opens the episode at T0+10s
function dumpTo(r, low) {
  r.obs(100);
  r.clock.t += 10000;
  r.obs(low);
}

// ---- pure flow read ----
test('flowOf: known only when at least one side printed; share is a fraction', () => {
  assert.deepEqual(flowOf({ buysM5: 30, sellsM5: 10 }), { known: true, buys: 30, sells: 10, share: 0.75 });
  assert.equal(flowOf({ buysM5: 0, sellsM5: 0 }).known, false);   // 0/0 is indistinguishable from no data
  assert.equal(flowOf({ buysM5: null, sellsM5: 5 }).known, false);
  assert.equal(flowOf({}).known, false);
  assert.equal(flowOf({ buysM5: 0, sellsM5: 7 }).share, 0);
});

// ---- config ----
test('config: BOTTOM_WATCH defaults on, dials parse, junk rejected', () => {
  const c = loadConfig({});
  assert.equal(c.bottomWatch, 1);
  assert.equal(c.bottomDropPct, 50);
  assert.equal(c.bottomQuietMin, 3);
  assert.equal(c.bottomMovePct, 18);
  assert.equal(c.bottomExpireMin, 60);
  assert.deepEqual(validateConfig(loadConfig({})), []);
  assert.equal(loadConfig({ BOTTOM_WATCH: '0' }).bottomWatch, 0);
  assert.equal(loadConfig({ BOTTOM_DROP_PCT: '60' }).bottomDropPct, 60);
  assert.ok(validateConfig(loadConfig({ BOTTOM_WATCH: '2' })).some(e => e.includes('BOTTOM_WATCH')));
  assert.ok(validateConfig(loadConfig({ BOTTOM_DROP_PCT: '150' })).some(e => e.includes('BOTTOM_DROP_PCT')));
  assert.ok(validateConfig(loadConfig({ BOTTOM_DROP_PCT: '100' })).some(e => e.includes('BOTTOM_DROP_PCT')));
  assert.ok(validateConfig(loadConfig({ BOTTOM_MOVE_PCT: '0' })).some(e => e.includes('BOTTOM_MOVE_PCT')));
  assert.ok(validateConfig(loadConfig({ BOTTOM_EXPIRE_MIN: '5' })).some(e => e.includes('BOTTOM_EXPIRE_MIN')));
});

// ---- episode threshold ----
test('episode opens only at >= 50% drawdown off the watched peak', () => {
  const r = rig();
  r.obs(100);
  r.clock.t += 10000; r.obs(60);            // -40%: nothing
  r.clock.t += 10000; r.obs(50.5);          // -49.5%: nothing
  assert.equal(r.recs().filter(x => x.type === 'episode').length, 0);
  assert.equal(r.bw.pendingMints().length, 0);
  r.clock.t += 10000; r.obs(50);            // exactly -50%: episode
  const eps = r.recs().filter(x => x.type === 'episode');
  assert.equal(eps.length, 1);
  assert.equal(eps[0].peakPrice, 100);
  assert.equal(eps[0].drawdownPct, 50);
  assert.equal(eps[0].source, 'watched');
  assert.deepEqual(r.bw.pendingMints(), [{ mint: MINT, since: r.clock.t }]);
  // the running peak is frozen for the episode: a partial bounce then a
  // fresh leg down updates the LOW, never re-opens or re-peaks
  r.clock.t += 10000; r.obs(70);            // bounce, still in episode
  r.clock.t += 10000; r.obs(45);            // new low
  assert.equal(r.recs().filter(x => x.type === 'episode').length, 1);
});

// ---- quiet clock ----
test('quiet clock: the bottom must hold BOTTOM_QUIET_MIN with no new low; a new low resets it', () => {
  const r = rig();
  dumpTo(r, 50);                            // episode at T0+10s, low 50
  r.clock.t += 60 * 1000; r.obs(40);        // new low 40 at +60s — clock restarts here
  r.clock.t += 150 * 1000;                  // 2.5 min of quiet — not enough
  assert.equal(r.obs(47.2), null);          // +18% off the low, but the bottom is not established
  assert.equal(r.recs().filter(x => x.type === 'mark').length, 0);
  r.clock.t += 30 * 1000;                   // exactly 3 min of quiet
  const mark = r.obs(47.2);
  assert.ok(mark);
  assert.equal(mark.lowPrice, 40);
  assert.equal(mark.quietSec, 180);
  assert.equal(mark.pctOffLow, 18);
  assert.equal(mark.drawdownPct, 60);
});

test('quiet clock: a fresh low late in the window pushes the mark out', () => {
  const r = rig();
  dumpTo(r, 50);
  r.clock.t += 170 * 1000; r.obs(49);       // lower low at 2m50s of quiet
  r.clock.t += 20 * 1000;                   // 3m10s since the EPISODE low, only 20s since the new low
  assert.equal(r.obs(49 * 1.18), null);
  r.clock.t += 160 * 1000;                  // now 3 min since the 49 low
  assert.ok(r.obs(49 * 1.18));
});

// ---- the mark + flow rule ----
test('mark fires at the move threshold with flow back; record carries the full geometry', () => {
  const r = rig();
  dumpTo(r, 40);                            // -60% straight down, low 40
  r.clock.t += 3 * M;
  const mark = r.obs(47.2, { buysM5: 45, sellsM5: 15 });
  assert.ok(mark);
  assert.equal(mark.type, 'mark');
  assert.equal(mark.peakPrice, 100);
  assert.equal(mark.lowPrice, 40);
  assert.equal(mark.markPrice, 47.2);
  assert.equal(mark.pctOffLow, 18);
  assert.equal(mark.drawdownPct, 60);
  assert.equal(mark.flowKnown, true);
  assert.equal(mark.buyShare, 0.75);
  assert.equal(mark.source, 'watched');
  assert.ok(mark.markId.endsWith('-m1'));
  // episode closed by the mark
  const ends = r.recs().filter(x => x.type === 'episode-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'marked');
  assert.equal(r.bw.pendingMints().length, 0);
});

test('mark waits when flow is known but has NOT come back (share < 0.5)', () => {
  const r = rig();
  dumpTo(r, 40);
  r.clock.t += 3 * M;
  assert.equal(r.obs(47.2, { buysM5: 5, sellsM5: 30 }), null);  // +18% on a sell tape: no mark
  r.clock.t += 60 * 1000;
  const mark = r.obs(52, { buysM5: 30, sellsM5: 10 });          // +30% with buyers back: mark
  assert.ok(mark);
  assert.equal(mark.pctOffLow, 30);
});

test('mark fires on price alone with flowKnown:false when the view carries no usable flow', () => {
  const r = rig();
  dumpTo(r, 40);
  r.clock.t += 3 * M;
  const mark = r.obs(47.2, { buysM5: 0, sellsM5: 0 });
  assert.ok(mark);
  assert.equal(mark.flowKnown, false);
  assert.equal(mark.buyShare, null);
});

// ---- one mark per episode / re-arm ----
test('one mark per episode; a fresh episode needs a new dump off the restarted cycle', () => {
  const r = rig();
  dumpTo(r, 40);
  r.clock.t += 3 * M;
  assert.ok(r.obs(47.2));
  // continued strength after the mark never re-fires
  r.clock.t += 60 * 1000; assert.equal(r.obs(60), null);
  r.clock.t += 60 * 1000; assert.equal(r.obs(80), null);
  // a shallow dip off the new peak does not reopen
  r.clock.t += 60 * 1000; assert.equal(r.obs(56), null);        // -30% off 80: nothing
  assert.equal(r.recs().filter(x => x.type === 'episode').length, 1);
  // a full dump off the new cycle's peak opens episode #2
  r.clock.t += 60 * 1000; r.obs(40);                             // -50% off 80
  assert.equal(r.recs().filter(x => x.type === 'episode').length, 2);
  r.clock.t += 3 * M;
  const mark2 = r.obs(47.2);
  assert.ok(mark2);
  assert.notEqual(mark2.markId, r.recs().find(x => x.type === 'mark').markId);
  assert.equal(r.recs().filter(x => x.type === 'mark').length, 2);
});

// ---- source tag ----
test('source tag: a mint the bot held and closed is bot-exited, on episode and mark alike', () => {
  const r = rig({ wasExited: (m) => m === MINT });
  dumpTo(r, 40);
  assert.equal(r.recs().find(x => x.type === 'episode').source, 'bot-exited');
  r.clock.t += 3 * M;
  assert.equal(r.obs(47.2).source, 'bot-exited');
});

// ---- episode endings ----
test('episode closes unmarked on full recovery to the episode peak', () => {
  const r = rig();
  dumpTo(r, 40);
  r.clock.t += 60 * 1000;
  r.obs(101, { buysM5: 5, sellsM5: 30 });   // ripped straight back through the peak — no mark judged on the way
  const ends = r.recs().filter(x => x.type === 'episode-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'recovered');
  assert.equal(r.recs().filter(x => x.type === 'mark').length, 0);
  assert.equal(r.bw.pendingMints().length, 0);
});

test('episode ends stale when the mint leaves the sampling orbit', async () => {
  const r = rig();
  dumpTo(r, 40);
  assert.equal(r.bw.pendingMints().length, 1);
  r.clock.t += 61 * M;
  await r.bw.tick(r.clock.t);
  const ends = r.recs().filter(x => x.type === 'episode-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'stale');
  assert.equal(r.bw.pendingMints().length, 0);
});

// ---- state survives a restart (peak + open episode restored) ----
test('restart: an open episode and its low survive via the state file', () => {
  const r = rig();
  dumpTo(r, 40);                            // episode open, low 40
  const bw2 = new BottomWatch({ cfg: { bottomWatch: 1, bottomDropPct: 50, bottomQuietMin: 3, bottomMovePct: 18, bottomExpireMin: 60 }, journal: r.journal, dir: r.dir, now: () => r.clock.t });
  assert.equal(bw2.pendingMints().length, 1);
  r.clock.t += 3 * M;
  const mark = bw2.observe(view({ address: MINT, symbol: 'BTM', price: 47.2, mc: 472000, buysM5: 30, sellsM5: 10 }), r.clock.t);
  assert.ok(mark);
  assert.equal(mark.lowPrice, 40);          // the pre-restart low, not a restarted cycle
  assert.equal(mark.peakPrice, 100);
});

// ---- scoring ----
function candlesFrom(markTs, markPrice, minutes, gain = 0.1) {
  // 5m candles from 5 min before the mark to `minutes` after it, closes at
  // markPrice x (1+gain), highs a touch above — scoreMark reads r15/r60/
  // r240 off the closes and peakPct off the highs.
  const out = [];
  const start = Math.floor((markTs - 300000) / 1000);
  for (let t = start; t * 1000 <= markTs + minutes * 60000; t += 300) {
    const c = markPrice * (1 + gain);
    out.push([t, markPrice, c * 1.05, markPrice * 0.98, c, 1000]);
  }
  return out;
}

test('scoring: marks finalize forward via the candle tailer; the card aggregates them', async () => {
  let markTs = 0, markPrice = 0;
  const r = rig({
    resolvePool: async () => 'POOL',
    fetchCandles: async () => candlesFrom(markTs, markPrice, 420),
  });
  dumpTo(r, 40);
  r.clock.t += 3 * M;
  const mark = r.obs(47.2);
  markTs = mark.ts; markPrice = mark.markPrice;
  // too young: no score yet
  await r.bw.tick(r.clock.t);
  assert.equal(r.recs().filter(x => x.type === 'mark-score').length, 0);
  // +70 min: r15 + r60 exist, not final (no r240, young)
  r.clock.t += 70 * M;
  await r.bw.tick(r.clock.t);
  const scores = r.recs().filter(x => x.type === 'mark-score');
  assert.equal(scores.length, 1);
  assert.equal(scores[0].final, false);
  assert.ok(Math.abs(scores[0].r60 - 0.1) < 1e-9);
  assert.ok(Math.abs(scores[0].r15 - 0.1) < 1e-9);
  assert.equal(scores[0].r240, null);
  const card = r.bw.card();
  assert.equal(card.enabled, true);
  assert.equal(card.marks, 1);
  assert.equal(card.finalized, 1);          // finalized = r60 present, the house convention
  assert.equal(card.ready, false);
  assert.equal(card.aggregates.medianR60, 0.1);
  assert.equal(card.bySource.watched.finalized, 1);
  assert.equal(card.bySource['bot-exited'].n, 0);
  assert.equal(card.byBand.lt25.n, 1);      // pctOffLow 18 < 25
  assert.equal(card.recent[0].markId, mark.markId);
  assert.equal(card.recent[0].score.r60, 0.1);
  // +400 min: r240 fills -> final; no further score writes afterwards
  r.clock.t = markTs + 400 * M;
  await r.bw.tick(r.clock.t);
  const scores2 = r.recs().filter(x => x.type === 'mark-score');
  assert.equal(scores2.length, 2);
  assert.equal(scores2[1].final, true);
  assert.ok(Math.abs(scores2[1].r240 - 0.1) < 1e-9);
  await r.bw.tick(r.clock.t + 10 * M);
  assert.equal(r.recs().filter(x => x.type === 'mark-score').length, 2);
});

test('card: empty journal reads as a zeroed, not-ready card', () => {
  const r = rig();
  const card = r.bw.card();
  assert.equal(card.marks, 0);
  assert.equal(card.finalized, 0);
  assert.equal(card.ready, false);
  assert.equal(card.aggregates.medianPeak, null);
  assert.equal(BOTTOM_READY_N, 30);
  const folded = foldBottomJournal([]);
  assert.equal(folded.marks.size, 0);
  assert.equal(buildBottomCard([], Date.now()).episodes, 0);
});

// ---- kill switch ----
test('kill switch: BOTTOM_WATCH=0 — no observing, no records, card off', async () => {
  const r = rig({ cfgOver: { bottomWatch: 0 } });
  dumpTo(r, 40);
  r.clock.t += 3 * M;
  assert.equal(r.obs(47.2), null);
  await r.bw.tick(r.clock.t);
  assert.equal(r.recs().length, 0);
  assert.equal(r.bw.pendingMints().length, 0);
  assert.deepEqual(r.bw.card(), { enabled: false });
  assert.equal(fs.existsSync(path.join(r.dir, 'bottom_watch_state.json')), false);
});

// ---- inertness pin (Bot level) ----
test('inertness: feeding the tracker never signals, never positions, writes only its own file', () => {
  const mk = (env) => {
    const cfg = testCfg({ fastPop: 0, dipStopPct: 0 }, env);
    const clock = { t: T0 };
    const exec = { solBalance: async () => 5, markValue: async () => 0, sell: async () => ({ tokensSold: '0', solOut: 0, sig: null, simulated: true }), closeEmptyAccounts: async () => {} };
    const bot = new Bot(cfg, { now: () => clock.t, exec, discover: async () => new Map(), fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [] });
    return { cfg, bot, clock };
  };
  const feed = ({ bot, clock }) => {
    bot.bottomWatch.observe(view({ address: MINT, symbol: 'BTM', price: 100, mc: 1000000 }), clock.t);
    clock.t += 10000;
    bot.bottomWatch.observe(view({ address: MINT, symbol: 'BTM', price: 40, mc: 400000 }), clock.t);
    clock.t += 3 * M;
    bot.bottomWatch.observe(view({ address: MINT, symbol: 'BTM', price: 47.2, mc: 472000 }), clock.t);
  };
  const on = mk({});                        // BOTTOM_WATCH defaults on
  feed(on);
  const bwFile = path.join(on.cfg.dataDir, 'bottom_marks.jsonl');
  assert.ok(fs.existsSync(bwFile));
  assert.ok(fs.readFileSync(bwFile, 'utf8').includes('"mark"'));
  // ...and nothing else moved: no signals, no trades, no positions
  assert.equal(on.bot.journal.signals.length, 0);
  assert.equal(on.bot.journal.trades.length, 0);
  assert.equal(on.bot.positions.length, 0);
  assert.equal(on.bot.stats.signals, 0);
  assert.equal(on.bot.stats.entries, 0);

  const off = mk({ BOTTOM_WATCH: '0' });
  feed(off);
  assert.equal(fs.existsSync(path.join(off.cfg.dataDir, 'bottom_marks.jsonl')), false);
  assert.equal(off.bot.journal.signals.length, 0);
  assert.equal(off.bot.positions.length, 0);

  // a signal journaled beside the tracker is byte-identical on vs off
  const sigArgs = { mint: MINT, symbol: 'BTM', setup: 'pop', decision: 'skipped', reasons: ['test'], price: 1, mc: 1000 };
  on.bot.journal.signal(sigArgs);
  off.bot.journal.signal(sigArgs);
  const read = (cfg) => fs.readFileSync(path.join(cfg.dataDir, 'signals.jsonl'), 'utf8').trim();
  assert.equal(read(on.cfg), read(off.cfg));
});

// ---- peak qualifier (owner refinement 2026-10-16: retrace setups are
// coins that RAN first; sub-floor peaks are dust — journaled + scored in
// their own bucket, never alerted, never in the headline numbers) ----
test('config: BOTTOM_MIN_PEAK_MC defaults to 25000, parses, junk rejected', () => {
  assert.equal(loadConfig({}).bottomMinPeakMc, 25000);
  assert.equal(loadConfig({ BOTTOM_MIN_PEAK_MC: '40000' }).bottomMinPeakMc, 40000);
  assert.ok(validateConfig(loadConfig({ BOTTOM_MIN_PEAK_MC: '0' })).some(e => e.includes('BOTTOM_MIN_PEAK_MC')));
  assert.ok(validateConfig(loadConfig({ BOTTOM_MIN_PEAK_MC: '-5' })).some(e => e.includes('BOTTOM_MIN_PEAK_MC')));
});

test('qualifiesPeak / recoveredPctOf: pure units', () => {
  assert.equal(qualifiesPeak(25000, 25000), true);       // exactly at the floor qualifies
  assert.equal(qualifiesPeak(24999, 25000), false);
  assert.equal(qualifiesPeak(100000, 25000), true);
  assert.equal(qualifiesPeak(null, 25000), false);       // unknown peak can never prove the coin ran
  assert.equal(qualifiesPeak(100000, null), false);
  assert.equal(recoveredPctOf(472000, 1000000), 47.2);
  assert.equal(recoveredPctOf(25000, 100000), 25);
  assert.equal(recoveredPctOf(null, 100000), null);
  assert.equal(recoveredPctOf(50000, null), null);
});

test('qualified mark: a run that peaked above the floor stamps qualified + recovered %', () => {
  const r = rig();                                       // rig mc = price x 10000, peak 100 -> peakMc $1,000,000
  dumpTo(r, 40);
  r.clock.t += 3 * M;
  const mark = r.obs(47.2);
  assert.ok(mark);
  assert.equal(mark.qualified, true);
  assert.equal(mark.peakMc, 1000000);
  assert.equal(mark.markMc, 472000);
  assert.equal(mark.pctOfPeakRecovered, 47.2);            // the mark sits at 47.2% of the old peak mc
  const card = r.bw.card();
  assert.equal(card.marks, 1);
  assert.equal(card.marksQualified, 1);
  assert.equal(card.marksDust, 0);
  assert.equal(card.minPeakMc, 25000);
  assert.equal(card.aggregates.n, 1);
  assert.equal(card.recent[0].qualified, true);
  assert.equal(card.recent[0].pctOfPeakRecovered, 47.2);
});

test('dust mark: a peak under the floor still journals + scores, but in its own bucket', async () => {
  let markTs = 0, markPrice = 0;
  const r = rig({
    cfgOver: { bottomMinPeakMc: 2000000 },               // floor above the rig's $1M peak -> dust
    resolvePool: async () => 'POOL',
    fetchCandles: async () => candlesFrom(markTs, markPrice, 420),
  });
  dumpTo(r, 40);
  r.clock.t += 3 * M;
  const mark = r.obs(47.2);
  assert.ok(mark);                                       // the mark still fires — the dataset doesn't go blind
  assert.equal(mark.qualified, false);
  markTs = mark.ts; markPrice = mark.markPrice;
  r.clock.t += 70 * M;
  await r.bw.tick(r.clock.t);                            // dust marks forward-score like any other
  assert.equal(r.recs().filter(x => x.type === 'mark-score').length, 1);
  const card = r.bw.card();
  assert.equal(card.marks, 1);
  assert.equal(card.marksQualified, 0);
  assert.equal(card.marksDust, 1);
  assert.equal(card.finalized, 0);                       // headline readiness counts qualified only
  assert.equal(card.finalizedAll, 1);
  assert.equal(card.aggregates.n, 0);
  assert.equal(card.aggregates.medianR60, null);
  assert.equal(card.aggregatesAll.n, 1);
  assert.equal(card.aggregatesAll.medianR60, 0.1);
  assert.equal(card.byQualifier.qualified.n, 0);
  assert.equal(card.byQualifier.dust.n, 1);
  assert.equal(card.byQualifier.dust.finalized, 1);
  assert.equal(card.recent[0].qualified, false);         // the alert hook's filter reads exactly this flag
});

test('legacy marks (no qualifier stamp) derive qualified + recovered % from their peak mc at card time', () => {
  const base = { type: 'mark', ts: T0, mint: MINT, symbol: 'LG', source: 'watched', lowPrice: 1, lowMc: 4000, drawdownPct: 73.3, quietSec: 200, markPrice: 1.3, pctOffLow: 30, flowKnown: true, buysM5: 30, sellsM5: 10, buyShare: 0.75 };
  const recs = [
    { ...base, markId: 'bw-AAAAAA-1-m1', episodeId: 'bw-AAAAAA-1', peakPrice: 3.7, peakMc: 15000, markMc: 5500 },   // SOFA-class: peaked ~$15k — dust
    { ...base, markId: 'bw-BBBBBB-2-m1', episodeId: 'bw-BBBBBB-2', peakPrice: 10, peakMc: 100000, markMc: 13000 },  // ran to $100k — qualified
    { type: 'mark-score', markId: 'bw-AAAAAA-1-m1', ts: T0 + 70 * M, r15: 0.1, r60: 0.2, r240: null, peakPct: 0.4, worstDipPct: -0.1, final: false },
    { type: 'mark-score', markId: 'bw-BBBBBB-2-m1', ts: T0 + 70 * M, r15: 0.1, r60: 0.5, r240: null, peakPct: 0.9, worstDipPct: -0.1, final: false },
  ];
  const card = buildBottomCard(recs, T0 + 80 * M, { minPeakMc: 25000 });
  assert.equal(card.marks, 2);
  assert.equal(card.marksQualified, 1);
  assert.equal(card.marksDust, 1);
  assert.equal(card.finalized, 1);                       // only the qualified score counts toward readiness
  assert.equal(card.finalizedAll, 2);
  assert.equal(card.aggregates.medianR60, 0.5);          // headline = the qualified mark's score
  assert.equal(card.aggregatesAll.medianR60, 0.35);
  const dustRow = card.recent.find(x => x.markId === 'bw-AAAAAA-1-m1');
  const qualRow = card.recent.find(x => x.markId === 'bw-BBBBBB-2-m1');
  assert.equal(dustRow.qualified, false);
  assert.equal(qualRow.qualified, true);
  assert.equal(dustRow.pctOfPeakRecovered, 36.7);        // 5500 / 15000
  assert.equal(qualRow.pctOfPeakRecovered, 13);         // 13000 / 100000
  // an explicit stamp always wins over derivation
  const stamped = buildBottomCard([{ ...base, markId: 'bw-CCCCCC-3-m1', episodeId: 'bw-CCCCCC-3', peakMc: 15000, markMc: 5500, qualified: true }], T0, { minPeakMc: 25000 });
  assert.equal(stamped.marksQualified, 1);
});
