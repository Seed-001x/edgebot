// DEAD-FLOW EXIT AT ALTITUDE (user 2026-10-15, window picked: 45s): a PRE-TP1
// position whose peak realizable move reached +8% sells in full when its own
// flow flatlines for a full 45s window (buy count rises <= 1), no new peak
// prints inside the window, and the move sits >= 1pt below the window-start
// peak. The window IS the confirmation — no exitPending, no extra grace.
// Founding case: Scout (Anti-AI Dog), 2026-10-15 — peaked ~+12% realizable,
// buys flatlined for minutes, chopped, round-tripped to −0.4% (probation
// expiry, −0.0009 SOL); this rule fires ~45s into the stall and banks ~+10%.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const S = 1000;
// Isolate the rule: txFeeSol 0 makes move == ratio; the stall, ratchet, dip
// stop and profit lock are off so only dead-flow (and, where a test arms it,
// TP1) can act. Defaults otherwise real: deadflowArmPct 0.08, window 45s,
// maxBuyDelta 1, peakGap 0.01.
const cfg = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0 });
const mark = (pos, ratio, o = {}) => ({ valueSol: pos.entrySol * pos.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
const thread = (p, d) => {
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if ('tp1Arm' in d) p.tp1Arm = d.tp1Arm;
  if ('exitPending' in d) p.exitPending = d.exitPending;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if ('probationSince' in d) p.probationSince = d.probationSince;
  if ('deadflowArmed' in d) p.deadflowArmed = d.deadflowArmed;
  return p;
};
const fresh = (o = {}) => ({ entrySol: 1, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });

// Drive one position check per step ({dt sec, ratio, buys, sells}), appending
// the flow sample BEFORE judging exactly as bot.js does, threading the
// caller-persisted state back in. The clock lives on the fixture (p._now) so
// consecutive drive() calls on one position keep time monotonic. Returns
// every decision.
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
// the shared climb: 8 checks to a 1.12 peak, buy count rising 100 -> 150
const CLIMB_R = [1.03, 1.05, 1.07, 1.09, 1.10, 1.11, 1.115, 1.12];
const CLIMB_B = [100, 108, 116, 124, 132, 138, 144, 150];

test('below the +8% arm line, dead flow never fires (and never arms)', () => {
  const p = fresh();
  const ds = drive(p, [
    ...seq([1.02, 1.03, 1.04, 1.05, 1.055, 1.06], [100, 110, 120, 130, 140, 150]),
    ...flat(16, 1.05, 150), // a full minute of dead flow at a +6% peak
  ]);
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length), 'no arming below the line');
  assert.ok(!p.deadflowArmed);
});

test('dead flow + stall fires exactly at window lapse, full sell, right reason', () => {
  const p = fresh();
  const stallR = [1.115, 1.112, 1.11, 1.109, 1.108, 1.108, 1.107, 1.107, 1.106, 1.106, 1.105, 1.105];
  const ds = drive(p, [...seq(CLIMB_R, CLIMB_B), ...seq(stallR, 150)]);
  const armedAt = ds.findIndex(d => (d.deadflowEvents || []).some(e => e.type === 'armed'));
  assert.equal(armedAt, 3, 'arms on the check the peak move crosses +8%');
  assert.equal(ds.filter(d => (d.deadflowEvents || []).some(e => e.type === 'armed')).length, 1, 'armed counted once');
  assert.ok(ds.slice(0, -1).every(d => d.fraction === 0), 'nothing fires before the 45s window is fully dead');
  const last = ds[ds.length - 1];
  assert.equal(last.fraction, 1);
  assert.match(last.reason, /^dead flow at altitude \(\+10\.5%, 0 new buys in 45s, peak stalled\)$/);
  assert.ok((last.deadflowEvents || []).some(e => e.type === 'fired'));
});

test('a buy burst inside the window voids it — the rule fires only once the burst leaves the window', () => {
  const p = fresh();
  const pre = drive(p, [...seq(CLIMB_R, CLIMB_B), ...flat(10, 1.11, 150), { ratio: 1.118, buys: 156, sells: 40 }]);
  assert.ok(pre.every(d => d.fraction === 0), 'no fire up to and including the burst check');
  const post = drive(p, [...flat(11, 1.108, 156)]); // 44s of fresh dead flow — every window still spans the burst
  assert.ok(post.every(d => d.fraction === 0), 'windows containing the burst stay void');
  const tail = drive(p, [{ ratio: 1.105, buys: 156, sells: 40 }]); // window start now sits past the burst
  assert.equal(tail[0].fraction, 1);
  assert.match(tail[0].reason, /^dead flow at altitude /);
});

