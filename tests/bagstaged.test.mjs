// STAGED MOONBAG DEAD FLOW (user order 2026-10-16 ~20:15 EDT, "once dead
// flow hits next time wave it sell another 50% and then let the rest ride
// until 10+% above avg entry" / "build it, trail stays alongside"): the
// moonbag's dead-flow exit (exits.js 3c2) sells in WAVES instead of dumping
// the whole bag — wave 1 and wave 2 each sell 50% of the current remainder,
// waves are EDGE-based (the dead-flow condition must clear on at least one
// check between waves), and after wave 2 dead flow never sells again: the
// stub rides until the realizable quote falls to 1 + BAG_FLOOR_PCT of
// average entry (3c3), which sells it in full. The −30% moonbag trail is
// untouched and outranks everything here at every stage. BAG_DEAD_STAGED=0
// restores the legacy whole-bag fire (pinned in deadflow.test.mjs and here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const S = 1000;
// Same isolation as deadflow.test.mjs: txFeeSol 0 (move == ratio), the stall /
// dip / lock family inert, real dead-flow defaults (arm +8%, window 45s,
// maxBuyDelta 1, peakGap 0.01) and the real trail default (bagTrailPct 0.15).
const cfg = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0 }); // trail timer off: this file pins the trail's precedence, the timer is pinned in bagtrailconfirm.test.mjs
const mark = (pos, ratio, o = {}) => ({ valueSol: pos.entrySol * pos.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
const thread = (p, d) => {
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if ('tp1Arm' in d) p.tp1Arm = d.tp1Arm;
  if ('exitPending' in d) p.exitPending = d.exitPending;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if ('probationSince' in d) p.probationSince = d.probationSince;
  if ('deadflowArmed' in d) p.deadflowArmed = d.deadflowArmed;
  if ('stallPending' in d) p.stallPending = d.stallPending;
  if ('bagDeadWaves' in d) p.bagDeadWaves = d.bagDeadWaves;
  if ('bagDeadHot' in d) p.bagDeadHot = d.bagDeadHot;
  if (d.bagWave) p.remainingFrac *= (1 - d.fraction); // bot.js's booking seam for a wave partial
  return p;
};
const fresh = (o = {}) => ({ entrySol: 1, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });

function drive(p, steps, cfgX = cfg) {
  let now = p._now ?? p.entryTs; const ds = [];
  for (const st of steps) {
    now += (st.dt ?? 4) * S; p._now = now;
    if (st.buys !== undefined || st.sells !== undefined) {
      p.flowHist = [...(p.flowHist || []), { ts: now, buys: st.buys ?? null, sells: st.sells ?? null, tx: (st.buys != null || st.sells != null) ? (st.buys || 0) + (st.sells || 0) : null }].slice(-45);
    }
    const d = evaluateExit(p, mark(p, st.ratio, { buysM5: st.buys ?? null, sellsM5: st.sells ?? 0 }), cfgX, now);
    thread(p, d); ds.push(d);
  }
  return ds;
}
const seq = (ratios, buys, sells = 40) => ratios.map((ratio, i) => ({ ratio, buys: Array.isArray(buys) ? buys[i] : buys, sells: Array.isArray(sells) ? sells[i] : sells }));
const flat = (n, ratio, buys, sells = 40) => Array.from({ length: n }, () => ({ ratio, buys, sells }));

// A moonbag-stage fixture (as in deadflow.test.mjs): TP1 + TP2 banked, 25%
// riding, peak 1.90x; the trail (0.15) lines at 1.615, well under the flat
// 1.86 prints, so only dead flow can act unless a test says otherwise.
const bag = (o = {}) => fresh({ tp1Done: true, tp2Done: true, pathClass: 'ladder', remainingFrac: 0.25, peakRatio: 1.9, peakMove: 1.9, postTp1PeakMove: 1.9, ...o });
const CLIMB = seq([1.90, 1.90, 1.90], [300, 306, 312]);
const wavesOf = (ds) => ds.filter(d => d.bagWave);

// Drive a fresh bag through wave 1 (dead window at buys 312), a buy-burst
// clear, and wave 2 (dead window at buys 430). Returns all decisions.
function driveTwoWaves(p, cfgX = cfg) {
  const d1 = drive(p, [...CLIMB, ...flat(14, 1.86, 312)], cfgX);
  assert.equal(wavesOf(d1).length, 1, 'wave 1 fires inside the first dead window');
  const burst = drive(p, [{ ratio: 1.86, buys: 430, sells: 40 }], cfgX);
  assert.equal(burst[0].fraction, 0);
  assert.equal(p.bagDeadHot, false, 'the burst check clears the edge');
  const d2 = drive(p, flat(16, 1.86, 430), cfgX);
  assert.equal(wavesOf(d2).length, 1, 'wave 2 fires inside the second dead window');
  return [...d1, ...burst, ...d2];
}

test('wave 1: a full dead window sells 50% of the bag — the position survives at half the remainder', () => {
  const p = bag();
  const ds = drive(p, [...CLIMB, ...flat(14, 1.86, 312)]);
  const w = wavesOf(ds);
  assert.equal(w.length, 1);
  assert.equal(w[0].fraction, 0.5);
  assert.equal(w[0].bagWave, 1);
  assert.match(w[0].reason, /^moonbag dead flow \(wave 1 — sold 50%, \+86\.0%, 0 new buys in 45s, peak stalled\)$/);
  assert.deepEqual(w[0].deadflowEvents, [{ type: 'wave', wave: 1 }]);
  assert.ok(ds.slice(0, ds.indexOf(w[0])).every(d => d.fraction === 0), 'no sell before the window completes');
  assert.equal(p.bagDeadWaves, 1);
  assert.equal(p.remainingFrac, 0.125, 'the wave books half of the 25% remainder; the position lives on');
});

test('edge-based: unbroken dead flow after wave 1 never fires wave 2 — the condition must clear first', () => {
  const p = bag();
  const ds = drive(p, [...CLIMB, ...flat(34, 1.86, 312)]); // ~2.5 windows of continuous dead tape
  assert.equal(wavesOf(ds).length, 1, 'one wave only, however long the tape stays dead');
  assert.equal(p.bagDeadWaves, 1);
  assert.equal(p.bagDeadHot, true, 'the level is still hot — no fresh edge has occurred');
  assert.equal(p.remainingFrac, 0.125);
});

test('wave 2: after a clear, a fresh dead window sells 50% of what remains', () => {
  const p = bag();
  driveTwoWaves(p);
  assert.equal(p.bagDeadWaves, 2);
  assert.equal(p.remainingFrac, 0.0625, 'wave 2 halves the post-wave-1 remainder (25% → 12.5% → 6.25% of original)');
});

test('after wave 2, dead flow never sells again — a third dead episode is inert and the stub rides', () => {
  const p = bag();
  driveTwoWaves(p);
  const burst = drive(p, [{ ratio: 1.86, buys: 520, sells: 40 }]);
  assert.equal(p.bagDeadHot, false, 'the third episode starts from a real clear');
  const ds = drive(p, flat(16, 1.86, 520));
  assert.ok(ds.every(d => d.fraction === 0), 'no third wave at altitude — the stub rides');
  assert.ok(ds.every(d => !(d.deadflowEvents || []).some(e => e.type === 'wave')));
  assert.equal(p.bagDeadWaves, 2);
  assert.equal(p.remainingFrac, 0.0625);
});

test('stub floor: at ratio <= 1.10 the stub sells in full — above it, it rides', () => {
  const cfgFloor = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailPct: 0.85 }); // trail neutralized: the floor is the only price exit in this test
  const p = bag();
  driveTwoWaves(p, cfgFloor);
  const high = drive(p, [{ ratio: 1.30, buys: 430, sells: 40 }, { ratio: 1.11, buys: 430, sells: 40 }], cfgFloor);
  assert.ok(high.every(d => d.fraction === 0), 'above +10% over entry the stub rides');
  const d = drive(p, [{ ratio: 1.10, buys: 430, sells: 40 }], cfgFloor)[0];
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'moonbag floor (+10% over entry)');
  assert.deepEqual(d.deadflowEvents, [{ type: 'floor' }]);
});

