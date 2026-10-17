// Never-Green Cut SHADOW (owner order 2026-10-17, RECORD-ONLY): a
// position that has NEVER peaked above +2% (running peakRatio <= 1.02),
// is at least 300s old, and prints a realizable ratio <= 0.90 for 2
// CONSECUTIVE position checks would have been cut in full at that check's
// quote. It journals would-fires to nevergreen.jsonl and pairs them
// against the position's actual close (the Shadow Seller's pairDelta
// math), serving the scorecard at GET /nevergreen. It NEVER sells,
// blocks, or feeds any decision.
//
// The tick series below mirror the 2026-10-17 replay that priced the
// rule (the bot's own /ticks realizable ratios):
//   SEXCOIN — never green (best print 0.991x), 0.92 at 5 min, decaying
//     staircase to a -59% structural-stop close. The cut fires.
//   MAKERS — dipped to 0.719 at ~1.3 min, still under 0.90 into minute 4,
//     recovered to 0.97 by 5 min and ran to 16x. The cut must NEVER fire:
//     the 300s arm (and confirm counting only past the arm) is the whole
//     ballgame.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Journal } from '../src/journal.js';
import { Executor } from '../src/exec.js';
import { NeverGreenCut, buildNeverGreenCard, NEVERGREEN_READY_N } from '../src/neverGreen.js';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { testCfg, tmp } from './helpers.mjs';

const T0 = 1_800_000_000_000;
const S = 1000;

/** A position in the shape managePosition threads stamps onto. */
const mkPos = (over = {}) => ({
  id: 'TEST-1', mint: 'MINTNG', symbol: 'NGTEST', setup: 'bottom', slot: null,
  entryTs: T0, entrySol: 0.1, remainingFrac: 1, realizedSol: 0, feesSol: 0.0005,
  protected: null, takenOver: null, peakRatio: 1, ...over,
});

/** Feed [heldSec, ratio, peak?] checks (12s apart, the position-loop
 *  cadence) through the judge; valueSol is the ratio over the remaining
 *  basis, exactly as the live check computes it. Returns the fires. */
function feed(cut, pos, series) {
  const fires = [];
  for (const [heldSec, ratio, peak] of series) {
    const basis = pos.entrySol * pos.remainingFrac;
    const rec = cut.noteCheck(pos, {
      ratio, peakRatio: peak != null ? peak : (pos.peakRatio || 1), valueSol: ratio * basis, now: pos.entryTs + heldSec * S,
    });
    if (rec) fires.push(rec);
  }
  return fires;
}

const setup = (cfgOver = {}) => {
  const dir = tmp();
  const cfg = testCfg({ dataDir: dir }, {});
  Object.assign(cfg, cfgOver);
  const journal = new Journal(dir, { now: () => T0 });
  const cut = new NeverGreenCut({ cfg, journal, now: () => T0, log: () => {} });
  return { dir, cfg, journal, cut };
};

// ------------------------------------------------------------ config
test('nevergreen config: shadow defaults ON with the replay dials; env overrides land', () => {
  const d = loadConfig({ DATA_DIR: tmp() });
  assert.equal(d.neverGreenShadow, 1);
  assert.equal(d.ngCutArmSec, 300);
  assert.equal(d.ngCutPeakMax, 1.02);
  assert.equal(d.ngCutRatio, 0.90);
  assert.equal(d.ngCutConfirmChecks, 2);
  const off = loadConfig({ DATA_DIR: tmp(), NEVERGREEN_SHADOW: '0', NG_CUT_ARM_SEC: '600' });
  assert.equal(off.neverGreenShadow, 0);
  assert.equal(off.ngCutArmSec, 600);
});

