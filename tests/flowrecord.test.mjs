// Flow buys always land on the signals feed (user order 2026-10-15): a tracked
// wallet's buy must journal a signal record whether or not the coin passes
// parameters. Before this, _evalFlow's guards (open position, per-mint signal
// cooldown, missing DexScreener view, the eligible() tradability floor)
// swallowed triggers whole — no record, no visibility, no outcome data.
// Now: blocked triggers journal a record-only 'skipped' signal with the wallet
// label intact (outcome-tracked like any signal); no-view triggers retry for
// up to 5 minutes. What proceeds still faces the unchanged pipeline — these
// tests pin the routing, not the gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const AGG = { wallets: ['W1'], maxSol: 28.82, count: 1, kind: 'solo', label: 'flow: yenni bought 28.82 SOL' };

function rig() {
  const cfg = testCfg({});
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
  bot.onSignal = async (v, sig) => { calls.push(sig); };
  return { bot, clock, views, calls };
}

test('flow record: cooldown-blocked buy still journals, label intact, outcome-tracked', async () => {
  const { bot, views } = rig();
  views.set('MINTF', view({ address: 'MINTF', symbol: 'PEDO' }));
  bot.lastSignal.set('MINTF', T0 - 60000); // signaled 1m ago — inside the 10m cooldown
  await bot._evalFlow('MINTF', AGG);
  assert.equal(bot.journal.signals.length, 1);
  const s = bot.journal.signals[0];
  assert.equal(s.setup, 'flow');
  assert.equal(s.decision, 'skipped');
  assert.equal(s.label, 'flow: yenni bought 28.82 SOL');
  assert.match(s.reasons[0], /already signaled/);
  assert.equal(s.metrics.kind, 'solo');
  assert.ok(bot.journal.pending.has(s.id), 'record-only signal is outcome-tracked (price > 0)');
  assert.equal(bot.stats.flow.recordOnly, 1);
  assert.equal(bot.stats.flow.fires || 0, 0);
});

test('flow record: a wallet dribbling buys does not spam record-only entries', async () => {
  const { bot, clock, views } = rig();
  views.set('MINTF', view({ address: 'MINTF', symbol: 'PEDO' }));
  bot.lastSignal.set('MINTF', T0 - 60000);
  await bot._evalFlow('MINTF', AGG);
  clock.t += 60000;
  await bot._evalFlow('MINTF', AGG);
  clock.t += 60000;
  await bot._evalFlow('MINTF', AGG);
  assert.equal(bot.journal.signals.length, 1, 'one record-only entry per mint per cooldown window');
});

test('flow record: tradability-floor failure journals with the floor reasons', async () => {
  const { bot, views, calls } = rig();
  views.set('MINTF', view({ address: 'MINTF', symbol: 'TINY', mc: 100, liq: 10 }));
  await bot._evalFlow('MINTF', AGG);
  assert.equal(calls.length, 0, 'pipeline not entered');
  assert.equal(bot.journal.signals.length, 1);
  assert.match(bot.journal.signals[0].reasons.join(' '), /mc \$100/);
  assert.equal(bot.journal.signals[0].label, AGG.label);
});

test('flow record: buy into an open position journals as already-holding', async () => {
  const { bot, views, calls } = rig();
  views.set('MINTF', view({ address: 'MINTF', symbol: 'HELD' }));
  bot.positions.push({ mint: 'MINTF' });
  await bot._evalFlow('MINTF', AGG);
  assert.equal(calls.length, 0);
  assert.equal(bot.journal.signals.length, 1);
  assert.match(bot.journal.signals[0].reasons[0], /already holding/);
});

test('flow record: clean trigger still goes through the pipeline, no record-only entry', async () => {
  const { bot, views, calls } = rig();
  views.set('MINTF', view({ address: 'MINTF', symbol: 'CLEAN' }));
  await bot._evalFlow('MINTF', AGG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, AGG.label);
  assert.equal(bot.journal.signals.length, 0, '_evalFlow itself journals nothing on the live path (onSignal does)');
  assert.equal(bot.stats.flow.fires, 1);
  assert.equal(bot.lastSignal.get('MINTF'), T0);
});

test('flow record: no-view trigger queues, then fires when the view appears', async () => {
  const { bot, clock, views, calls } = rig();
  await bot._evalFlow('MINTF', AGG); // no view yet
  assert.equal(bot.journal.signals.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(bot.flowPending.size, 1);
  views.set('MINTF', view({ address: 'MINTF', symbol: 'FRESH' }));
  clock.t += 21000;
  await bot._flowRetryTick(clock.t);
  assert.equal(calls.length, 1, 'retry delivered the trigger once the coin was indexed');
  assert.equal(bot.flowPending.size, 0);
});

test('flow record: no-view trigger is counted and dropped after 5 minutes', async () => {
  const { bot, clock, calls } = rig();
  await bot._evalFlow('MINTF', AGG);
  clock.t += 6 * 60000;
  await bot._flowRetryTick(clock.t);
  assert.equal(bot.flowPending.size, 0);
  assert.equal(bot.stats.flow.noViewDropped, 1);
  assert.equal(calls.length, 0);
  assert.equal(bot.journal.signals.length, 0, 'an unpriceable mint journals nothing — it could never be outcome-tracked');
});

test('flow record: after the cooldown expires a fresh buy evaluates for real', async () => {
  const { bot, clock, views, calls } = rig();
  views.set('MINTF', view({ address: 'MINTF', symbol: 'PEDO' }));
  bot.lastSignal.set('MINTF', T0 - 60000);
  await bot._evalFlow('MINTF', AGG); // record-only
  clock.t += 11 * 60000; // cooldown (10m) over
  await bot._evalFlow('MINTF', AGG);
  assert.equal(calls.length, 1, 'second buy reaches the pipeline once the window passes');
  assert.equal(bot.journal.signals.length, 1, 'still just the one record-only entry');
});
