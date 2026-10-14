// Shadow-only setups (user 2026-10-14, forward plan step 1b): TREND_SHADOW / LIFTOFF_SHADOW
// make the trend and liftoff detectors log + outcome-track their signals WITHOUT buying —
// no position, no slot, no stats.entries. Knobs default off = today's live behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function rig(cfgOver = {}) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver });
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { cfg, bot, clock };
}

test('config: shadow knobs default off, env 1 turns them on, validation stays clean', () => {
  const d = loadConfig({});
  assert.equal(d.trendShadow, 0);
  assert.equal(d.liftoffShadow, false);
  const on = loadConfig({ TREND_SHADOW: '1', LIFTOFF_SHADOW: '1' });
  assert.equal(on.trendShadow, 1);
  assert.equal(on.liftoffShadow, true);
  assert.equal(validateConfig(on).length, 0);
  assert.equal(validateConfig(d).length, 0);
  assert.ok(validateConfig(loadConfig({ TREND_SHADOW: '2' })).some(e => e.includes('TREND_SHADOW')));
});

test('trend shadowed: signal journals as shadow, no buy, no slot, no entries, metrics intact', async () => {
  const { bot } = rig({ trendShadow: 1 });
  await bot.start();
  const metrics = { chgH1: 55, chgM5: 4, buyRatioM5: 0.66, volH1: 250000 };
  await bot.onSignal(view({ price: 1.00 }), { setup: 'trend', strength: 5.5, metrics });
  assert.equal(bot.positions.length, 0, 'shadowed trend must not open a position');
  assert.equal(bot.stats.entries, 0, 'stats.entries must not increment');
  assert.equal(bot.stats.shadowSignals.trend, 1);
  const rec = bot.journal.signals.find(s => s.setup === 'trend');
  assert.ok(rec, 'signal must be journaled');
  assert.equal(rec.decision, 'shadow');
  assert.deepEqual(rec.metrics, metrics, 'journaled metrics stay intact');
  assert.ok(rec.reasons[0].startsWith('shadow:'), JSON.stringify(rec.reasons));
  assert.equal(bot.journal.trades.filter(t => t.type === 'open').length, 0, 'no open trade may be journaled');
});

test('liftoff shadowed: signal journals as shadow, no buy, no slot, no entries', async () => {
  const { bot } = rig({ liftoffShadow: true });
  await bot.start();
  await bot.onSignal(view({ price: 1.00 }), { setup: 'liftoff', strength: 1, metrics: { gainPct: 18 } });
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.stats.entries, 0);
  assert.equal(bot.stats.shadowSignals.liftoff, 1);
  const rec = bot.journal.signals.find(s => s.setup === 'liftoff');
  assert.equal(rec.decision, 'shadow');
  assert.equal(rec.metrics.gainPct, 18);
});

test('slot stays free: a pop after a shadowed trend signal still opens', async () => {
  const { bot } = rig({ trendShadow: 1 });
  await bot.start();
  await bot.onSignal(view({ price: 1.00 }), { setup: 'trend', strength: 5, metrics: {} });
  assert.equal(bot.positions.length, 0);
  await bot.onSignal(view({ address: 'MINT2', price: 1.00 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(bot.positions.length, 1, 'pop must take the (untouched) slot');
  assert.equal(bot.positions[0].setup, 'pop');
  assert.equal(bot.stats.entries, 1);
  assert.equal(bot.journal.signals.find(s => s.mint === 'MINT2').decision, 'taken');
});

test('knobs off: trend and liftoff signals trade exactly as today (taken in a healthy rig)', async () => {
  const t = rig();
  await t.bot.start();
  await t.bot.onSignal(view({ price: 1.00 }), { setup: 'trend', strength: 5, metrics: {} });
  assert.equal(t.bot.positions.length, 1, 'unshadowed trend should be bought');
  assert.equal(t.bot.journal.signals.find(s => s.setup === 'trend').decision, 'taken');
  assert.equal(t.bot.stats.shadowSignals.trend, undefined);

  const l = rig();
  await l.bot.start();
  await l.bot.onSignal(view({ price: 1.00 }), { setup: 'liftoff', strength: 1, metrics: {} });
  assert.equal(l.bot.positions.length, 1, 'unshadowed liftoff should be bought');
  assert.equal(l.bot.journal.signals.find(s => s.setup === 'liftoff').decision, 'taken');
});

test('shadowed signal reaches the outcome tracker and is scored like any other signal', async () => {
  const { bot, clock } = rig({ trendShadow: 1 });
  await bot.start();
  await bot.onSignal(view({ price: 1.00 }), { setup: 'trend', strength: 5, metrics: {} });
  const rec = bot.journal.signals.find(s => s.setup === 'trend');
  assert.ok(bot.journal.pending.has(rec.id), 'shadow signal must be registered for outcome tracking');
  clock.t += 61 * 60000; // past the +60m checkpoint
  bot.journal.observe(view({ price: 1.30 }));
  assert.equal(rec.out.done, true, 'outcome must finalize');
  assert.equal(rec.out.decision, 'shadow');
  assert.ok(Math.abs(rec.out.r60 - 0.3) < 1e-9, `r60 ${rec.out.r60}`);
  assert.ok(Math.abs(rec.out.r15 - 0.3) < 1e-9, `r15 ${rec.out.r15}`);
  const rep = bot.journal.report();
  assert.equal(rep.bySetup['trend/shadow'].n, 1, 'report must group shadow outcomes by setup/decision');
  assert.ok(Math.abs(rep.bySetup['trend/shadow'].avgR15 - 0.3) < 1e-9);
});
