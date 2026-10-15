// ratchetStream.test.mjs — STREAM ratchet judge v2 (user 2026-10-15, RECORD-ONLY).
// The tick judge (ratchetShadow.test.mjs) asks its question on 4s quote polls;
// this one asks the same question as trades land, on a stream-VWAP basis
// measured from the actual entry fill. Pins: VWAP math + the dust defense,
// the single-print no-opinion rule, the eval throttle, stream arm/fire on a
// synthetic sequence, both-armed cross-tagging (would-fire records on BOTH
// judges + leadSec on the completion), fire-quality probes, stream coverage
// on completions, the shadow-book sample (separate source + counters), and
// the /ratchetshadow surface. The judge must never influence an exit —
// nothing here touches exits.js; the live paths are pinned by the v1 suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ShadowFlow } from '../src/ratchetShadow.js';
import { Bot } from '../src/bot.js';
import { startServer } from '../src/server.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_800_000_000_000;
const ENTRY = 0.0002; // SOL/token entry fill used across the rigs (stream price basis)

// ---- VWAP basis (ShadowFlow) ----
test('stream vwap: Σsol/Σtokens over the window, print count rides along', () => {
  const f = new ShadowFlow();
  f.note('M', { ts: T0, side: 'buy', sol: 1.0, tokens: 5000 });       // 0.0002
  f.note('M', { ts: T0 + 500, side: 'sell', sol: 0.6, tokens: 2000 }); // 0.0003
  const vw = f.vwap('M', T0 + 500, 2);
  assert.equal(vw.prints, 2);
  assert.ok(Math.abs(vw.price - 1.6 / 7000) < 1e-12);
  assert.equal(vw.sol, 1.6);
});

test('stream vwap: stale prints fall out; unpriced prints and unknown mints are null', () => {
  const f = new ShadowFlow();
  f.note('M', { ts: T0, side: 'buy', sol: 1.0, tokens: 5000 });
  assert.equal(f.vwap('M', T0 + 10000, 2), null);       // outside the 2s window
  assert.equal(f.vwap('UNKNOWN', T0, 2), null);
  f.note('U', { ts: T0, side: 'sell', sol: 5 });        // no token amount — unpriced
  assert.equal(f.vwap('U', T0, 2), null);
});

test('stream vwap: dust prints cannot move the basis (the fake-peak / fake-fade defense)', () => {
  const f = new ShadowFlow();
  f.note('M', { ts: T0, side: 'buy', sol: 1.0, tokens: 5000 });
  f.note('M', { ts: T0 + 500, side: 'buy', sol: 1.0, tokens: 5000 });
  const clean = f.vwap('M', T0 + 500, 2).price;
  assert.ok(Math.abs(clean - 0.0002) < 1e-12);
  f.note('M', { ts: T0 + 1000, side: 'buy', sol: 0.001, tokens: 0.001 }); // print price 1.0 — 5000× spot
  f.note('M', { ts: T0 + 1200, side: 'sell', sol: 0.0001, tokens: 5 });   // print price 0.00002 — 10× under spot
  const dirty = f.vwap('M', T0 + 1200, 2);
  assert.equal(dirty.prints, 4);
  assert.ok(Math.abs(dirty.price - clean) / clean < 0.001, `dust moved the VWAP by ${Math.abs(dirty.price - clean) / clean}`);
});

// ---- config ----
test('stream judge config: defaults load and validate clean', () => {
  const c = loadConfig({});
  assert.equal(c.ratchetStreamEvalMs, 300);
  assert.equal(c.ratchetStreamVwapSec, 2);
  assert.equal(validateConfig(c).length, 0);
});

test('stream judge config: nonsense knob values are rejected', () => {
  assert.ok(validateConfig(loadConfig({ RATCHET_STREAM_EVAL_MS: '10' })).some(e => e.includes('RATCHET_STREAM_EVAL_MS')));
  assert.ok(validateConfig(loadConfig({ RATCHET_STREAM_EVAL_MS: '6000' })).some(e => e.includes('RATCHET_STREAM_EVAL_MS')));
  assert.ok(validateConfig(loadConfig({ RATCHET_STREAM_VWAP_SEC: '0' })).some(e => e.includes('RATCHET_STREAM_VWAP_SEC')));
  assert.ok(validateConfig(loadConfig({ RATCHET_STREAM_VWAP_SEC: '31' })).some(e => e.includes('RATCHET_STREAM_VWAP_SEC')));
  assert.equal(validateConfig(loadConfig({ RATCHET_STREAM_EVAL_MS: '250', RATCHET_STREAM_VWAP_SEC: '3' })).length, 0);
});

