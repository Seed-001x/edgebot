import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, tmp } from './helpers.mjs';

// MOONBAG TRAIL CONFIRMATION (owner order 2026-10-16 23:12 EDT, "Give it a
// 1 min timer"): section 3c no longer sells the bag on the first sub-line
// print. The breach must HOLD for BAG_TRAIL_CONFIRM_SEC (default 60): state
// prep stamps bagTrailSince on the first breached check, any check back
// above the line clears it (snap-back disarms — the floorSince discipline),
// and the first check at/after the window with the line still breached
// sells in full with the hold in the reason. Founding case: Chameleon's bag
// trailed out at a V-bottom (peak 1.93x, sold at 1.276x) that recovered
// above the peak within ~3 minutes. Window 0 = the pre-timer instant fire,
// byte-for-byte. The position shape mirrors exits.test.mjs's moonbag test:
// peak 2.8x, trail line 2.8 × (1 − 0.15) = 2.38 on the remaining basis.
const NOW = 1_000_000_000_000;
const cfg = testCfg({ stallProbationSec: 0 }); // bagTrailConfirmSec rides the config default (60)
const pos = (o = {}) => ({ entrySol: 0.02, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 5 * 60000, ...o });
const mark = (valueSol, o = {}) => ({ valueSol, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });
const bag = (o = {}) => pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.25, peakRatio: 2.8, ...o });
const BELOW = 0.02 * 0.25 * 2.35; // ratio 2.35 — past the -15% line (16.1% off peak)
const ABOVE = 0.02 * 0.25 * 2.42; // ratio 2.42 — back above the line (13.6% off peak)
// Thread a decision's trail stamp into the next check's position, the way
// bot.js threads floorSince/stopArmedTs off every decision.
const carry = (p, d) => ({ ...p, bagTrailSince: d.bagTrailSince });

test('config: BAG_TRAIL_CONFIRM_SEC defaults to 60, env overrides, validation bounds it', () => {
  assert.equal(loadConfig({ DATA_DIR: tmp() }).bagTrailConfirmSec, 60);
  assert.equal(loadConfig({ DATA_DIR: tmp(), BAG_TRAIL_CONFIRM_SEC: '0' }).bagTrailConfirmSec, 0);
  assert.equal(loadConfig({ DATA_DIR: tmp(), BAG_TRAIL_CONFIRM_SEC: '90' }).bagTrailConfirmSec, 90);
  const base = loadConfig({ DATA_DIR: tmp() });
  assert.ok(validateConfig({ ...base, bagTrailConfirmSec: -1 }).some(e => /BAG_TRAIL_CONFIRM_SEC/.test(e)));
  assert.ok(validateConfig({ ...base, bagTrailConfirmSec: 3601 }).some(e => /BAG_TRAIL_CONFIRM_SEC/.test(e)));
  assert.ok(!validateConfig({ ...base, bagTrailConfirmSec: 0 }).some(e => /BAG_TRAIL_CONFIRM_SEC/.test(e)));
  assert.ok(!validateConfig(base).some(e => /BAG_TRAIL_CONFIRM_SEC/.test(e)));
});

test('(a) a breach that recovers inside the window sells nothing and clears the pending', () => {
  const p0 = bag();
  const d1 = evaluateExit(p0, mark(BELOW), cfg, NOW); // first sub-line print: pends, no sale
  assert.equal(d1.fraction, 0); assert.equal(d1.reason, null);
  assert.equal(d1.bagTrailSince, NOW);
  assert.ok(d1.deadflowEvents.some(e => e.type === 'trail-pending'));
  const d2 = evaluateExit(carry(p0, d1), mark(BELOW), cfg, NOW + 30000); // still under at +30s: held, not ripe
  assert.equal(d2.fraction, 0); assert.equal(d2.bagTrailSince, NOW);
  const d3 = evaluateExit(carry(p0, d2), mark(ABOVE), cfg, NOW + 45000); // snap back above the line: disarmed
  assert.equal(d3.fraction, 0); assert.equal(d3.bagTrailSince, null);
  assert.ok(d3.deadflowEvents.some(e => e.type === 'trail-cleared'));
  // ...and the recovered bag simply rides: a fresh print above the line is quiet.
  const d4 = evaluateExit(carry(p0, d3), mark(ABOVE), cfg, NOW + 120000);
  assert.equal(d4.fraction, 0); assert.equal(d4.bagTrailSince, null);
});

