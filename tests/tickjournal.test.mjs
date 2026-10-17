// tickjournal.test.mjs — the position-tick journal (user 2026-10-16):
// RECORD-ONLY. Every position check appends ONE compact record of what the
// bot itself saw when it judged (quote ratio, net gain as exits.js computes
// it, stage, running peak, 5m buy share / buy / sell counts, mc) to
// position_ticks.jsonl — the dataset the bracket classifier needs and that
// previously existed nowhere (in-memory flowHist only; measurement pass
// 2026-10-16, workstream D). Pins: one record per check with the right
// fields, stage names off the TP flags, the no-quote check still records
// (nulls, never invented values), the kill switch suppresses writes AND the
// counter, and — the load-bearing pin — decisions are IDENTICAL with the
// journal on and off (a moonbag-trail exit runs the same trade either way).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_800_000_000_000;

function rig(over = {}) {
  const cfg = testCfg({ fastPop: 0, dipStopPct: 0, bagTrailConfirmSec: 0, ...over }); // trail timer off here: this file pins the trail's fire, the timer is pinned in bagtrailconfirm.test.mjs
  const clock = { t: T0 };
  const r = { cfg, clock, mark: 0, markThrows: false };
  r.exec = {
    solBalance: async () => 5,
    markValue: async () => { if (r.markThrows) throw new Error('no quote'); return r.mark; },
    sell: async (mint, raw) => ({ tokensSold: raw, solOut: r.mark, sig: null, simulated: true }),
    closeEmptyAccounts: async () => {},
  };
  r.bot = new Bot(cfg, {
    now: () => clock.t, exec: r.exec,
    discover: async () => new Map(), fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  r.bot.latest.set('MINT1', view({ buysM5: 30, sellsM5: 10, mc: 123_456, liq: 55_000, volH1: 777 }));
  r.pos = (o = {}) => ({
    id: 'p1', mint: 'MINT1', symbol: 'TICK', setup: 'pop', entrySol: 0.1, tokensRaw: '1000000',
    remainingFrac: 1, entryRoundTrip: 0.972, peakRatio: 1, peakMove: 1, entryTs: T0,
    realizedSol: 0, feesSol: 0, simulated: true, ...o,
  });
  r.ticks = () => {
    try { return fs.readFileSync(path.join(cfg.dataDir, 'position_ticks.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch { return []; }
  };
  return r;
}

// ---- config ----
test('tick journal config: defaults on, validates clean; TICK_JOURNAL=0 is the designed off', () => {
  const c = loadConfig({});
  assert.equal(c.tickJournal, 1);
  assert.equal(validateConfig(c).length, 0);
  assert.equal(loadConfig({ TICK_JOURNAL: '0' }).tickJournal, 0);
  assert.equal(validateConfig(loadConfig({ TICK_JOURNAL: '0' })).length, 0);
  assert.ok(validateConfig(loadConfig({ TICK_JOURNAL: '2' })).some(e => e.includes('TICK_JOURNAL')));
});

// ---- one record per check, the check's own numbers ----
test('managePosition: one tick per check carrying the check’s own marks', async () => {
  const r = rig();
  const pos = r.pos();
  r.bot.positions.push(pos);
  r.mark = 0.105; // ratio 1.05 on the 0.1 basis
  await r.bot.managePosition(pos, 150);
  const recs = r.ticks();
  assert.equal(recs.length, 1);
  const t = recs[0];
  assert.equal(t.ts, T0);
  assert.equal(t.id, 'p1');
  assert.equal(t.mint, 'MINT1');
  assert.equal(t.stage, 'preTp1');
  assert.equal(t.ratio, 1.05);
  // net gain exactly as exits.js judges it: ratio - 1 - 3*txFeeSol/basis,
  // off the UNROUNDED ratio (0.105 / 0.1 in floating point, as exits.js sees it)
  const feeFrac = (3 * (r.cfg.txFeeSol || 0)) / 0.1;
  assert.equal(t.gainPct, +(((0.105 / 0.1) - 1 - feeFrac) * 100).toFixed(2));
  assert.equal(t.peakRatio, 1.05); // this check's peak update is included
  assert.equal(t.valueSol, 0.105);
  assert.equal(t.buyShare, 0.75);  // 30 / (30 + 10) from the view the check held
  assert.equal(t.buysM5, 30);
  assert.equal(t.sellsM5, 10);
  assert.equal(t.txM5, 40);
  assert.equal(t.mc, 123_456);
  assert.equal(t.liq, 55_000);
  assert.equal(t.volH1, 777);
  assert.deepEqual(r.bot.stats.tickJournal, { records: 1, lastTs: T0 });

  // a second check 4s later appends a second record (no throttling, no dedupe)
  r.clock.t += 4000;
  r.mark = 0.09;
  await r.bot.managePosition(pos, 150);
  const recs2 = r.ticks();
  assert.equal(recs2.length, 2);
  assert.equal(recs2[1].ts, T0 + 4000);
  assert.equal(recs2[1].ratio, 0.9);
  assert.equal(recs2[1].peakRatio, 1.05); // the peak so far rides along
  assert.deepEqual(r.bot.stats.tickJournal, { records: 2, lastTs: T0 + 4000 });
});

// ---- stage names off the TP flags ----
test('managePosition: stage follows tp1Done/tp2Done (preTp1 → middle → moonbag)', async () => {
  const r = rig();
  const mid = r.pos({ id: 'p2', tp1Done: true, remainingFrac: 0.6 });
  const bag = r.pos({ id: 'p3', tp1Done: true, tp2Done: true, remainingFrac: 0.25, peakRatio: 2, peakMove: 2 });
  r.bot.positions.push(mid, bag);
  r.mark = 0.05; // mid: ratio 0.05/0.06 < 1 (no fire); bag: 0.05/0.025 = 2.0, at its peak (no trail fire)
  await r.bot.managePosition(mid, 150);
  await r.bot.managePosition(bag, 150);
  const recs = r.ticks();
  assert.equal(recs.length, 2);
  assert.equal(recs.find(t => t.id === 'p2').stage, 'middle');
  assert.equal(recs.find(t => t.id === 'p3').stage, 'moonbag');
});

// ---- a check that cannot price still records — with nulls, never inventions ----
test('managePosition: no-quote check records ratio/gain as null and still counts', async () => {
  const r = rig();
  const pos = r.pos();
  r.bot.positions.push(pos);
  r.markThrows = true;
  await r.bot.managePosition(pos, 150);
  const recs = r.ticks();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].ratio, null);
  assert.equal(recs[0].gainPct, null);
  assert.equal(recs[0].valueSol, null);
  assert.equal(recs[0].stage, 'preTp1');
  assert.equal(recs[0].peakRatio, 1); // the stored peak so far, untouched
  assert.equal(recs[0].buysM5, 30);   // the view's flow was still in hand
  assert.equal(pos.markFails, 1);     // the check itself behaved exactly as today
  assert.deepEqual(r.bot.stats.tickJournal, { records: 1, lastTs: T0 });
});

// ---- the kill switch: no writes, no counter, management unchanged ----
test('kill switch: TICK_JOURNAL=0 writes nothing and counts nothing; the position is still managed', async () => {
  const r = rig({ tickJournal: 0 });
  const pos = r.pos();
  r.bot.positions.push(pos);
  r.mark = 0.105;
  await r.bot.managePosition(pos, 150);
  assert.equal(fs.existsSync(path.join(r.cfg.dataDir, 'position_ticks.jsonl')), false);
  assert.deepEqual(r.ticks(), []);
  assert.deepEqual(r.bot.stats.tickJournal, { records: 0, lastTs: 0 });
  assert.equal(pos.peakRatio, 0.105 / 0.1); // judged and updated exactly as with the journal on
  assert.equal(r.bot.positions.length, 1);
});

// ---- decisions are identical with the journal on and off ----
test('decisions identical on/off: a moonbag-trail exit executes the same trade either way', async () => {
  const run = async (over) => {
    const r = rig(over);
    // post-TP2 remainder: basis 0.1 * 0.25 = 0.025, peak 2.0x; mark puts the
    // ratio at 1.2 — below peak * (1 - bagTrailPct) — the bag trail fires.
    const pos = r.pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.25, tokensRaw: '250000', peakRatio: 2, peakMove: 2 });
    r.bot.positions.push(pos);
    r.mark = 0.025 * 1.2;
    await r.bot.managePosition(pos, 150);
    return r;
  };
  const on = await run({});
  const off = await run({ tickJournal: 0 });
  assert.equal(on.bot.positions.length, 0, 'trail exit closed the position (journal on)');
  assert.equal(off.bot.positions.length, 0, 'trail exit closed the position (journal off)');
  const shape = b => b.journal.trades.filter(t => t.type === 'sell' || t.type === 'close')
    .map(t => [t.type, t.reason, t.fraction ?? null, t.solOut ?? null, t.pnlSol ?? null]);
  assert.deepEqual(shape(on.bot), shape(off.bot));
  assert.ok(shape(on.bot).some(([ty, reason]) => ty === 'sell' && /moonbag trail/.test(reason)));
  // and only the on-run left tick records — including the firing check itself
  const recs = on.ticks();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].stage, 'moonbag');
  assert.equal(recs[0].ratio, 1.2);
  assert.deepEqual(off.ticks(), []);
});