// ------------------------------------------------------------ case 1: SEXCOIN shape fires
test('nevergreen: SEXCOIN shape (never green, decaying) fires once, at the 2nd consecutive sub-0.90 check past the arm', () => {
  const { journal, cut } = setup();
  const pos = mkPos({ symbol: 'SEXCOIN' });
  // Replay-shaped: starts 0.99, hovers 0.90-0.95, crosses under 0.90 only
  // just before the arm — the confirm must count from the arm, so the
  // fire lands on the second sub-0.90 check at/after 300s.
  const fires = feed(cut, pos, [
    [0, 0.991], [60, 0.95], [120, 0.936], [180, 0.917], [240, 0.915],
    [288, 0.89],                    // sub-line but BEFORE the arm: no credit
    [300, 0.885],                   // 1st confirm check at the arm
    [312, 0.87],                    // 2nd consecutive -> FIRE here
    [324, 0.85], [600, 0.84], [1200, 0.69], [2100, 0.47], // decay continues — never a second fire
  ]);
  assert.equal(fires.length, 1);
  const rec = fires[0];
  assert.equal(rec.kind, 'fire');
  assert.equal(rec.reason, 'never-green cut (shadow)');
  assert.equal(rec.ts, T0 + 312 * S);
  assert.equal(rec.heldMin, 5.2);
  assert.equal(rec.ratio, 0.87);
  assert.equal(rec.valueSol, 0.087);          // the full remainder's realizable quote at the fire check
  assert.equal(rec.peakRatio, 1);
  assert.equal(rec.entrySol, 0.1);
  assert.equal(rec.remainingFrac, 1);
  assert.equal(rec.setup, 'bottom');
  assert.ok(pos.ngCutFired, 'position stamped fired (persisted by the tick save)');
  assert.equal(pos.ngCutChecks, 0);
  const onDisk = fs.readFileSync(path.join(journal.dir, 'nevergreen.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].id, pos.id);
});

// ------------------------------------------------------------ case 2: MAKERS shape never fires
test('nevergreen: MAKERS shape (0.72 dip at 1.3 min, recovery by 5 min, then green) never fires', () => {
  const { cut } = setup();
  const pos = mkPos({ symbol: 'MAKERS' });
  const fires = feed(cut, pos, [
    [0, 0.97], [30, 0.898], [78, 0.719], [90, 0.793], [120, 0.944],
    [180, 0.888], [240, 0.842],           // still sub-0.90 into minute 4 — pre-arm, no credit
    [300, 0.974],                          // recovered by the arm
    [360, 1.12, 1.12], [600, 1.395, 1.409], [1800, 11.316, 11.345], // the run
  ]);
  assert.equal(fires.length, 0);
  assert.ok(!pos.ngCutFired);
});

// ------------------------------------------------------------ case 3: early green = permanent disarm
test('nevergreen: a peak above 1.02 early permanently disarms — a later long collapse never fires', () => {
  const { cut } = setup();
  const pos = mkPos();
  const fires = feed(cut, pos, [
    [0, 0.99], [60, 1.25, 1.30], [120, 1.05, 1.30],
    [300, 0.88, 1.30], [312, 0.86, 1.30], [600, 0.80, 1.30], [1200, 0.60, 1.30], [2400, 0.40, 1.30],
  ]);
  assert.equal(fires.length, 0);
  assert.equal(pos.ngCutDisarmed, true);
  assert.ok(!pos.ngCutFired);
});

// ------------------------------------------------------------ case 4: confirm resets on recovery
test('nevergreen: one isolated sub-0.90 check then recovery does not fire; the count restarts', () => {
  const { cut } = setup();
  const pos = mkPos();
  const fires = feed(cut, pos, [
    [0, 0.97], [300, 0.88],               // confirm 1
    [312, 0.95],                          // back above the line — count resets
    [324, 0.87],                          // confirm 1 again
    [336, 0.86],                          // confirm 2 -> FIRE at 336, not before
    [348, 0.85],
  ]);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].ts, T0 + 336 * S);
  assert.equal(fires[0].ratio, 0.86);
  assert.equal(fires[0].valueSol, 0.086);
});

// ------------------------------------------------------------ case 5: kill switch
test('nevergreen: NEVERGREEN_SHADOW=0 — no records, no stamps, card off', () => {
  const { dir, journal, cut } = setup({ neverGreenShadow: 0 });
  assert.equal(cut.enabled, false);
  const pos = mkPos();
  const fires = feed(cut, pos, [
    [0, 0.99], [300, 0.85], [312, 0.84], [600, 0.70], [1200, 0.50],
  ]);
  assert.equal(fires.length, 0);
  assert.equal(pos.ngCutFired, undefined);
  assert.equal(pos.ngCutChecks, undefined);
  assert.equal(journal.neverGreenRecs.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'nevergreen.jsonl')), false);
  assert.deepEqual(cut.card(), { enabled: false });
});