test('(b) a breach that holds the full window sells the bag in full, reason carries the hold', () => {
  const p0 = bag();
  const d1 = evaluateExit(p0, mark(BELOW), cfg, NOW);
  assert.equal(d1.fraction, 0); assert.equal(d1.bagTrailSince, NOW);
  const d2 = evaluateExit(carry(p0, d1), mark(BELOW), cfg, NOW + 59999); // 1ms short: still holding
  assert.equal(d2.fraction, 0);
  const d3 = evaluateExit(carry(p0, d2), mark(BELOW), cfg, NOW + 60000); // window met, line still breached
  assert.equal(d3.fraction, 1);
  assert.match(d3.reason, /^moonbag trail \(15% off peak 2\.80x, now 135\.0%, held 60s\)$/);
});

test('(c) BAG_TRAIL_CONFIRM_SEC=0 restores the instant fire exactly — same check, same string, no state', () => {
  const cfg0 = testCfg({ stallProbationSec: 0, bagTrailConfirmSec: 0 });
  const d = evaluateExit(bag(), mark(BELOW), cfg0, NOW);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /^moonbag trail \(15% off peak 2\.80x, now 135\.0%\)$/);
  assert.equal(d.bagTrailSince, null);
  assert.ok(!d.deadflowEvents.some(e => e.type === 'trail-pending' || e.type === 'trail-cleared'));
});

test('(d) a second breach after a cleared one starts a FRESH window — no accumulated credit', () => {
  const p0 = bag();
  const d1 = evaluateExit(p0, mark(BELOW), cfg, NOW); // breach #1 pends at NOW
  const d2 = evaluateExit(carry(p0, d1), mark(ABOVE), cfg, NOW + 50000); // clears at +50s
  assert.equal(d2.bagTrailSince, null);
  const d3 = evaluateExit(carry(p0, d2), mark(BELOW), cfg, NOW + 55000); // breach #2 pends at +55s
  assert.equal(d3.fraction, 0); assert.equal(d3.bagTrailSince, NOW + 55000);
  // +110s is 60s after breach #1 would have matured — but only 55s into #2: still no sale.
  const d4 = evaluateExit(carry(p0, d3), mark(BELOW), cfg, NOW + 110000);
  assert.equal(d4.fraction, 0);
  const d5 = evaluateExit(carry(p0, d4), mark(BELOW), cfg, NOW + 115000); // +60s into breach #2: sells
  assert.equal(d5.fraction, 1); assert.match(d5.reason, /held 60s\)$/);
});

test('(e) the pending stamp round-trips on the position alone — a restored stamp judges by its age', () => {
  // A position reloaded from disk mid-pending (restart): the stamp is just
  // a number on the position; no in-memory state is involved.
  const restored = bag({ bagTrailSince: NOW - 61000 });
  const d = evaluateExit(restored, mark(BELOW), cfg, NOW); // breach already 61s old: sells
  assert.equal(d.fraction, 1); assert.match(d.reason, /held 60s\)$/);
  const young = bag({ bagTrailSince: NOW - 30000 });
  const d2 = evaluateExit(young, mark(BELOW), cfg, NOW); // 30s in: holds, stamp untouched
  assert.equal(d2.fraction, 0); assert.equal(d2.bagTrailSince, NOW - 30000);
  // A pre-build position (no field at all) starts unpended: first breach stamps, never fires.
  const legacy = bag();
  assert.ok(!('bagTrailSince' in legacy));
  const d3 = evaluateExit(legacy, mark(BELOW), cfg, NOW);
  assert.equal(d3.fraction, 0); assert.equal(d3.bagTrailSince, NOW);
});

test('scope: no pending accrues pre-TP2, and a carried stamp is dropped outside the trail stage', () => {
  const mid = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 2.8 }); // pre-TP2, deep under any line
  const d = evaluateExit(mid, mark(0.02 * 0.6 * 1.2), cfg, NOW);
  assert.equal(d.bagTrailSince, null);
  assert.ok(!d.deadflowEvents.some(e => e.type === 'trail-pending'));
  const carried = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 2.8, bagTrailSince: NOW - 5000 });
  assert.equal(evaluateExit(carried, mark(0.02 * 0.6 * 1.2), cfg, NOW).bagTrailSince, null);
});
