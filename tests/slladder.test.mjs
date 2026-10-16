import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { testCfg } from './helpers.mjs';

// SL LADDER (user 2026-10-16, "the SL ladder"): one probation clock per
// position, depth spends it faster. Judged on the fee-aware net gain — the
// cfg here zeroes txFeeSol so gain = ratio − 1 exactly and the marks below
// read as plain percentages. Defaults from config: arm −10% (soft 120s /
// cap 180s), deep −20% (snap-back 15s, cap clamps to arm+124s), penalty
// −25% (−60s off both deadlines, once), final −30% (10s countdown),
// handoff line −15%.
// The suite below runs with the 3-MINUTE ENGAGEMENT GATE pinned OFF
// (slMinAgeSec: 0 — user 2026-10-16 18:37): it is the as-first-built
// machine, test for test, and stands as the proof that SL_MIN_AGE_SEC=0
// reproduces the pre-gate behavior exactly. The gate's own tests at the
// bottom of the file run under cfgGate (the live default, 180s).
const cfg = testCfg({ txFeeSol: 0, slMinAgeSec: 0 });
const cfgGate = testCfg({ txFeeSol: 0, slMinAgeSec: 180 });
const NOW = 1_000_000_000_000;
const S = 1000;
const pos = (o = {}) => ({ entrySol: 0.05, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 60 * S, slLadder: null, ...o });
const mk = (p, gainPct, o = {}) => ({ valueSol: p.entrySol * p.remainingFrac * (1 + gainPct / 100), liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });
// one position check, threading the ladder state back exactly like bot.js does
const step = (p, gainPct, c, now, markOver = {}) => { const d = evaluateExit(p, mk(p, gainPct, markOver), c, now); if ('slLadder' in d) p.slLadder = d.slLadder; return d; };

test('arm: the first check at/below -10% starts probation with soft +120s / cap +180s; -9% never arms', () => {
  const p = pos();
  assert.equal(step(p, -9, cfg, NOW).fraction, 0);
  assert.equal(p.slLadder, null);
  const d = step(p, -12, cfg, NOW);
  assert.equal(d.fraction, 0);                                     // arming is not a sell
  assert.equal(p.slLadder.armTs, NOW);
  assert.equal(p.slLadder.softDeadline, NOW + 120 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 180 * S);
  assert.equal(p.slLadder.inHandoff, false);
  assert.ok(d.slLadderEvents.some(e => e.type === 'armed'));
});

test('disarm: a check back above -10% clears the ladder outright; re-arming needs a fresh breach', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  const d = step(p, -5, cfg, NOW + 10 * S);
  assert.equal(d.fraction, 0);
  assert.equal(p.slLadder, null);
  assert.ok(d.slLadderEvents.some(e => e.type === 'disarmed'));
  step(p, -12, cfg, NOW + 20 * S);                                 // fresh breach re-arms fresh
  assert.equal(p.slLadder.armTs, NOW + 20 * S);
  assert.equal(p.slLadder.softDeadline, NOW + 140 * S);
});

test('soft expiry: still at/below -15% when the soft deadline lapses sells in full', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  assert.equal(step(p, -16, cfg, NOW + 60 * S).fraction, 0);
  assert.equal(step(p, -16, cfg, NOW + 119 * S).fraction, 0);
  const d = step(p, -16, cfg, NOW + 120 * S);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /^SL ladder \(armed -10% — soft expiry/);
  assert.ok(d.slLadderEvents.some(e => e.type === 'fired'));
});

test('soft expiry in the limbo hands off to the flow instead of selling; aggressive sellers then sell, calm flow holds', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  const d = step(p, -12, cfg, NOW + 120 * S);                      // limbo at expiry: no sell, handoff
  assert.equal(d.fraction, 0);
  assert.equal(p.slLadder.inHandoff, true);
  assert.ok(d.slLadderEvents.some(e => e.type === 'handoff'));
  assert.equal(step(p, -12, cfg, NOW + 124 * S).fraction, 0);     // calm flow: holds past the soft deadline
  const d2 = step(p, -13, cfg, NOW + 128 * S, { buysM5: 1, sellsM5: 9 });
  assert.equal(d2.fraction, 1);
  assert.match(d2.reason, /flow handoff, sellers aggressive \(1b\/9s\)/);
});

test('hard cap: the probation outer bound sells from inside a calm handoff', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  step(p, -12, cfg, NOW + 120 * S);                                // into handoff (calm)
  assert.equal(step(p, -12, cfg, NOW + 179 * S).fraction, 0);
  const d = step(p, -12, cfg, NOW + 180 * S);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /probation cap reached/);
});