// ---- bot rig (mirrors ratchetShadow.test.mjs, plus an entry fill) ----
function streamRig(over = {}) {
  const cfg = testCfg({ fastPop: 0, dipStopPct: 0, ...over });
  const clock = { t: T0 };
  const rig = { cfg, clock, mark: 0 };
  rig.exec = {
    solBalance: async () => 5,
    markValue: async () => rig.mark,
    sell: async () => ({ tokensSold: '1000000', solOut: rig.mark, sig: null, simulated: true }),
    closeEmptyAccounts: async () => {},
  };
  rig.bot = new Bot(cfg, {
    now: () => clock.t, exec: rig.exec,
    discover: async () => new Map(), fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  rig.pos = (o = {}) => ({
    id: 'p1', mint: 'MINT1', symbol: 'STRM', setup: 'pop', entrySol: 0.1, tokensRaw: '1000000',
    remainingFrac: 1, entryRoundTrip: 0.972, peakRatio: 1, peakMove: 1, entryTs: T0,
    entryFillSol: ENTRY, realizedSol: 0, feesSol: 0, simulated: true, ...o,
  });
  rig.recs = () => {
    try { return fs.readFileSync(path.join(cfg.dataDir, 'ratchet_shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch { return []; }
  };
  rig.flush = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  return rig;
}

// The canonical sequence: two buys print the stream price at +20% (arm), two
// sells walk the VWAP down to ~+4.8% on an exit-wave flow (fire at T0+1500).
function armAndFire(bot, mint) {
  bot.noteTrade(mint, { ts: T0, side: 'buy', sol: 0.3, tokens: 1250 });        // 0.00024
  bot.noteTrade(mint, { ts: T0 + 500, side: 'buy', sol: 0.3, tokens: 1250 });  // 0.00024 → peak 1.2, armed
  bot.noteTrade(mint, { ts: T0 + 1000, side: 'sell', sol: 0.8, tokens: 4000 }); // 0.0002 — sellSol still under the floor
  bot.noteTrade(mint, { ts: T0 + 1500, side: 'sell', sol: 0.8, tokens: 4000 }); // 0.0002 — flow complete: FIRE
}

test('stream judge: a single-print VWAP window is no opinion — no peak, no fire, coverage still counted', () => {
  const r = streamRig();
  const pos = r.pos();
  r.bot.positions.push(pos);
  r.bot.noteTrade('MINT1', { ts: T0, side: 'buy', sol: 0.3, tokens: 1000 }); // one print, +50% print price
  assert.equal(pos.streamPeakMove, undefined);
  r.bot.noteTrade('MINT1', { ts: T0 + 10000, side: 'buy', sol: 0.3, tokens: 1000 }); // 10s later: window again holds exactly one
  assert.equal(pos.streamPeakMove, undefined);
  assert.equal(pos.streamArmed, undefined);
  assert.deepEqual(r.recs(), []);
  assert.equal(pos.streamTrades, 2); // both prints count toward coverage
});

test('stream judge: evaluation is throttled per mint (default 300ms)', () => {
  const r = streamRig();
  const pos = r.pos();
  r.bot.positions.push(pos);
  r.bot.noteTrade('MINT1', { ts: T0, side: 'buy', sol: 0.3, tokens: 1250 });       // evaluates: 1 print, no opinion
  r.bot.noteTrade('MINT1', { ts: T0 + 100, side: 'buy', sol: 0.3, tokens: 1250 }); // throttled — no evaluation
  assert.equal(pos.streamPeakMove, undefined);
  r.bot.noteTrade('MINT1', { ts: T0 + 400, side: 'buy', sol: 0.3, tokens: 1250 }); // evaluates: peak from the VWAP
  assert.ok(Math.abs(pos.streamPeakMove - 1.2) < 1e-9);
  assert.equal(pos.streamArmed, true);
});

test('stream judge: dust buy at 2000× the spot price cannot set the peak', () => {
  const r = streamRig();
  const pos = r.pos();
  r.bot.positions.push(pos);
  r.bot.noteTrade('MINT1', { ts: T0, side: 'buy', sol: 0.3, tokens: 1250 });
  r.bot.noteTrade('MINT1', { ts: T0 + 500, side: 'buy', sol: 0.3, tokens: 1250 });
  assert.ok(Math.abs(pos.streamPeakMove - 1.2) < 1e-9);
  r.bot.noteTrade('MINT1', { ts: T0 + 1000, side: 'buy', sol: 0.001, tokens: 0.002 }); // print price 0.5
  assert.ok(pos.streamPeakMove < 1.21, `dust set the peak: ${pos.streamPeakMove}`); // a max-print peak would read 2500
  assert.deepEqual(r.recs(), []);
});

test('stream judge: arms and fires on the stream basis — record cross-tags the quote judge', async () => {
  const r = streamRig();
  const pos = r.pos({ peakMove: 1.12 }); // the QUOTE judge is armed too (peak +12%)
  r.bot.positions.push(pos);
  r.mark = 0.1 * 1.03 * 0.972;            // fresh Jupiter mark at fire time reads move 1.03
  armAndFire(r.bot, 'MINT1');
  assert.equal(pos.streamFired, true);
  assert.equal(pos.streamFireTs, T0 + 1500);
  r.bot.noteTrade('MINT1', { ts: T0 + 2000, side: 'sell', sol: 0.8, tokens: 4000 }); // still firing conditions — no duplicate
  await r.flush();
  const recs = r.recs();
  assert.equal(recs.length, 1);
  const rec = recs[0];
  assert.equal(rec.kind, 'would-fire-stream');
  assert.equal(rec.source, 'real');
  assert.equal(rec.streamMove, 1.0476);
  assert.equal(rec.streamPeakMove, 1.2);
  assert.equal(rec.sellShare, 0.727);
  assert.equal(rec.sellSol, 1.6);
  assert.equal(rec.buySol, 0.6);
  assert.equal(rec.windowSec, 15);
  assert.equal(rec.jupArmed, true);   // both judges armed on this one
  assert.equal(rec.jupMove, 1.03);    // fresh quote at fire time, not the stale tick move
  assert.equal(r.bot.stats.ratchetShadow.streamWouldFire, 1);
  assert.equal(pos.streamTrades, 5);
});

test('stream judge: quote failure at fire time falls back to the last tick move', async () => {
  const r = streamRig();
  r.exec.markValue = async () => { throw new Error('jupiter down'); };
  const pos = r.pos({ peakMove: 1.12, ratchetShadowMove: 1.09 });
  r.bot.positions.push(pos);
  armAndFire(r.bot, 'MINT1');
  await r.flush();
  const rec = r.recs().find(x => x.kind === 'would-fire-stream');
  assert.ok(rec);
  assert.equal(rec.jupMove, 1.09);
});

test('stream judge: no entry fill price means no opinion (legacy position)', async () => {
  const r = streamRig();
  const pos = r.pos({ entryFillSol: null });
  r.bot.positions.push(pos);
  armAndFire(r.bot, 'MINT1');
  await r.flush();
  assert.equal(pos.streamPeakMove, undefined);
  assert.deepEqual(r.recs(), []);
});

test('tick judge would-fire record carries the stream cross-tags; completion pairs the fires into leadSec', async () => {
  const r = streamRig();
  const pos = r.pos({ peakMove: 1.12 });
  r.bot.positions.push(pos);
  r.mark = 0.1 * 1.03 * 0.972;
  armAndFire(r.bot, 'MINT1');
  r.bot.noteTrade('MINT1', { ts: T0 + 2000, side: 'sell', sol: 0.8, tokens: 4000 });
  await r.flush();
  r.bot.judgeRatchetShadow(pos, 1.02, T0 + 3000); // the quote judge fires 1.5s later on the same flow
  const tick = r.recs().find(x => x.kind === 'would-fire');
  assert.ok(tick);
  assert.equal(tick.streamArmed, true);
  assert.equal(tick.streamFireTs, T0 + 1500);
  assert.equal(pos.ratchetShadowFireTs, T0 + 3000);
  r.bot.ensureClose(pos, { id: 'p1', mint: 'MINT1', symbol: 'STRM', setup: 'pop', pnlSol: 0.001, reason: 'stall (in entry range at 180s, +1.0%)', ts: T0 + 60000 });
  const closed = r.recs().find(x => x.kind === 'closed');
  assert.ok(closed);
  assert.equal(closed.source, 'real');
  assert.equal(closed.streamWouldFire, true);
  assert.equal(closed.streamFireTs, T0 + 1500);
  assert.equal(closed.tickFireTs, T0 + 3000);
  assert.equal(closed.leadSec, 1.5);
  assert.equal(closed.tickArmed, true);
  assert.equal(closed.streamArmed, true);
  assert.equal(closed.streamCovered, true);
  assert.equal(closed.streamTrades, 5);
});

test('completion: a stream-only position lands the record even though the tick judge never armed', async () => {
  const r = streamRig();
  const pos = r.pos(); // peakMove stays 1 — the quote judge never arms
  r.bot.positions.push(pos);
  armAndFire(r.bot, 'MINT1');
  await r.flush();
  r.bot.ensureClose(pos, { id: 'p1', mint: 'MINT1', symbol: 'STRM', setup: 'pop', pnlSol: -0.002, reason: 'bleed exit (-8.0% and still falling)', ts: T0 + 60000 });
  const closed = r.recs().find(x => x.kind === 'closed');
  assert.ok(closed);
  assert.equal(closed.wouldFire, false);
  assert.equal(closed.tickArmed, false);
  assert.equal(closed.streamArmed, true);
  assert.equal(closed.streamWouldFire, true);
  assert.equal(closed.tickFireTs, null);
  assert.equal(closed.leadSec, null);
  assert.equal(closed.streamCovered, true);
  assert.equal(closed.streamTrades, 4);
  assert.equal(r.bot.stats.ratchetShadow.completed, 1);
});

test('fire-quality probes: the quote move at +30s/+60s after a stream fire is journaled', async () => {
  const r = streamRig();
  const pos = r.pos({ peakMove: 1.12 });
  r.bot.positions.push(pos);
  armAndFire(r.bot, 'MINT1');
  await r.flush();
  r.bot.judgeRatchetShadow(pos, 1.01, T0 + 1500 + 31000); // first tick past +30s
  r.bot.judgeRatchetShadow(pos, 0.98, T0 + 1500 + 61500); // first tick past +60s
  const probes = r.recs().filter(x => x.kind === 'fire-quality');
  assert.equal(probes.length, 2);
  assert.equal(probes[0].source, 'real');
  assert.equal(probes[0].atSec, 30);
  assert.equal(probes[0].jupMove, 1.01);
  assert.equal(probes[1].atSec, 60);
  assert.equal(probes[1].jupMove, 0.98);
});

// ---- shadow book sample ----
test('tradeWatchMints: open shadow mints stream after held mints while the judge is on', () => {
  const r = streamRig();
  r.bot.positions.push(r.pos());
  r.bot.shadowTrades.open({ id: 'v1', mint: 'MINTS', symbol: 'VSH', setup: 'trend', price: ENTRY, mc: 50000, ts: T0, sizeSol: 0.1 });
  assert.deepEqual(r.bot.tradeWatchMints(), ['MINT1', 'MINTS']);
});

test('shadow book: the stream judge fires on a virtual — separate source, separate counter', async () => {
  const r = streamRig();
  r.bot.lastSolUsd = 1; // virtual entry 0.0002 USD → 0.0002 SOL/token basis
  r.bot.shadowTrades.open({ id: 'v1', mint: 'MINTS', symbol: 'VSH', setup: 'trend', price: ENTRY, mc: 50000, ts: T0, sizeSol: 0.1 });
  armAndFire(r.bot, 'MINTS');
  await r.flush();
  const recs = r.recs().filter(x => x.kind === 'would-fire-stream');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].source, 'shadow');
  assert.equal(recs[0].id, 'v1');
  assert.equal(recs[0].streamMove, 1.0476);
  assert.equal(recs[0].streamPeakMove, 1.2);
  assert.equal(recs[0].jupArmed, false); // the virtual's own view-peak never armed
  assert.equal(recs[0].jupMove, 1);      // its mark move (never ticked: still at entry)
  assert.equal(r.bot.stats.ratchetShadow.streamShadowWouldFire, 1);
  assert.equal(r.bot.stats.ratchetShadow.streamWouldFire || 0, 0); // never pooled with the real sample
});

test('shadow book: probe on the virtual’s ticks, completion record at finalize', async () => {
  const r = streamRig();
  r.bot.lastSolUsd = 1;
  r.bot.shadowTrades.open({ id: 'v1', mint: 'MINTS', symbol: 'VSH', setup: 'trend', price: ENTRY, mc: 50000, ts: T0, sizeSol: 0.1 });
  armAndFire(r.bot, 'MINTS');
  await r.flush();
  const viewOf = mint => (mint === 'MINTS' ? { price: 0.000196, liq: 5000, buysM5: 10, sellsM5: 10, volH1: 100 } : null);
  r.bot.shadowTrades.tick(viewOf, T0 + 1500 + 31000, r.cfg, 1); // mark move 0.98 at the +30s probe
  const probe = r.recs().find(x => x.kind === 'fire-quality');
  assert.ok(probe);
  assert.equal(probe.source, 'shadow');
  assert.equal(probe.atSec, 30);
  assert.equal(probe.jupMove, 0.98);
  r.bot.shadowTrades.tick(() => null, T0 + 4 * 3600e3 + 1000, r.cfg, 1); // past the 4h cap → finalize
  const closed = r.recs().find(x => x.kind === 'closed');
  assert.ok(closed);
  assert.equal(closed.source, 'shadow');
  assert.equal(closed.streamWouldFire, true);
  assert.equal(closed.streamArmed, true);
  assert.equal(closed.tickArmed, null); // a virtual has no tick judge — never counted in the pairing
  assert.equal(closed.leadSec, null);
  assert.equal(closed.streamCovered, true);
  assert.equal(closed.streamTrades, 4);
  assert.equal(r.bot.shadowStreamState.has('v1'), false); // state cleaned up at close
});

test('one mint both held and shadow-open: buffered once, judged twice', async () => {
  const r = streamRig();
  const pos = r.pos();
  r.bot.positions.push(pos);
  r.bot.lastSolUsd = 1;
  r.bot.shadowTrades.open({ id: 'v9', mint: 'MINT1', symbol: 'STRM', setup: 'trend', price: ENTRY, mc: 50000, ts: T0, sizeSol: 0.1 });
  armAndFire(r.bot, 'MINT1');
  await r.flush();
  const fires = r.recs().filter(x => x.kind === 'would-fire-stream');
  assert.equal(fires.length, 2);
  assert.deepEqual(fires.map(f => f.source).sort(), ['real', 'shadow']);
  assert.equal(pos.streamTrades, 4);
  assert.equal(r.bot.shadowStreamState.get('v9').streamTrades, 4);
});

// ---- /ratchetshadow endpoint ----
test('GET /ratchetshadow serves counters, kind tallies, the arm pairing and coverage', async () => {
  const r = streamRig();
  const pos = r.pos(); // stream-only scenario: the tick judge never arms
  r.bot.positions.push(pos);
  armAndFire(r.bot, 'MINT1');
  await r.flush();
  r.bot.ensureClose(pos, { id: 'p1', mint: 'MINT1', symbol: 'STRM', setup: 'pop', pnlSol: -0.002, reason: 'bleed exit (-8.0% and still falling)', ts: T0 + 60000 });
  const srv = startServer(r.bot, 0);
  try {
    const resp = await fetch(`http://127.0.0.1:${srv.address().port}/ratchetshadow`);
    assert.equal(resp.status, 200);
    const s = await resp.json();
    assert.equal(s.enabled, true);
    assert.equal(s.knobs.evalMs, 300);
    assert.equal(s.knobs.vwapSec, 2);
    assert.equal(s.knobs.flowWindowSec, 15);
    assert.equal(s.knobs.beArmPct, 0.05);
    assert.equal(s.counters.streamWouldFire, 1);
    assert.equal(s.counters.wouldFire, 0);
    assert.equal(s.byKind.streamReal, 1);
    assert.equal(s.byKind.closedReal, 1);
    assert.equal(s.bothArmed.n, 0);
    assert.equal(s.bothArmed.medianLeadSec, null);
    assert.equal(s.bothArmed.streamOnlyArms, 1);
    assert.equal(s.bothArmed.tickOnlyArms, 0);
    assert.deepEqual(s.coverage, { closed: 1, covered: 1 });
    assert.equal(s.recent[0].kind, 'closed'); // newest first
    assert.equal(s.recent[1].kind, 'would-fire-stream');
  } finally { srv.close(); }
});