test('the floor governs the final stub only: a dip to 1.05 after wave 1 sells nothing — flow, not price, still stages the bag', () => {
  const cfgFloor = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailPct: 0.85 });
  const p = bag();
  const d1 = drive(p, [...CLIMB, ...flat(14, 1.86, 312)], cfgFloor);
  assert.equal(wavesOf(d1).length, 1);
  const dip = drive(p, flat(6, 1.05, 312), cfgFloor); // under the floor line, tape still dead, still hot
  assert.ok(dip.every(d => d.fraction === 0), 'no floor exit at wave 1 — and no wave 2 without a clear');
  assert.equal(p.bagDeadWaves, 1);
  drive(p, [{ ratio: 1.05, buys: 430, sells: 40 }], cfgFloor); // clear
  const d2 = drive(p, flat(14, 1.05, 430), cfgFloor);
  assert.equal(wavesOf(d2).length, 1, 'wave 2 still comes from the flow at 1.05 — the dip itself sold nothing');
  const d3 = drive(p, [{ ratio: 1.05, buys: 430, sells: 40 }], cfgFloor)[0];
  assert.equal(d3.fraction, 1, 'with both waves spent, the same 1.05 print is now the floor’s');
  assert.equal(d3.reason, 'moonbag floor (+10% over entry)');
});