test('snap-back pass: a print back above -20% inside 15s cancels the test; the deep clamp stays', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  step(p, -22, cfg, NOW + 4 * S);                                  // deep: snap starts, cap clamps to arm+124s
  assert.equal(p.slLadder.snapDeadline, NOW + 19 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 124 * S);
  step(p, -18, cfg, NOW + 8 * S);                                  // snap-back inside the window
  assert.equal(p.slLadder.snapDeadline, null);
  assert.equal(p.slLadder.deepSeen, true);
  assert.equal(step(p, -18, cfg, NOW + 30 * S).fraction, 0);      // past the old snap deadline: no fire
});

test('snap-back fail: still at/below -20% when the 15s window lapses sells in full', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  step(p, -22, cfg, NOW + 4 * S);
  assert.equal(step(p, -23, cfg, NOW + 18 * S).fraction, 0);
  const d = step(p, -22, cfg, NOW + 19 * S);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /snap-back failed/);
});

test('penalty rung: the first -25% print takes 60s off both deadlines (after the deep clamp), once per arm', () => {
  const p = pos();
  step(p, -12, cfg, NOW);                                          // soft T+120, cap T+180
  step(p, -26, cfg, NOW + 4 * S);                                  // deep clamps cap to T+124, then penalty spends 60s
  assert.equal(p.slLadder.penalized, true);
  assert.equal(p.slLadder.softDeadline, NOW + 60 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 64 * S);
  step(p, -27, cfg, NOW + 8 * S);                                  // second deep print: no second penalty
  assert.equal(p.slLadder.softDeadline, NOW + 60 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 64 * S);
});

test('final rung: -30% starts a flat 10s countdown that expires into a full sell', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  step(p, -32, cfg, NOW + 4 * S);
  assert.equal(p.slLadder.finalDeadline, NOW + 14 * S);
  assert.equal(step(p, -32, cfg, NOW + 10 * S).fraction, 0);
  const d = step(p, -32, cfg, NOW + 14 * S);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /final -30% countdown expired/);
});

test('final rung: a partial bounce does not save it, a full climb above -10% inside the countdown does', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  step(p, -32, cfg, NOW + 4 * S);                                  // final countdown to NOW+14s
  step(p, -18, cfg, NOW + 8 * S);                                  // partial bounce: countdown runs on
  const d = step(p, -18, cfg, NOW + 14 * S);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /final -30% countdown expired/);
  const q = pos();
  step(q, -12, cfg, NOW);
  step(q, -32, cfg, NOW + 4 * S);
  const dv = step(q, -5, cfg, NOW + 8 * S);                        // the V back above the arm line: disarm wins
  assert.equal(dv.fraction, 0);
  assert.equal(q.slLadder, null);
  assert.equal(step(q, -5, cfg, NOW + 30 * S).fraction, 0);
});

test('flow handoff: a deep print recovered into the limbo hands off directly (no soft-expiry wait)', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  step(p, -22, cfg, NOW + 4 * S);                                  // deep
  const d = step(p, -13, cfg, NOW + 8 * S);                        // back into the limbo: handoff now
  assert.equal(d.fraction, 0);
  assert.equal(p.slLadder.inHandoff, true);
  assert.equal(step(p, -17, cfg, NOW + 12 * S).fraction, 0);      // sinks below the limbo: flow still judges, calm holds
  const d2 = step(p, -17, cfg, NOW + 16 * S, { buysM5: 0, sellsM5: 5 });
  assert.equal(d2.fraction, 1);
  assert.match(d2.reason, /flow handoff, sellers aggressive \(0b\/5s\)/);
});

test('flow handoff ends on a fresh deep print: the snap-back test re-runs', () => {
  const p = pos();
  step(p, -12, cfg, NOW);
  step(p, -22, cfg, NOW + 4 * S);
  step(p, -13, cfg, NOW + 8 * S);                                  // handoff
  assert.equal(p.slLadder.inHandoff, true);
  step(p, -21, cfg, NOW + 12 * S);                                 // fresh deep print
  assert.equal(p.slLadder.inHandoff, false);
  assert.equal(p.slLadder.snapDeadline, NOW + 27 * S);
});

test('middle stage is in scope: a post-TP1 remainder arms and judges like a fresh position', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.6 });
  const d = step(p, -12, cfg, NOW);
  assert.equal(d.fraction, 0);
  assert.ok(p.slLadder && p.slLadder.armTs === NOW);
});

test('moonbag exclusion: a post-TP2 position never arms and any carried ladder state clears', () => {
  const p = pos({ tp2Done: true, slLadder: { armTs: NOW - 60 * S, softDeadline: NOW, hardDeadline: NOW, deepest: 0.2, deepSeen: true, deepClamped: true, penalized: false, snapDeadline: null, finalDeadline: null, inHandoff: false } });
  const d = step(p, -12, cfg, NOW);
  assert.equal(d.fraction, 0);                                     // past the ladder's arm line, far above the bag's own 15% trail — nothing sells, and no ladder state survives
  assert.equal(d.slLadder, null);
});