test('a new peak inside the window voids it — fires only after the new peak ages to a window start', () => {
  const p = fresh();
  const ds = drive(p, [
    ...seq(CLIMB_R, CLIMB_B),
    ...flat(10, 1.11, 150),
    { ratio: 1.125, buys: 150, sells: 40 }, // new peak mid-window
    ...flat(10, 1.108, 150),
  ]);
  assert.ok(ds.every(d => d.fraction === 0), 'the in-window peak keeps every window void');
  const tail = drive(p, [{ ratio: 1.105, buys: 150, sells: 40 }, { ratio: 1.105, buys: 150, sells: 40 }]);
  assert.equal(tail[0].fraction, 0, 'one check too early: the 1.125 print is still inside this window');
  assert.equal(tail[1].fraction, 1, 'once the 1.125 print is the window-start peak and price sits below it, the rule fires');
});

test('steady two-way flow at altitude never fires', () => {
  const p = fresh();
  const buys = Array.from({ length: 20 }, (_, i) => 153 + i * 3);
  const sells = Array.from({ length: 20 }, (_, i) => 42 + i * 2);
  const chop = Array.from({ length: 20 }, (_, i) => [1.115, 1.118, 1.112][i % 3]);
  const ds = drive(p, [...seq(CLIMB_R, CLIMB_B), ...seq(chop, buys, sells)]);
  assert.ok(ds.some(d => (d.deadflowEvents || []).some(e => e.type === 'armed')), 'the position did arm — the void is the flow leg');
  assert.ok(ds.every(d => d.fraction === 0));
});

test('TP1-done position is untouched by the rule', () => {
  const p = fresh({ tp1Done: true, pathClass: 'ladder', remainingFrac: 0.6, peakRatio: 1.12, peakMove: 1.12, postTp1PeakMove: 1.12 });
  const ds = drive(p, seq([1.115, 1.112, 1.11, 1.109, 1.108, 1.108, 1.107, 1.107, 1.106, 1.106, 1.105, 1.104, 1.103, 1.102, 1.101, 1.10], 150));
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length && !d.deadflowArmed), 'no arming, no events post-TP1');
});

test('protected position: the fire is suppressed and reported as a dead-flow block', () => {
  const p = fresh({ protected: true });
  const stallR = [1.115, 1.112, 1.11, 1.109, 1.108, 1.108, 1.107, 1.107, 1.106, 1.106, 1.105, 1.105];
  const ds = drive(p, [...seq(CLIMB_R, CLIMB_B), ...seq(stallR, 150)]);
  assert.ok(ds.every(d => d.fraction === 0), 'protection never sells');
  assert.equal(ds[ds.length - 1].protectedBlock, 'dead flow', 'the qualifying check reports the suppression bot.js counts');
});

test('TP1 firing on the same check wins over dead flow', () => {
  const cfgX = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, tp1Pct: 0.10, tp1AdaptMax: 0.60, tp1Giveback: 0.03, tp1Frac: 0.4 });
  const p = fresh();
  const climbR = [1.05, 1.10, 1.15, 1.20, 1.24, 1.27, 1.29, 1.30];
  const climbB = [100, 110, 120, 130, 140, 150, 160, 170];
  const ds = drive(p, [
    ...seq(climbR, climbB, 73),
    ...flat(10, 1.30, 170, 73), // plateau, flow dead from the peak print on
    { ratio: 1.29, buys: 170, sells: 73 },
    { ratio: 1.27, buys: 170, sells: 73 }, // giveback hits 3pts exactly as the 45s window completes
  ], cfgX);
  assert.ok(ds.slice(0, -1).every(d => d.fraction === 0));
  const last = ds[ds.length - 1];
  assert.equal(last.tp1, true, 'TP1 takes the check');
  assert.equal(last.fraction, 0.4);
  assert.match(last.reason, /^TP1 /);
  assert.equal(last.pathClass, 'modest');
});

test('AAD shape: choppy stall with micro-recoveries still fires near the top (~+10.6%)', () => {
  const p = fresh();
  const climbR = [1.04, 1.07, 1.09, 1.105, 1.115, 1.12];
  const climbB = [90, 102, 114, 126, 138, 150];
  const stallR = [1.108, 1.113, 1.106, 1.112, 1.107, 1.11, 1.105, 1.109, 1.104, 1.107, 1.103, 1.106];
  const ds = drive(p, [...seq(climbR, climbB, 55), ...seq(stallR, 150, 55)]);
  assert.ok(ds.slice(0, -1).every(d => d.fraction === 0));
  const last = ds[ds.length - 1];
  assert.equal(last.fraction, 1);
  assert.match(last.reason, /^dead flow at altitude \(\+10\.6%, 0 new buys in 45s, peak stalled\)$/);
});