test('the trail is untouched: it fires 100% before any wave, between waves, and on the stub', () => {
  const drop = { ratio: 1.60, buys: 312, sells: 40 }; // 1.60 <= 1.90 x (1 - 0.15): a trail breach
  const a = bag();
  const da = drive(a, [...CLIMB, drop]);
  assert.equal(da[da.length - 1].fraction, 1);
  assert.match(da[da.length - 1].reason, /^moonbag trail/);

  const b = bag();
  const d1 = drive(b, [...CLIMB, ...flat(14, 1.86, 312)]);
  assert.equal(wavesOf(d1).length, 1);
  const db = drive(b, [drop]);
  assert.equal(db[0].fraction, 1, 'between waves the trail still takes the whole remainder');
  assert.match(db[0].reason, /^moonbag trail/);

  const c = bag();
  driveTwoWaves(c);
  const dc = drive(c, [{ ratio: 1.60, buys: 430, sells: 40 }]);
  assert.equal(dc[0].fraction, 1, 'on the stub the trail outranks the floor and keeps its label');
  assert.match(dc[0].reason, /^moonbag trail/);
});

test('kill switch: BAG_DEAD_STAGED=0 restores the legacy whole-bag fire — and the floor does not exist', () => {
  const cfgLegacy = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagDeadStaged: 0 });
  const p = bag();
  const ds = drive(p, [...CLIMB, ...flat(14, 1.86, 312)], cfgLegacy);
  const fire = ds.find(d => d.fraction === 1);
  assert.ok(fire, 'the legacy fire lands inside the window');
  assert.match(fire.reason, /^dead flow after TP2 \(\+86\.0%, 0 new buys in 45s, peak stalled\)$/);
  assert.deepEqual(fire.deadflowEvents, [{ type: 'fired' }]);
  assert.equal(p.bagDeadWaves, 0, 'no wave ever counts under the legacy rule');

  const cfgLegacyFloor = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagDeadStaged: 0, bagTrailPct: 0.85 }); // trail neutralized so only a floor could sell
  const stub = bag({ bagDeadWaves: 2 }); // even a position carrying wave state gets no floor with the switch off
  const live = drive(stub, seq([1.05, 1.05, 1.05, 1.05, 1.05], [300, 320, 340, 360, 380]), cfgLegacyFloor);
  assert.ok(live.every(d => d.fraction === 0), 'ratio 1.05 with live flow: no floor, no dead-flow fire — nothing');
});

test('protect: a protected bag’s waves are suppressed — no sell, no wave count, the block reports as dead flow', () => {
  const p = bag({ protected: true });
  const ds = drive(p, [...CLIMB, ...flat(16, 1.86, 312)]);
  assert.ok(ds.every(d => d.fraction === 0), 'protection never sells');
  assert.ok(ds.every(d => !(d.deadflowEvents || []).some(e => e.type === 'wave' || e.type === 'fired')), 'no wave or fire event under the flag');
  assert.equal(p.bagDeadWaves, 0, 'a suppressed wave does not count');
  assert.equal(ds[ds.length - 1].protectedBlock, 'dead flow');
});

test('takeover: judging silences, the wave count (a record of executed sells) survives, the hot edge drops', () => {
  const p = bag({ takenOver: T0, bagDeadWaves: 1, bagDeadHot: true });
  const d = evaluateExit(p, mark(p, 1.86, { buysM5: 312, sellsM5: 40 }), cfg, T0 + 4 * S);
  assert.equal(d.takenOver, true);
  assert.equal(d.fraction, 0);
  assert.equal(d.bagDeadWaves, 1);
  assert.equal(d.bagDeadHot, false);
});

test('threading surface: every decision carries the wave state, pre-TP2 positions included', () => {
  const p = fresh();
  const d = evaluateExit(p, mark(p, 1.0, { buysM5: 30, sellsM5: 10 }), cfg, T0 + 4 * S);
  assert.equal(d.bagDeadWaves, 0);
  assert.equal(d.bagDeadHot, false);
  const b = bag();
  const db = evaluateExit(b, mark(b, 1.9, { buysM5: 300, sellsM5: 40 }), cfg, T0 + 4 * S);
  assert.equal(db.bagDeadWaves, 0);
  assert.equal(db.bagDeadHot, false);
});

// ---- config ----
test('config: staged bag knobs default to the shipped values and validate', () => {
  const c = loadConfig({});
  assert.equal(c.bagDeadStaged, 1);
  assert.equal(c.bagFloorPct, 0.10);
  assert.equal(validateConfig(c).filter(e => e.includes('BAG_')).length, 0);
  assert.equal(loadConfig({ BAG_DEAD_STAGED: '0' }).bagDeadStaged, 0);
  assert.equal(loadConfig({ BAG_FLOOR_PCT: '0.25' }).bagFloorPct, 0.25);
  assert.ok(validateConfig(loadConfig({ BAG_DEAD_STAGED: '2' })).some(e => e.includes('BAG_DEAD_STAGED')));
  assert.ok(validateConfig(loadConfig({ BAG_FLOOR_PCT: '1' })).some(e => e.includes('BAG_FLOOR_PCT')));
  assert.ok(validateConfig(loadConfig({ BAG_FLOOR_PCT: '-0.1' })).some(e => e.includes('BAG_FLOOR_PCT')));
});