test('protect silences the ladder like the rest of the stop family: reported, never armed, state dropped', () => {
  const p = pos({ protected: true });
  const d = step(p, -25, cfg, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, 'SL ladder');
  assert.equal(p.slLadder, null);
  const q = pos({ protected: true, slLadder: { armTs: NOW - 60 * S, softDeadline: NOW + 60 * S, hardDeadline: NOW + 120 * S, deepest: 0.12, deepSeen: false, deepClamped: false, penalized: false, snapDeadline: null, finalDeadline: null, inHandoff: false } });
  assert.equal(evaluateExit(q, mk(q, -12), cfg, NOW).slLadder, null);
});

test('takeover silences all judging: an armed ladder returns cleared with the takeover decision', () => {
  const p = pos({ takenOver: true, slLadder: { armTs: NOW - 60 * S, softDeadline: NOW + 60 * S, hardDeadline: NOW + 120 * S, deepest: 0.12, deepSeen: false, deepClamped: false, penalized: false, snapDeadline: null, finalDeadline: null, inHandoff: false } });
  const d = evaluateExit(p, mk(p, -25), cfg, NOW);
  assert.equal(d.takenOver, true);
  assert.equal(d.fraction, 0);
  assert.equal(d.slLadder, null);
});

test('kill switch: SL_LADDER=0 is exactly the pre-ladder engine — no arm, no state, deep prints hold', () => {
  const off = { ...cfg, slLadder: 0 };
  const p = pos();
  const d = step(p, -25, off, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.slLadder, null);
  const q = pos({ slLadder: { armTs: NOW - 60 * S, softDeadline: NOW + 60 * S, hardDeadline: NOW + 120 * S, deepest: 0.12, deepSeen: false, deepClamped: false, penalized: false, snapDeadline: null, finalDeadline: null, inHandoff: false } });
  assert.equal(evaluateExit(q, mk(q, -12), off, NOW).slLadder, null);   // carried state drops while the switch is off
});

test('banks keep precedence: a TP2-level print banks through the ladder section untouched', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.6, slLadder: { armTs: NOW - 200 * S, softDeadline: NOW - 80 * S, hardDeadline: NOW - 20 * S, deepest: 0.2, deepSeen: true, deepClamped: true, penalized: true, snapDeadline: null, finalDeadline: null, inHandoff: true } });
  const d = evaluateExit(p, mk(p, 100), cfg, NOW);                 // +100% net: TP2's level (default tp2Pct 1.00)
  assert.match(d.reason, /^TP2 /);
  assert.ok(d.fraction < 1);                                       // a bank, not a ladder full-exit
  assert.equal(d.slLadder, null);                                  // the run up disarmed the ladder in state prep
});

// ── 3-MINUTE ENGAGEMENT GATE (user 2026-10-16 18:37 EDT: "re add the 3m
// timer — if after the 3m timer it is at -10% then the count starts; vice
// versa if it's at -25-30% then it goes accordingly to how we had it").
// Under cfgGate (the live default, SL_MIN_AGE_SEC 180) the ladder is
// ABSENT before a position is 3 minutes old: nothing arms, tracks or
// accrues. At the first check at/past the gate the machine engages on the
// CURRENT gain, every clock measured from that engagement check.

test('gate: a young flash leaves nothing behind — -32% at 60s of age, recovered by the 3:00 check, never arms and never sells', () => {
  const p = pos({ entryTs: NOW });
  const d0 = step(p, -32, cfgGate, NOW + 60 * S);                  // the founding case's shape: full rung depth inside a minute
  assert.equal(d0.fraction, 0);
  assert.equal(p.slLadder, null);
  assert.ok(!d0.slLadderEvents.some(e => e.type === 'armed'));
  step(p, -26, cfgGate, NOW + 120 * S);                            // still deep, still young: no state accrues, no penalty banks
  assert.equal(p.slLadder, null);
  const d = step(p, -5, cfgGate, NOW + 180 * S);                   // the engagement check reads recovered: nothing to engage on
  assert.equal(d.fraction, 0);
  assert.equal(p.slLadder, null);
  assert.equal(step(p, -5, cfgGate, NOW + 600 * S).fraction, 0);   // the young dip never comes back to sell it
  step(p, -12, cfgGate, NOW + 660 * S);                            // a later ordinary breach arms completely fresh
  assert.equal(p.slLadder.armTs, NOW + 660 * S);
  assert.equal(p.slLadder.deepSeen, false);
  assert.equal(p.slLadder.penalized, false);
  assert.equal(p.slLadder.softDeadline, NOW + 780 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 840 * S);
});