test('SCRIP-shaped first stall — buys still ticking in two-way flow — does NOT fire', () => {
  const cfgX = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, tp1Frac: 0 }); // TP1 off: isolate the rule on a runner
  const p = fresh();
  const climbR = [1.06, 1.12, 1.18, 1.24, 1.30, 1.35, 1.39, 1.42, 1.44, 1.45];
  const climbB = [120, 150, 180, 205, 228, 248, 265, 280, 292, 300];
  const stallR = [1.44, 1.435, 1.445, 1.44, 1.45, 1.442, 1.455, 1.448, 1.452, 1.446, 1.45, 1.443, 1.449, 1.447];
  const stallB = stallR.map((_, i) => 304 + i * 4);
  const stallS = stallR.map((_, i) => 120 + i * 3);
  const ds = drive(p, [...seq(climbR, climbB, 90), ...seq(stallR, stallB, stallS), ...seq([1.50, 1.58], [364, 372], [165, 170])], cfgX);
  assert.ok(ds.every(d => d.fraction === 0), 'a live stall is not dead flow — the run continues untouched');
});

test('knob off (DEADFLOW_WINDOW_SEC=0): never arms, never fires', () => {
  const cfgX = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, deadflowWindowSec: 0 });
  const p = fresh();
  const stallR = [1.115, 1.112, 1.11, 1.109, 1.108, 1.108, 1.107, 1.107, 1.106, 1.106, 1.105, 1.105];
  const ds = drive(p, [...seq(CLIMB_R, CLIMB_B), ...seq(stallR, 150)], cfgX);
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length));
});

test('missing flow data fails closed — a stall with unknown buy counts never fires', () => {
  const p = fresh();
  const steps = [
    ...[1.04, 1.07, 1.09, 1.105, 1.115, 1.12].map(ratio => ({ ratio, buys: null, sells: null })),
    ...Array.from({ length: 14 }, () => ({ ratio: 1.108, buys: null, sells: null })),
  ];
  const ds = drive(p, steps);
  assert.ok(ds.every(d => d.fraction === 0));
});

test('a data gap (restart) fails closed until the window is covered again', () => {
  const p = fresh();
  const pre = drive(p, [...seq(CLIMB_R, CLIMB_B), ...flat(6, 1.11, 150), { dt: 60, ratio: 1.105, buys: 150, sells: 40 }]);
  assert.ok(pre.every(d => d.fraction === 0), 'the first post-gap check cannot judge a window it did not see');
  const post = drive(p, flat(11, 1.105, 150));
  assert.ok(post.every(d => d.fraction === 0), 'windows still reaching back across the gap stay void');
  const tail = drive(p, [{ ratio: 1.105, buys: 150, sells: 40 }]);
  assert.equal(tail[0].fraction, 1, 'once a full fresh window exists, the rule judges again');
  assert.match(tail[0].reason, /^dead flow at altitude /);
});

// ---- config ----
test('config: dead-flow knobs default to the shipped values and validate', () => {
  const c = loadConfig({});
  assert.equal(c.deadflowArmPct, 0.08);
  assert.equal(c.deadflowWindowSec, 45);
  assert.equal(c.deadflowMaxBuyDelta, 1);
  assert.equal(c.deadflowPeakGapPct, 0.01);
  assert.equal(validateConfig(c).filter(e => e.includes('DEADFLOW')).length, 0);
  assert.equal(loadConfig({ DEADFLOW_WINDOW_SEC: '30' }).deadflowWindowSec, 30);
  assert.equal(loadConfig({ DEADFLOW_WINDOW_SEC: '0' }).deadflowWindowSec, 0);
  assert.equal(validateConfig(loadConfig({ DEADFLOW_WINDOW_SEC: '0' })).filter(e => e.includes('DEADFLOW')).length, 0, '0 = off validates');
  assert.ok(validateConfig(loadConfig({ DEADFLOW_WINDOW_SEC: '-5' })).some(e => e.includes('DEADFLOW_WINDOW_SEC')));
  assert.ok(validateConfig(loadConfig({ DEADFLOW_ARM_PCT: '2' })).some(e => e.includes('DEADFLOW_ARM_PCT')));
  assert.ok(validateConfig(loadConfig({ DEADFLOW_PEAK_GAP_PCT: '0.9' })).some(e => e.includes('DEADFLOW_PEAK_GAP_PCT')));
});
