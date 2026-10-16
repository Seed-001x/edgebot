// Scan Ledger (user order 2026-10-16, RECORD-ONLY): every coin the bot scans
// leaves a permanent session record so coins that ran without ever signaling
// can be found and studied. The signal journal only held the ~10 that fired;
// the other ~750 evaporated with the in-memory history. These tests pin the
// fold, the finalization rules (idle / 3h cap / re-entry = new session), the
// signaled join at finalize, the r15/r60 scorer (never fabricating a missing
// price), the /scanledger card shape, and the SCAN_LEDGER=0 kill switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { ScanLab, buildScanCard } from '../src/scanLab.js';
import { startServer } from '../src/server.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const MIN = 60000;

function rig(cfgOver = {}) {
  const cfg = testCfg({ ...cfgOver });
  const clock = { t: T0 };
  const exec = { solBalance: async () => 1 };
  const bot = new Bot(cfg, { now: () => clock.t, exec });
  return { cfg, clock, bot };
}

test('scanledger: shipped defaults are on / 600s idle', () => {
  const cfg = testCfg({});
  assert.equal(cfg.scanLedger, 1);
  assert.equal(cfg.scanSessionIdleSec, 600);
});

test('scanledger: the fold tracks first/peak/last, peak time, and max volM5 with cheap scalars', () => {
  const { bot } = rig();
  bot._foldScan(view({ price: 1, mc: 100, volM5: 10 }), T0);
  bot._foldScan(view({ price: 2.5, mc: 250, volM5: 40 }), T0 + MIN);
  bot._foldScan(view({ price: 2, mc: 200, volM5: 5 }), T0 + 2 * MIN);
  const s = bot.scanFold.get('MINT1');
  assert.equal(s.samples, 3);
  assert.equal(s.firstPrice, 1);
  assert.equal(s.firstMc, 100);
  assert.equal(s.firstTs, T0);
  assert.equal(s.peakPrice, 2.5);
  assert.equal(s.peakMc, 250);
  assert.equal(s.peakTs, T0 + MIN);
  assert.equal(s.lastPrice, 2);
  assert.equal(s.lastMc, 200);
  assert.equal(s.lastTs, T0 + 2 * MIN);
  assert.equal(s.maxVolM5, 40);
  // a view with no price never folds (mirrors History.record's guard)
  bot._foldScan(view({ price: 0 }), T0 + 3 * MIN);
  assert.equal(bot.scanFold.get('MINT1').samples, 3);
});

test('scanledger: a session finalizes only once idle past the window — and the record is complete', () => {
  const { bot } = rig();
  bot._foldScan(view({ price: 1, mc: 100, volM5: 10 }), T0);
  bot._foldScan(view({ price: 2.5, mc: 250, volM5: 40 }), T0 + MIN);
  bot._scanSweep(T0 + 2 * MIN);
  assert.equal(bot.journal.scanSessions.length, 0, 'still being watched — too fresh to finalize');
  bot._scanSweep(T0 + MIN + 570_000); // sweeps are ~30s-throttled; this one lands idle 570s
  assert.equal(bot.journal.scanSessions.length, 0, 'idle 570s < 600s — not yet');
  bot._scanSweep(T0 + MIN + 601_000);
  assert.equal(bot.journal.scanSessions.length, 1);
  const rec = bot.journal.scanSessions[0];
  assert.equal(rec.type, 'scan');
  assert.equal(rec.id, `MINT1-${T0}`);
  assert.equal(rec.mint, 'MINT1');
  assert.equal(rec.symbol, 'TEST');
  assert.equal(rec.samples, 2);
  assert.equal(rec.durMin, 1);
  assert.equal(rec.runFromFirst, 2.5);
  assert.equal(rec.maxVolM5, 40);
  assert.equal(rec.signaled, false);
  assert.deepEqual(rec.decisions, []);
  assert.deepEqual(rec.setups, []);
  assert.ok(rec.stamp && typeof rec.stamp === 'object');
  assert.equal(bot.scanFold.size, 0, 'finalized sessions leave the fold');
});

