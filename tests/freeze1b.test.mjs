// Freeze work 1b (user 2026-10-14) — RECORD-ONLY additions. Two pins:
//  (a) a signal preempted by the RISK layer (canEnter at gate0 — HALT latch,
//      streak pause, balance halt, max positions, hourly cap...) still gets
//      the gate stack evaluated in shadow and journaled as shadowGates /
//      shadowGatePass, while its decision, reason and the live checks map
//      stay exactly what they were and no position opens;
//  (b) every discovery cycle persists ONE scan record (scans.jsonl) with the
//      watchlist size and per-source intake counts, so "coins scanned per
//      hour" is recoverable later.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { startServer } from '../src/server.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const riggedRug = { ...healthyRug, topHolders: Array.from({ length: 18 }, (_, i) => ({ owner: 'w' + i, address: 'w' + i, amount: 498001881166, pct: 0.05 })) };

function rig(cfgOver = {}, rug = healthyRug, discover = null) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, ...cfgOver });
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: discover || (async () => Object.assign(new Map(), { counts: {} })),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => rug, searchByName: async () => [],
  });
  return { cfg, bot, clock, q };
}

test('1b shadow gates: a HALT-preempted signal carries the would-be gate verdict, decision untouched', async () => {
  const { cfg, bot } = rig();
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(T0)); // the risk layer preempts every entry
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(bot.positions.length, 0, 'no position opens');
  assert.equal(bot.stats.entries, 0, 'no entry counted');
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec, 'skip journaled');
  // live outcome byte-identical to the pre-1b path: same decision, same reason
  assert.deepEqual(rec.reasons, ['risk: HALT file present']);
  // the live checks map carries only what the live pipeline actually ran —
  // the gate stack never ran live, so no gate results may appear in it
  assert.equal(rec.gates.risk.pass, false);
  assert.match(rec.gates.risk.reason, /HALT/);
  assert.equal(rec.gates.depth, undefined, 'live gates map must not absorb shadow results');
  assert.equal(rec.gatePass, undefined, 'no live gatePass on a risk-preempted record');
  // the shadow verdict rides alongside, clearly namespaced
  assert.equal(rec.shadowGatePass, true, 'healthy coin would have passed the gates');
  assert.ok(rec.shadowGates && rec.shadowGates.depth.pass === true, 'shadow map carries per-gate results');
  assert.ok(rec.shadowGates.extension, 'shadow evaluation includes the pre-checks, like the D1 shadow path');
  // and it is persisted, not just in memory
  const line = fs.readFileSync(path.join(cfg.dataDir, 'signals.jsonl'), 'utf8').trim().split('\n').pop();
  const persisted = JSON.parse(line);
  assert.equal(persisted.shadowGatePass, true);
  assert.ok(persisted.shadowGates && persisted.shadowGates.depth);
});

test('1b shadow gates: a shadow FAIL never leaks into the live decision (rigged coin under HALT)', async () => {
  const { cfg, bot } = rig({}, riggedRug);
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(T0));
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.deepEqual(rec.reasons, ['risk: HALT file present'], 'reason stays the risk reason, not the gate fail');
  assert.equal(rec.shadowGatePass, false, 'rigged coin would have failed the gates');
  assert.equal(rec.shadowGates.clones.pass, false);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.stats.entries, 0);
});

test('1b shadow gates: streak-pause preemption gets the same shadow verdict', async () => {
  const { bot, clock } = rig();
  await bot.start();
  bot.risk.s.streakPausedAt = clock.t; bot.risk.s.lossStreak = 4; // D4 pause latched
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec.reasons[0].startsWith('risk: streak pause'), JSON.stringify(rec.reasons));
  assert.equal(rec.shadowGatePass, true);
  assert.equal(bot.positions.length, 0);
});

test('1b shadow gates: a signal that is NOT risk-preempted carries no shadow fields (live path untouched)', async () => {
  const { bot } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(bot.positions.length, 1, 'healthy signal still takes its position');
  const rec = bot.journal.signals.find(s => s.decision === 'taken');
  assert.ok(rec, 'take journaled');
  assert.equal(rec.gatePass, true, 'real gate verdict on the record as before');
  assert.equal(rec.shadowGates, undefined);
  assert.equal(rec.shadowGatePass, undefined);
});

test('1b scans: one persisted record per discovery cycle with watchlist size + per-source intake', async () => {
  const discover = async () => Object.assign(
    new Map([['MINT1', 'jup-trending'], ['MINT2', 'jup-trending'], ['MINT3', 'pump-new']]),
    { counts: { 'jup-trending': { returned: 150, taken: 2 }, 'pump-new': { returned: 40, taken: 1 } } },
  );
  const { cfg, bot, clock } = rig({}, healthyRug, discover);
  fs.writeFileSync(path.join(cfg.dataDir, 'reallists.json'), JSON.stringify({ trending: [{ mint: 'RL1' }], movers: [], graduated: [], new: [] }));
  // async intake between cycles (live feed + graduation watch enter via noteMint)
  assert.equal(bot.noteMint('LIVE1', 'live-ws'), true);
  assert.equal(bot.noteMint('GRAD1', 'graduated'), true);
  await bot.discoverTick();
  assert.equal(bot.journal.scans.length, 1, 'one record for the cycle');
  const rec = bot.journal.scans[0];
  assert.equal(rec.ts, clock.t);
  assert.equal(rec.watchSize, bot.watch.size, 'record carries the cycle-end watchlist size');
  assert.equal(rec.watchSize, 6, 'MINT1/MINT2/MINT3 + RL1 + LIVE1 + GRAD1');
  assert.deepEqual(rec.intake, { 'jup-trending': 2, 'pump-new': 1, reallists: 1, 'live-ws': 1, graduated: 1 });
  // persisted to scans.jsonl in the data dir
  const lines = fs.readFileSync(path.join(cfg.dataDir, 'scans.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), rec);
  // a second cycle writes a second record; async-intake counters reset per cycle
  clock.t += 60000;
  await bot.discoverTick();
  assert.equal(bot.journal.scans.length, 2);
  const rec2 = bot.journal.scans[1];
  assert.equal(rec2.intake['jup-trending'], 2, 'discover() intake is counted fresh each cycle');
  assert.equal(rec2.intake['live-ws'] || 0, 0, 'no live-feed adds since the last cycle');
  assert.equal(rec2.intake.reallists || 0, 0, 'RL1 already watched — not re-counted');
  // read-only endpoint: bare tail by default, paging envelope on request
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const all = await (await fetch(base + '/scans')).json();
    assert.ok(Array.isArray(all) && all.length === 2 && all[0].ts === rec2.ts, 'newest first');
    const page = await (await fetch(base + '/scans?limit=1')).json();
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].ts, rec2.ts);
  } finally { srv.close(); }
});
