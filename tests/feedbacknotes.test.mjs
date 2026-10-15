// Feedback notes (user order 2026-10-15): the user can attach a free-text
// "why I answered that way" to any signal he marked, and the dashboard's
// Answered view lists his marks joined to their signals + outcomes.
// Record-only data — these tests pin the store, the reload path (note lines
// must never be counted as marks), the join, and the HTTP surface incl. the
// admin guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal, feedbackKeyOf } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { tmp, testCfg } from './helpers.mjs';

const T0 = 1_000_000_000_000;

test('feedback notes: key is signal-id based, mint+ts fallback', () => {
  assert.equal(feedbackKeyOf({ signalId: 'abc', mint: 'M', ts: 5 }), 'sid:abc');
  assert.equal(feedbackKeyOf({ signalId: null, mint: 'M', ts: 5 }), 'mt:M:5');
  assert.equal(feedbackKeyOf(null), null);
});

test('feedback notes: set, read back joined to the signal, clear with empty', () => {
  const j = new Journal(tmp(), { now: () => T0 });
  const sid = j.signal({ mint: 'M1', symbol: 'COIN', setup: 'pop', decision: 'skipped', reasons: ['fresh: x'], price: 2, mc: 120000 });
  const rec = j.recordFeedback({ mint: 'M1', symbol: 'COIN', good: true, signalId: sid });
  assert.equal(rec.key, `sid:${sid}`);
  const noted = j.setFeedbackNote(rec.key, '  great coin — signal came too late, near the top  ');
  assert.equal(noted.note, 'great coin — signal came too late, near the top'); // trimmed
  const list = j.feedbackList();
  assert.equal(list.length, 1);
  assert.equal(list[0].note, 'great coin — signal came too late, near the top');
  assert.equal(list[0].good, true);
  assert.equal(list[0].signal.id, sid);
  assert.equal(list[0].signal.setup, 'pop');
  assert.equal(list[0].signal.decision, 'skipped');
  assert.equal(list[0].signal.out.done, false);
  j.setFeedbackNote(rec.key, '');
  assert.equal(j.feedbackList()[0].note, null); // cleared
  assert.equal(j.setFeedbackNote('sid:nope', 'x'), null); // unknown key
});

test('feedback notes: note trims to 500 chars', () => {
  const j = new Journal(tmp(), { now: () => T0 });
  const rec = j.recordFeedback({ mint: 'M2', symbol: 'LONG', good: false, signalId: null });
  const noted = j.setFeedbackNote(rec.key, 'x'.repeat(900));
  assert.equal(noted.note.length, 500);
});

test('feedback notes: survive reload; note lines are not marks', () => {
  const dir = tmp();
  const j1 = new Journal(dir, { now: () => T0 });
  const sid = j1.signal({ mint: 'M3', symbol: 'RLD', setup: 'trend', decision: 'shadow', reasons: [], price: 1, mc: 90000 });
  const rec = j1.recordFeedback({ mint: 'M3', symbol: 'RLD', good: true, signalId: sid });
  j1.setFeedbackNote(rec.key, 'would have run with an earlier signal');
  const j2 = new Journal(dir, { now: () => T0 });
  assert.equal(j2.feedback.length, 1, 'the note line must not load as a second mark');
  assert.equal(j2.feedbackList()[0].note, 'would have run with an earlier signal');
  assert.equal(j2.blacklistedMints().size, 0, 'a good mark + its note never blacklist the mint');
});

test('feedback notes: mint+ts fallback join finds the signal without an id', () => {
  const j = new Journal(tmp(), { now: () => T0 });
  j.signal({ mint: 'M4', symbol: 'FBK', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 50000 });
  j.recordFeedback({ mint: 'M4', symbol: 'FBK', good: false, signalId: null });
  const list = j.feedbackList();
  assert.equal(list[0].signal.symbol, 'FBK');
  assert.equal(list[0].signal.setup, 'pop');
});

function botRig() {
  const cfg = testCfg({});
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => T0, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  return bot;
}

test('feedback notes: HTTP round-trip — POST /feedback, note, GET /feedback', async () => {
  const bot = botRig();
  const sid = bot.journal.signal({ mint: 'M5', symbol: 'HTTP', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 42000 });
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const fb = await post('/feedback', { mint: 'M5', symbol: 'HTTP', good: true, signalId: sid });
    assert.equal(fb.status, 200);
    const key = fb.body.feedback.key;
    assert.equal(key, `sid:${sid}`);
    const nt = await post('/feedback/note', { key, note: 'signaled at the top' });
    assert.equal(nt.status, 200);
    assert.equal(nt.body.feedback.note, 'signaled at the top');
    const bad = await post('/feedback/note', { key: 'sid:missing', note: 'x' });
    assert.equal(bad.status, 404);
    const noNote = await post('/feedback/note', { key });
    assert.equal(noNote.status, 400);
    const list = await (await fetch(base + '/feedback')).json();
    assert.equal(list.feedback.length, 1);
    assert.equal(list.feedback[0].note, 'signaled at the top');
    assert.equal(list.feedback[0].signal.mc, 42000);
  } finally { srv.close(); }
});

test('feedback notes: POST /feedback/note is behind the admin guard', async () => {
  process.env.ADMIN_KEY = 'test-key-123';
  try {
    const bot = botRig();
    bot.journal.recordFeedback({ mint: 'M6', symbol: 'SEC', good: false, signalId: null });
    const key = bot.journal.feedbackList()[0].key;
    const srv = startServer(bot, 0);
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const noKey = await fetch(base + '/feedback/note', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, note: 'x' }) });
      assert.equal(noKey.status, 401);
      const withKey = await fetch(base + '/feedback/note', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'test-key-123' }, body: JSON.stringify({ key, note: 'guarded note' }) });
      assert.equal(withKey.status, 200);
      assert.equal(bot.journal.feedbackList()[0].note, 'guarded note');
      const pub = await fetch(base + '/feedback'); // GETs stay public
      assert.equal(pub.status, 200);
    } finally { srv.close(); }
  } finally { delete process.env.ADMIN_KEY; }
});