test('gate: at/below -10% at the 3:00 check the ladder arms THERE — soft/cap measured from the engagement check, not from entry', () => {
  const p = pos({ entryTs: NOW });
  step(p, -12, cfgGate, NOW + 179 * S);                            // one second early: still absent
  assert.equal(p.slLadder, null);
  const d = step(p, -12, cfgGate, NOW + 180 * S);
  assert.equal(d.fraction, 0);                                     // arming is not a sell
  assert.equal(p.slLadder.armTs, NOW + 180 * S);
  assert.equal(p.slLadder.softDeadline, NOW + 300 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 360 * S);
  assert.ok(d.slLadderEvents.some(e => e.type === 'armed'));
  assert.equal(step(p, -16, cfgGate, NOW + 299 * S).fraction, 0);  // the engaged machine then runs its standard clock
  const d2 = step(p, -16, cfgGate, NOW + 300 * S);
  assert.equal(d2.fraction, 1);
  assert.match(d2.reason, /soft expiry/);
});

test('gate: sitting at -32% at the 3:00 check composes arm + deep clamp + penalty + final countdown from that check', () => {
  const p = pos({ entryTs: NOW });
  const d = step(p, -32, cfgGate, NOW + 180 * S);                  // the engagement print is itself a full-depth flash
  assert.equal(d.fraction, 0);                                     // the countdown starts at engagement; it does not fire on the same check
  assert.equal(p.slLadder.armTs, NOW + 180 * S);
  assert.equal(p.slLadder.deepSeen, true);
  assert.equal(p.slLadder.penalized, true);
  assert.equal(p.slLadder.softDeadline, NOW + 240 * S);            // soft 120s from engagement, −60s penalty
  assert.equal(p.slLadder.hardDeadline, NOW + 244 * S);            // cap clamped to engagement+124s, −60s penalty
  assert.equal(p.slLadder.snapDeadline, NOW + 195 * S);
  assert.equal(p.slLadder.finalDeadline, NOW + 190 * S);           // the flat 10s countdown, from engagement
  assert.equal(step(p, -32, cfgGate, NOW + 189 * S).fraction, 0);
  const d2 = step(p, -26, cfgGate, NOW + 190 * S);                  // a partial bounce inside the countdown does not save it
  assert.equal(d2.fraction, 1);
  assert.match(d2.reason, /final -30% countdown expired at -26%/);
  const q = pos({ entryTs: NOW });                                 // the same engagement, saved: a full climb above -10% inside the countdown disarms
  step(q, -32, cfgGate, NOW + 180 * S);
  const dv = step(q, -5, cfgGate, NOW + 185 * S);
  assert.equal(dv.fraction, 0);
  assert.equal(q.slLadder, null);
  assert.equal(step(q, -5, cfgGate, NOW + 300 * S).fraction, 0);
});

test('gate: state a pre-gate build left on a still-young position drops — no pre-gate deadline can ever execute', () => {
  const p = pos({ entryTs: NOW, slLadder: { armTs: NOW + 30 * S, softDeadline: NOW, hardDeadline: NOW, deepest: 0.32, deepSeen: true, deepClamped: true, penalized: true, snapDeadline: null, finalDeadline: NOW, inHandoff: false } });
  const d = step(p, -32, cfgGate, NOW + 60 * S);                   // even a lapsed final countdown on carried state cannot fire while young
  assert.equal(d.fraction, 0);
  assert.equal(d.slLadder, null);
});

test('gate: a position that never breaches -10% until minute 5 arms at minute 5, normally', () => {
  const p = pos({ entryTs: NOW });
  step(p, -4, cfgGate, NOW + 60 * S);
  step(p, -8, cfgGate, NOW + 180 * S);                             // the gate check passes with the position above the arm line: nothing engages
  assert.equal(p.slLadder, null);
  step(p, -6, cfgGate, NOW + 240 * S);
  assert.equal(p.slLadder, null);
  step(p, -13, cfgGate, NOW + 300 * S);                            // the minute-5 breach arms from its own check
  assert.equal(p.slLadder.armTs, NOW + 300 * S);
  assert.equal(p.slLadder.softDeadline, NOW + 420 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 480 * S);
});

test('gate off: SL_MIN_AGE_SEC=0 is the as-built machine — a 30-second-old position arms on its first breach (the whole suite above runs on this cfg)', () => {
  const p = pos({ entryTs: NOW });
  const d = step(p, -12, cfg, NOW + 30 * S);
  assert.equal(d.fraction, 0);
  assert.equal(p.slLadder.armTs, NOW + 30 * S);
  assert.equal(p.slLadder.softDeadline, NOW + 150 * S);
  assert.equal(p.slLadder.hardDeadline, NOW + 210 * S);
});