test('scanledger: the 3h cap finalizes even a session that is still being viewed', () => {
  const { bot } = rig();
  // a fresh view every 9 minutes: idle never reaches 600s, age reaches 3h
  for (let i = 0; i <= 20; i++) bot._foldScan(view({ price: 1 + i * 0.01 }), T0 + i * 9 * MIN);
  bot._scanSweep(T0 + 20 * 9 * MIN + 1000);
  assert.equal(bot.journal.scanSessions.length, 1);
  assert.equal(bot.journal.scanSessions[0].samples, 21);
});

test('scanledger: the signaled verdict joins journal signals inside the window only', () => {
  const { bot } = rig();
  bot._foldScan(view({}), T0);
  bot._foldScan(view({}), T0 + 5000); // MINT1's window spans [T0, T0+5000]
  bot._foldScan(view({ address: 'MINT2', symbol: 'TWO' }), T0);
  bot.journal.signals.push(
    { mint: 'MINT1', ts: T0 + 1000, decision: 'skipped', setup: 'pop' },
    { mint: 'MINT1', ts: T0 + 2000, decision: 'skipped', setup: 'pop' },
    { mint: 'MINT1', ts: T0 - 5000, decision: 'taken', setup: 'trend' }, // before the window — must not count
    { mint: 'MINT2', ts: T0 - 5000, decision: 'taken', setup: 'trend' }, // MINT2's only signal is outside its window
  );
  bot._scanSweep(T0 + 606_000); // both sessions idle past 600s (MINT1's last view was at T0+5000)
  assert.equal(bot.journal.scanSessions.length, 2);
  const one = bot.journal.scanSessions.find(r => r.mint === 'MINT1');
  const two = bot.journal.scanSessions.find(r => r.mint === 'MINT2');
  assert.equal(one.signaled, true);
  assert.deepEqual(one.decisions, ['skipped']);
  assert.deepEqual(one.setups, ['pop']);
  assert.equal(two.signaled, false);
  assert.deepEqual(two.decisions, []);
});

test('scanledger: re-entry after finalization starts a NEW session (the ledger accumulates)', () => {
  const { bot } = rig();
  bot._foldScan(view({ price: 1 }), T0);
  bot._scanSweep(T0 + 601_000);
  assert.equal(bot.journal.scanSessions.length, 1);
  bot._foldScan(view({ price: 3 }), T0 + 1200_000);
  bot._scanSweep(T0 + 1200_000 + 601_000);
  assert.equal(bot.journal.scanSessions.length, 2);
  assert.notEqual(bot.journal.scanSessions[0].id, bot.journal.scanSessions[1].id);
  assert.equal(bot.journal.scanSessions[1].firstPrice, 3);
});

