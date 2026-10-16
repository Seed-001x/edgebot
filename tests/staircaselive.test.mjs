// Staircase-3 LIVE (user order 2026-10-16, "flip it live"): an ordinal>=3
// structure-watch mark routes a live entry attempt into the standard
// onSignal pipeline (Bot._evalStaircase), while the shadow signal keeps
// journaling untouched. These tests pin the routing and its guards —
// kill switch, ordinal floor, already-held, per-mint signal cooldown,
// missing view, eligible() floor — not the gates downstream of onSignal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const MARK = { type: 'mark', ts: T0, mint: 'MINTS', symbol: 'STAIR', watchId: 'sw-1', markId: 'sw-1-m3', ordinal: 3, price: 0.0002, lowPrev: 0.00015, lowNew: 0.00018 };

function rig(over = {}) {
  const cfg = testCfg({ staircaseLive: 1, ...over });
  const clock = { t: T0 };
  const views = new Map();
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  const calls = [];
  bot.onSignal = async (v, sig) => { calls.push({ v, sig }); };
  views.set('MINTS', view({ address: 'MINTS', symbol: 'STAIR' }));
  return { bot, clock, views, calls };
}

const flush = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };

test('staircase live: ordinal-3 mark routes into onSignal as setup staircase, mark context carried', async () => {
  const { bot, calls } = rig();
  bot._evalStaircase(MARK);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'staircase');
  assert.equal(calls[0].sig.strength, 3);
  assert.equal(calls[0].sig.metrics.staircase.ordinal, 3);
  assert.equal(calls[0].sig.metrics.staircase.markId, 'sw-1-m3');
  assert.equal(calls[0].sig.metrics.staircase.markPrice, 0.0002);
  assert.equal(bot.stats.staircase.evals, 1);
  assert.equal(bot.lastSignal.get('MINTS'), T0);
});

test('staircase live: kill switch off — no eval, no call', async () => {
  const { bot, calls } = rig({ staircaseLive: 0 });
  bot._evalStaircase(MARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.staircase, undefined);
});

test('staircase live: ordinal below 3 never routes', async () => {
  const { bot, calls } = rig();
  bot._evalStaircase({ ...MARK, ordinal: 2, markId: 'sw-1-m2' });
  await flush();
  assert.equal(calls.length, 0);
});

test('staircase live: already holding the mint — no re-eval', async () => {
  const { bot, calls } = rig();
  bot.positions.push({ mint: 'MINTS', symbol: 'STAIR' });
  bot._evalStaircase(MARK);
  await flush();
  assert.equal(calls.length, 0);
});

test('staircase live: per-mint signal cooldown suppresses a second mark moments later', async () => {
  const { bot, clock, calls } = rig();
  bot._evalStaircase(MARK);
  await flush();
  clock.t += 60000; // 1m later — inside the 10m signal cooldown
  bot._evalStaircase({ ...MARK, ordinal: 4, markId: 'sw-1-m4' });
  await flush();
  assert.equal(calls.length, 1);
  clock.t += 10 * 60000; // cooldown over — the next higher low judges fresh
  bot._evalStaircase({ ...MARK, ordinal: 5, markId: 'sw-1-m5' });
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sig.metrics.staircase.ordinal, 5);
});

test('staircase live: missing view drops the eval, counted, no call', async () => {
  const { bot, views, calls } = rig();
  views.delete('MINTS');
  bot._evalStaircase(MARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.staircase.noView, 1);
});

test('staircase live: eligible() failure journals a skipped staircase signal, no onSignal', async () => {
  const { bot, views, calls } = rig();
  views.set('MINTS', view({ address: 'MINTS', symbol: 'STAIR', chgH1: -80 })); // dead bounce — fails the tradability floor
  bot._evalStaircase(MARK);
  await flush();
  assert.equal(calls.length, 0);
  const recs = bot.journal.signals.filter(s => s.setup === 'staircase');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].decision, 'skipped');
  assert.match(recs[0].reasons[0], /staircase-live:/);
});

test('staircase live: the structure watch onMark seam fires the eval (and the shadow still journals)', async () => {
  const { bot, calls } = rig();
  bot.structureWatch.onMark({ ...MARK, ordinal: 6, markId: 'sw-1-m6' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'staircase');
  assert.equal(calls[0].sig.metrics.staircase.ordinal, 6);
  // shadow side untouched: the mark produced a staircase shadow record too
  assert.ok(bot.staircaseSignal.emitted.has('sw-1-m6'), 'shadow signal emitted for the same mark');
});
