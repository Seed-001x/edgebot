// Answered re-signals (user order 2026-10-15): when a coin the user has
// already ANSWERED (marked, with a verdict + optional note) signals AGAIN,
// the journal writes one shadow record to resignal_shadow.jsonl so the
// re-signal's tracked outcome can be scored against his verdict later.
// Record-only — these tests pin the matching rule (earlier marked signal,
// +5 min buffer), the one-record-per-(mint, mark) dedupe with re-arm on a
// newer mark, the boot rebuild of the fired set, the read-time outcome
// join, and the HTTP surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { verdictOf, resolveMark, buildResignalCard, RESIGNAL_BUFFER_MS } from '../src/resignalLab.js';
import { tmp, testCfg } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const MIN = 60000;
const readRsig = (dir) => { try { return fs.readFileSync(path.join(dir, 'resignal_shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

test('resignals: verdict vocabulary matches the dashboard Answered chips', () => {
  assert.equal(verdictOf(true, 'skipped'), 'Good coin — missed it');
  assert.equal(verdictOf(true, 'shadow'), 'Good coin — missed it');
  assert.equal(verdictOf(false, 'skipped'), 'Correct skip');
  assert.equal(verdictOf(true, 'taken'), 'You backed it');
  assert.equal(verdictOf(false, 'taken'), 'Bad setup — avoid');
});

test('resignals: buffer, fields, dedupe — one record per (mint, mark)', () => {
  const dir = tmp();
  let t = T0;
  const j = new Journal(dir, { now: () => t });
  const a = j.signal({ mint: 'M1', symbol: 'ONE', setup: 'pop', decision: 'skipped', reasons: [], price: 2, mc: 100000 });
  t = T0 + 1 * MIN;
  const mark = j.recordFeedback({ mint: 'M1', symbol: 'ONE', good: true, signalId: a });
  j.setFeedbackNote(mark.key, 'signal came too late');
  // Inside the buffer (marked signal +3m): no record.
  t = T0 + 3 * MIN;
  j.signal({ mint: 'M1', symbol: 'ONE', setup: 'pop', decision: 'skipped', reasons: [], price: 2.1, mc: 105000 });
  assert.equal(readRsig(dir).length, 0);
  assert.equal(j.resignalFired.size, 0);
  // Past the buffer: fires once, carrying his verdict + note + both mcs.
  t = T0 + 7 * MIN;
  const c = j.signal({ mint: 'M1', symbol: 'ONE', setup: 'trend', decision: 'taken', reasons: [], price: 2.6, mc: 130000 });
  const recs = readRsig(dir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'resignal');
  assert.equal(recs[0].verdict, 'Good coin — missed it');
  assert.equal(recs[0].good, true);
  assert.equal(recs[0].notePresent, true);
  assert.equal(recs[0].note, 'signal came too late');
  assert.equal(recs[0].markedTs, T0);
  assert.equal(recs[0].markedMc, 100000);
  assert.equal(recs[0].resignalMc, 130000);
  assert.equal(recs[0].resignalSetup, 'trend');
  assert.equal(recs[0].resignalDecision, 'taken');
  assert.equal(recs[0].signalKey, c);
  // Later signals for the same mint do NOT re-fire the same mark.
  t = T0 + 30 * MIN;
  j.signal({ mint: 'M1', symbol: 'ONE', setup: 'pop', decision: 'skipped', reasons: [], price: 2.4, mc: 120000 });
  assert.equal(readRsig(dir).length, 1);
});

test('resignals: a newer mark re-arms the mint; fired set rebuilds at boot', () => {
  const dir = tmp();
  let t = T0;
  const j = new Journal(dir, { now: () => t });
  const a = j.signal({ mint: 'M1', symbol: 'ONE', setup: 'pop', decision: 'skipped', reasons: [], price: 2, mc: 100000 });
  t = T0 + 1 * MIN;
  j.recordFeedback({ mint: 'M1', symbol: 'ONE', good: true, signalId: a });
  t = T0 + 7 * MIN;
  const c = j.signal({ mint: 'M1', symbol: 'ONE', setup: 'pop', decision: 'taken', reasons: [], price: 2.6, mc: 130000 });
  assert.equal(readRsig(dir).length, 1);
  // He answers the NEW signal too (bad, on a taken) — a new mark key re-arms.
  t = T0 + 8 * MIN;
  j.recordFeedback({ mint: 'M1', symbol: 'ONE', good: false, signalId: c });
  t = T0 + 20 * MIN;
  j.signal({ mint: 'M1', symbol: 'ONE', setup: 'pop', decision: 'skipped', reasons: [], price: 3, mc: 150000 });
  const recs = readRsig(dir);
  assert.equal(recs.length, 2);
  assert.equal(recs[1].verdict, 'Bad setup — avoid'); // verdict of the SECOND mark (its signal was taken)
  assert.equal(recs[1].markedTs, T0 + 7 * MIN);
  // Boot rebuild: a fresh Journal over the same dir knows both marks fired.
  const j2 = new Journal(dir, { now: () => t });
  assert.equal(j2.resignalFired.size, 2);
  t = T0 + 40 * MIN;
  j2.signal({ mint: 'M1', symbol: 'ONE', setup: 'pop', decision: 'skipped', reasons: [], price: 3.1, mc: 155000 });
  assert.equal(readRsig(dir).length, 2);
});

test('resignals: mint+ts marks resolve to the latest signal at or before the tap', () => {
  const dir = tmp();
  let t = T0;
  const j = new Journal(dir, { now: () => t });
  j.signal({ mint: 'M2', symbol: 'TWO', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 50000 });
  t = T0 + 2 * MIN;
  j.recordFeedback({ mint: 'M2', symbol: 'TWO', good: false, signalId: null }); // legacy mt: key
  t = T0 + 4 * MIN; // still inside the buffer off the marked signal (T0)
  j.signal({ mint: 'M2', symbol: 'TWO', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 51000 });
  assert.equal(readRsig(dir).length, 0);
  t = T0 + 9 * MIN;
  j.signal({ mint: 'M2', symbol: 'TWO', setup: 'pop', decision: 'skipped', reasons: [], price: 1.2, mc: 60000 });
  const recs = readRsig(dir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].verdict, 'Correct skip');
  assert.equal(recs[0].markedTs, T0);
  assert.equal(recs[0].markedMc, 50000);
  assert.equal(recs[0].notePresent, false);
  assert.equal(recs[0].note, null);
});

test('resignals: unresolvable marks are skipped silently', () => {
  const dir = tmp();
  let t = T0;
  const j = new Journal(dir, { now: () => t });
  j.recordFeedback({ mint: 'M3', symbol: 'GHOST', good: true, signalId: 'nope-1' }); // sid: points nowhere
  j.recordFeedback({ mint: 'M4', symbol: 'NONE', good: true, signalId: null });       // mt: no signal exists
  t = T0 + 30 * MIN;
  j.signal({ mint: 'M3', symbol: 'GHOST', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 1000 });
  j.signal({ mint: 'M4', symbol: 'NONE', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 1000 });
  assert.equal(readRsig(dir).length, 0);
  assert.equal(resolveMark({ mint: 'M3', signalId: 'nope-1', ts: T0 }, j.byId, j.signals), null);
});

test('resignals: with two live marks on a mint, the most recent marked signal wins', () => {
  const dir = tmp();
  let t = T0;
  const j = new Journal(dir, { now: () => t });
  const j1 = j.signal({ mint: 'M5', symbol: 'FIVE', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 10000 });
  t = T0 + 60 * MIN;
  const j2 = j.signal({ mint: 'M5', symbol: 'FIVE', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 20000 });
  t = T0 + 61 * MIN;
  j.recordFeedback({ mint: 'M5', symbol: 'FIVE', good: true, signalId: j1 });
  t = T0 + 62 * MIN;
  j.recordFeedback({ mint: 'M5', symbol: 'FIVE', good: false, signalId: j2 });
  t = T0 + 70 * MIN;
  j.signal({ mint: 'M5', symbol: 'FIVE', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 30000 });
  const recs = readRsig(dir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].markedTs, T0 + 60 * MIN);
  assert.equal(recs[0].verdict, 'Correct skip');
});

test('resignals: card joins outcomes at read time and aggregates per verdict', () => {
  const dir = tmp();
  let t = T0;
  const j = new Journal(dir, { now: () => t });
  const keys = [];
  for (const [mint, sym] of [['MA', 'AAA'], ['MB', 'BBB']]) {
    const s0 = j.signal({ mint, symbol: sym, setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 100000 });
    j.recordFeedback({ mint, symbol: sym, good: true, signalId: s0 });
    t += 10 * MIN;
    keys.push(j.signal({ mint, symbol: sym, setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 110000 }));
    t += 1 * MIN;
  }
  assert.equal(readRsig(dir).length, 2);
  j.byId.get(keys[0]).out = { done: true, r5: 0.1, r15: 0.2, r60: 0.4, maxRet: 1.2, minRet: -0.2, partial: false };
  j.byId.get(keys[1]).out = { done: true, r5: -0.1, r15: -0.05, r60: -0.2, maxRet: 0.3, minRet: -0.5, partial: false };
  const card = j.resignalCard();
  assert.equal(card.enabled, true);
  const v = card.byVerdict['Good coin — missed it'];
  assert.equal(v.n, 2);
  assert.equal(v.finalized, 2);
  assert.equal(v.medianPeak, 0.75);
  assert.equal(v.medianR60, 0.1);
  assert.equal(v.sharePeak50, 0.5);
  assert.equal(v.sharePosR60, 0.5);
  assert.equal(card.all.n, 2);
  assert.equal(card.all.medianPeak, 0.75);
  assert.equal(card.all.sharePosR60, 0.5);
  assert.equal(card.recent.length, 2);
  assert.equal(card.recent[0].out.done, true);
  assert.equal(card.recent[0].out.maxRet, 0.3); // newest first
  assert.deepEqual(card.baseline, { runners: 21.8, crashes: 38.1, r60: -37.5, label: 'pinned taken-pop baseline — context only' });
});

test('resignals: empty journal card shape', () => {
  const card = buildResignalCard([], () => null);
  assert.deepEqual(card.byVerdict, {});
  assert.deepEqual(card.recent, []);
  assert.equal(card.baseline.runners, 21.8);
  const j = new Journal(tmp(), { now: () => T0 });
  const c2 = j.resignalCard();
  assert.equal(c2.enabled, true);
  assert.deepEqual(c2.byVerdict, {});
  assert.deepEqual(c2.recent, []);
});

test('resignals: HTTP GET /resignals serves the card (seeded journal, boot path)', async () => {
  const dir = tmp();
  // Seed the journal files the way a live bot would have written them: a
  // marked signal 60m before "now", then boot the real Bot over that dir.
  const sigId = `${T0 - 60 * MIN}-1`;
  fs.writeFileSync(path.join(dir, 'signals.jsonl'), JSON.stringify({ id: sigId, ts: T0 - 60 * MIN, mint: 'MS', symbol: 'SEED', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 80000 }) + '\n');
  fs.writeFileSync(path.join(dir, 'feedback.jsonl'), JSON.stringify({ ts: T0 - 59 * MIN, mint: 'MS', symbol: 'SEED', good: true, signalId: sigId, key: `sid:${sigId}` }) + '\n');
  const cfg = testCfg({ dataDir: dir });
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => T0, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  assert.equal(bot.journal.dir, dir);
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const empty = await (await fetch(base + '/resignals')).json();
    assert.equal(empty.enabled, true);
    assert.deepEqual(empty.byVerdict, {});
    assert.equal(empty.baseline.r60, -37.5);
    // A fresh signal for the seeded mint fires the resignal end-to-end.
    bot.journal.signal({ mint: 'MS', symbol: 'SEED', setup: 'pop', decision: 'skipped', reasons: [], price: 1.1, mc: 88000 });
    const recs = readRsig(dir);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].verdict, 'Good coin — missed it');
    bot.journal._rsigCache = null; // the rig's clock is frozen at T0; drop the ~60s card cache the first GET primed
    const card = await (await fetch(base + '/resignals')).json();
    assert.equal(card.byVerdict['Good coin — missed it'].n, 1);
    assert.equal(card.byVerdict['Good coin — missed it'].finalized, 0); // outcome still tracking
    assert.equal(card.recent.length, 1);
    assert.equal(card.recent[0].markedMc, 80000);
    assert.ok(RESIGNAL_BUFFER_MS === 5 * MIN);
  } finally { srv.close(); }
});