test('scanledger: the scorer fills r15/r60 from observed prices and persists them', () => {
  const cfg = testCfg({});
  const clock = { t: T0 };
  const lab = new ScanLab({ cfg, journal: { scanSessions: [] }, now: () => clock.t });
  assert.equal(lab.register({ id: 'ABCDEF-1', mint: 'MINT1', symbol: 'X', lastTs: T0, lastPrice: 2 }), true);
  assert.deepEqual(lab.pendingMints(), [{ mint: 'MINT1', since: T0 }]);
  lab.observe({ address: 'MINT1', price: 3 }, T0 + 16 * MIN); // +50% at the r15 checkpoint
  assert.equal(lab.scoreOf('ABCDEF-1'), null, 'r60 still open — nothing finalized yet');
  lab.observe({ address: 'OTHER', price: 99 }, T0 + 61 * MIN); // wrong mint — must not fill
  assert.equal(lab.scoreOf('ABCDEF-1'), null);
  lab.observe({ address: 'MINT1', price: 1 }, T0 + 61 * MIN); // −50% at the r60 checkpoint
  const sc = lab.scoreOf('ABCDEF-1');
  assert.equal(sc.r15, 0.5);
  assert.equal(sc.r60, -0.5);
  assert.equal(sc.partial, false);
  const lines = fs.readFileSync(path.join(cfg.dataDir, 'scan_scores.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, 'ABCDEF-1');
});

test('scanledger: a price that never arrives stays null — the score finalizes partial, never fabricated', () => {
  const cfg = testCfg({});
  const clock = { t: T0 };
  const lab = new ScanLab({ cfg, journal: { scanSessions: [] }, now: () => clock.t });
  lab.register({ id: 'ABCDEF-2', mint: 'MINT9', symbol: 'Y', lastTs: T0, lastPrice: 2 });
  lab.tick(T0 + 106 * MIN); // past the horizon, no observation ever arrived
  const sc = lab.scoreOf('ABCDEF-2');
  assert.ok(sc, 'the score record exists so the session leaves pending');
  assert.equal(sc.r15, null);
  assert.equal(sc.r60, null);
  assert.equal(sc.partial, true);
  assert.equal(lab.pendingMints().length, 0);
});

test('scanledger: the card totals, orders near-misses by run, and joins scores', () => {
  const sessions = [
    { id: 'a-1', mint: 'A', symbol: 'AAA', samples: 10, runFromFirst: 3, signaled: false },
    { id: 'b-2', mint: 'B', symbol: 'BBB', samples: 2, runFromFirst: 9, signaled: false },  // too few samples for the study list
    { id: 'c-3', mint: 'C', symbol: 'CCC', samples: 8, runFromFirst: 5, signaled: true },
    { id: 'd-4', mint: 'D', symbol: 'DDD', samples: 6, runFromFirst: 7, signaled: false },
  ];
  const scores = new Map([['d-4', { id: 'd-4', r15: 0.2, r60: -0.1 }]]);
  const card = buildScanCard(sessions, (id) => scores.get(id) || null, T0);
  assert.equal(card.generatedTs, T0);
  assert.equal(card.totals.sessions, 4);
  assert.equal(card.totals.signaled, 1);
  assert.equal(card.totals.signaledPct, 25);
  assert.deepEqual(card.nearMisses.map(r => r.id), ['d-4', 'a-1']);
  assert.equal(card.nearMisses[0].r15, 0.2);
  assert.equal(card.nearMisses[0].r60, -0.1);
  assert.equal(card.nearMisses[1].r15, null, 'unscored sessions join as null, never a number');
  assert.equal(card.recent[0].id, 'd-4', 'recent is newest-first');
});

test('scanledger: GET /scanledger serves the card and /scans stays the legacy cycle array', async () => {
  const { bot } = rig();
  bot._foldScan(view({ price: 1, mc: 100, volM5: 10 }), T0);
  bot._foldScan(view({ price: 3, mc: 300, volM5: 20 }), T0 + MIN);
  bot._scanSweep(T0 + MIN + 601_000); // idle past the window -> finalized
  assert.equal(bot.journal.scanSessions.length, 1);
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const card = await (await fetch(base + '/scanledger')).json();
    assert.equal(card.totals.sessions, 1);
    assert.equal(card.totals.signaled, 0);
    assert.equal(card.recent.length, 1);
    assert.equal(card.recent[0].symbol, 'TEST');
    assert.equal(card.recent[0].runFromFirst, 3);
    // /scans is the freeze-1b per-cycle stream — a bare array, untouched by the ledger
    const cycles = await (await fetch(base + '/scans')).json();
    assert.ok(Array.isArray(cycles), '/scans default stays a bare array');
  } finally { srv.close(); }
});

test('scanledger: SCAN_LEDGER=0 disables the fold, the sweep, and the scorer', () => {
  const { bot } = rig({ scanLedger: 0 });
  bot._foldScan(view({ price: 1 }), T0);
  assert.equal(bot.scanFold.size, 0);
  bot._scanSweep(T0 + 10_000_000);
  assert.equal(bot.journal.scanSessions.length, 0);
  assert.equal(bot.scanLab.enabled, false);
  assert.equal(bot.scanLab.register({ id: 'x-1', mint: 'M', lastTs: T0, lastPrice: 1 }), false);
  const card = bot.scanLedgerCard();
  assert.equal(card.totals.sessions, 0);
});