// ------------------------------------------------------------ case 6: restart never re-fires
test('nevergreen: a would-fire survives a restart without re-firing (journal rebuild + persisted stamp)', () => {
  const dir = tmp();
  const cfg = testCfg({ dataDir: dir });
  const j1 = new Journal(dir, { now: () => T0 });
  const cut1 = new NeverGreenCut({ cfg, journal: j1, now: () => T0, log: () => {} });
  const pos = mkPos();
  const series = [[0, 0.99], [300, 0.88], [312, 0.87]];
  assert.equal(feed(cut1, pos, series).length, 1);
  // simulate the restart: position restored from its persisted JSON (the
  // ngCutFired stamp rides along), a fresh journal + judge on the same dir
  const restored = JSON.parse(JSON.stringify(pos));
  const j2 = new Journal(dir, { now: () => T0 });
  const cut2 = new NeverGreenCut({ cfg, journal: j2, now: () => T0, log: () => {} });
  assert.equal(feed(cut2, restored, [[324, 0.85], [600, 0.80], [1200, 0.60]]).length, 0);
  // and even with the position stamp lost, the journal rebuild alone holds the line
  const unstamped = mkPos();
  assert.equal(feed(cut2, unstamped, [[300, 0.85], [312, 0.84]]).length, 0);
  const onDisk = fs.readFileSync(path.join(dir, 'nevergreen.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(onDisk.filter(r => r.kind === 'fire').length, 1);
});

// ------------------------------------------------------------ pairing + card
test('nevergreen: the fire pairs at close against what the remainder actually realized (SEXCOIN outcome)', () => {
  const { cfg, journal, cut } = setup();
  const pos = mkPos({ symbol: 'SEXCOIN' });
  const fires = feed(cut, pos, [[0, 0.991], [300, 0.885], [312, 0.87]]);
  assert.equal(fires.length, 1);
  // the position then bled to the structural stop, exactly as live: total
  // proceeds 0.041132 on the 0.1 stake, 0.002 of fees burned by close
  const paired = cut.noteClose(pos, { exitSol: 0.041132, feesSol: 0.002, heldMin: 35.8, reason: 'base broke: fell below the base low', ts: T0 + 2148 * S });
  assert.ok(paired);
  assert.equal(paired.kind, 'paired');
  assert.equal(paired.paired, true);
  // shadow: sell the remainder at the fire quote, less one tx fee.
  // hold: what the remainder realized after the fire, less the fees burned after it.
  const fee = cfg.txFeeSol;
  assert.equal(paired.shadowNet, +(0.087 - fee).toFixed(6));
  assert.equal(paired.holdNet, +(0.041132 - (0.002 - 0.0005)).toFixed(6));
  assert.equal(paired.deltaSol, +(paired.shadowNet - paired.holdNet).toFixed(6));
  assert.ok(paired.deltaSol > 0.04, 'the cut would have saved ~0.046 SOL on this shape');
  assert.equal(paired.shadowWin, true);
  assert.equal(paired.exitReason, 'base broke: fell below the base low');
  const card = buildNeverGreenCard(journal.neverGreenRecs, T0);
  assert.equal(card.fires, 1);
  assert.equal(card.paired, 1);
  assert.equal(card.pending, 0);
  assert.equal(card.wins, 1);
  assert.equal(card.totalDeltaSol, paired.deltaSol);
  assert.equal(card.ready, false);
  assert.equal(NEVERGREEN_READY_N, 30);
  // a second close of the same position pairs nothing (funnel fires once)
  assert.equal(cut.noteClose(pos, { exitSol: 0.041132, feesSol: 0.002, ts: T0 + 2200 * S }), null);
});

test('nevergreen: card counts a still-open fire as pending with no delta', () => {
  const { journal, cut } = setup();
  const pos = mkPos();
  feed(cut, pos, [[0, 0.99], [300, 0.88], [312, 0.87]]);
  const card = cut.card();
  assert.equal(card.enabled, true);
  assert.equal(card.fires, 1);
  assert.equal(card.paired, 0);
  assert.equal(card.pending, 1);
  assert.equal(card.totalDeltaSol, 0);
  assert.equal(card.wins, 0);
  assert.equal(card.recent.length, 1);
  assert.equal(card.recent[0].kind, 'fire');
  assert.equal(journal.neverGreenRecs.length, 1);
});

// ------------------------------------------------------------ HTTP surface + bot wiring
test('nevergreen: HTTP GET /nevergreen serves the empty-state card on a fresh bot; /state carries the tally at 0', async () => {
  const dir = tmp();
  const cfg = testCfg({ dataDir: dir });
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => T0, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  assert.ok(bot.neverGreen, 'shadow constructed on the bot');
  assert.equal(bot.neverGreen.enabled, true, 'NEVERGREEN_SHADOW defaults on');
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const card = await (await fetch(base + '/nevergreen')).json();
    assert.equal(card.enabled, true);
    assert.equal(card.fires, 0);
    assert.equal(card.paired, 0);
    assert.equal(card.pending, 0);
    assert.equal(card.totalDeltaSol, 0);
    assert.equal(card.wins, 0);
    assert.equal(card.ready, false);
    assert.deepEqual(card.recent, []);
    const st = await (await fetch(base + '/state')).json();
    assert.deepEqual(st.stats.neverGreen, { fires: 0, paired: 0, deltaSol: 0 });
  } finally { srv.close(); }
});
