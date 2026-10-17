// Scan evaluation stamps (user order 2026-10-16, RECORD-ONLY instrumentation):
// the detectors were pure and silent, so scan-ledger sessions carried empty
// decisions/setups for everything that never fired (5,000 sessions, 11
// signaled — and a 42x runner's record showed nothing at all). These tests
// pin: (a) an evaluated-and-failed session stamps the failing
// {metric, value, threshold} triples per setup, (b) stamping is inert — a
// passing evaluation still signals identically through the untouched
// detect* wrappers, (c) a session whose views folded but was never
// poll-evaluated records evaluated:false + why, (d) SCAN_STAMPS=0 makes
// session records exactly what they were before stamps shipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { buildScanCard } from '../src/scanLab.js';
import { detect, detectChurn, detectLiftoff, judgeScan, betterScanVerdict, closestCall } from '../src/detect.js';
import { testCfg, view, sample } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const MIN = 60000;

function rig(cfgOver = {}) {
  const cfg = testCfg({ ...cfgOver });
  const clock = { t: T0 };
  const exec = { solBalance: async () => 1 };
  const bot = new Bot(cfg, { now: () => clock.t, exec });
  return { cfg, clock, bot };
}

// A textbook pop shape under the shipped code defaults: +50% inside the
// window, at the high, real buy flow, real volume.
const POP_SAMPLES = [sample(T0, 1.0), sample(T0 + 30000, 1.2), sample(T0 + 60000, 1.5)];
const popView = (o = {}) => view({ price: 1.5, volM5: 50000, volH1: 60000, buysM5: 30, sellsM5: 10, ...o });

test('scanstamps: shipped default is on', () => {
  assert.equal(testCfg({}).scanStamps, 1);
});

test('scanstamps: (a) a failing pop evaluation stamps the decisive triples', () => {
  const cfg = testCfg({});
  const samples = [sample(T0, 1.0), sample(T0 + 30000, 1.05), sample(T0 + 60000, 1.10)];
  const v = view({ price: 1.10, volM5: 5000, volH1: 60000, buysM5: 30, sellsM5: 10 });
  const vs = judgeScan(v, samples, cfg, T0 + 60000);
  assert.equal(vs.pop.evaluated, true);
  assert.equal(vs.pop.passed, false);
  assert.equal(vs.pop.stage, 'legs');
  // gain +10% vs the +35% floor, and 5m volume $5,000 vs the $25,000 floor —
  // everything else on the card passed, so exactly these two triples fail.
  assert.deepEqual(vs.pop.fails, [
    { metric: 'gainPct', value: 10, threshold: 35, op: '>=' },
    { metric: 'volM5', value: 5000, threshold: 25000, op: '>=' },
  ]);
  assert.match(vs.pop.failReason, /window gain/);
  assert.equal(vs.pop.margin, -0.8); // the vol leg is the bottleneck: (5000-25000)/25000
  assert.equal('signal' in vs.pop, false, 'stamps never carry the candidate signal');
});

test('scanstamps: (a) the eligibility door stamps on every setup that reaches it', () => {
  const cfg = testCfg({}); // code defaults: MIN_MC 10000
  const vs = judgeScan(view({ mc: 5000 }), POP_SAMPLES, cfg, T0 + 60000);
  for (const setup of ['pop', 'churn', 'liftoff']) {
    assert.equal(vs[setup].evaluated, true, setup);
    assert.equal(vs[setup].stage, 'eligible', setup);
    assert.deepEqual(vs[setup].fails[0], { metric: 'mc', value: 5000, threshold: 10000, op: '>=' }, setup);
  }
  // trend is disabled at the shipped default — its verdict says so instead
  assert.equal(vs.trend.evaluated, false);
  assert.match(vs.trend.reason, /TREND_ENABLED=0/);
});

test('scanstamps: (a) an enabled trend stamps its own failing numbers', () => {
  const cfg = testCfg({ trendEnabled: 1 });
  const samples = [sample(T0, 1.0), sample(T0 + 30000, 1.0), sample(T0 + 60000, 1.0)];
  const v = view({ price: 1.0, chgH1: 10, chgM5: 1, volH1: 50000, volM5: 50000 });
  const vs = judgeScan(v, samples, cfg, T0 + 60000);
  assert.equal(vs.trend.evaluated, true);
  assert.equal(vs.trend.passed, false);
  const byMetric = Object.fromEntries(vs.trend.fails.map(f => [f.metric, f]));
  assert.deepEqual(byMetric.chgH1, { metric: 'chgH1', value: 10, threshold: 25, op: '>=' });
  assert.deepEqual(byMetric.volH1, { metric: 'volH1', value: 50000, threshold: 100000, op: '>=' });
});

test('scanstamps: (b) a passing pop still signals identically — stamping is inert', () => {
  const cfg = testCfg({});
  const v = popView();
  const sig = detect(v, POP_SAMPLES, cfg, T0 + 60000);
  assert.deepEqual(sig, {
    setup: 'pop', strength: 50,
    metrics: { gainPct: 50, drawFromPeak: 0, buyRatioM5: 0.75, volH1: 60000, volM5: 50000 },
  });
  const vs = judgeScan(v, POP_SAMPLES, cfg, T0 + 60000);
  assert.equal(vs.pop.passed, true);
  assert.deepEqual(vs.pop.fails, []);
  assert.equal(vs.pop.failReason, null);
});

test('scanstamps: (b) churn and liftoff fires match their judges verdict-for-verdict', () => {
  const cfg = testCfg({});
  // Churn shape: -50% peak→low, basing 15m, sustained hot two-way flow.
  const churnSamples = [
    sample(T0, 2.0, { buysM5: 80, sellsM5: 70, volM5: 3000 }),
    sample(T0 + 5 * MIN, 1.4, { buysM5: 80, sellsM5: 70, volM5: 3000 }),
    sample(T0 + 15 * MIN, 1.0, { buysM5: 80, sellsM5: 70, volM5: 3000 }),
    sample(T0 + 20 * MIN, 1.02, { buysM5: 80, sellsM5: 70, volM5: 3000 }),
    sample(T0 + 25 * MIN, 1.01, { buysM5: 75, sellsM5: 75, volM5: 3000 }),
    sample(T0 + 30 * MIN, 1.02, { buysM5: 75, sellsM5: 75, volM5: 3000 }),
  ];
  const churnView = view({ price: 1.02, buysM5: 75, sellsM5: 75, volM5: 3000, chgH1: -20 });
  assert.equal(detect(churnView, churnSamples, cfg, T0 + 30 * MIN), null, 'pop/trend pass it over');
  const churnSig = detectChurn(churnView, churnSamples, cfg, T0 + 30 * MIN);
  assert.equal(churnSig.setup, 'churn');
  assert.equal(judgeScan(churnView, churnSamples, cfg, T0 + 30 * MIN).churn.passed, true);

  // Liftoff shape: a tight 35m base, then a stepped 10m climb with rising
  // chunk lows and an activity pickup.
  const lo = [];
  for (let i = 0; i <= 11; i++) lo.push(sample(T0 + i * 3 * MIN, i % 2 ? 1.01 : 1.0, { buysM5: 20, sellsM5: 20, volM5: 4000 }));
  lo.push(
    sample(T0 + 36 * MIN, 1.04, { buysM5: 50, sellsM5: 40, volM5: 20000 }),
    sample(T0 + 39 * MIN, 1.08, { buysM5: 50, sellsM5: 40, volM5: 20000 }),
    sample(T0 + 42 * MIN, 1.14, { buysM5: 55, sellsM5: 35, volM5: 20000 }),
    sample(T0 + 45 * MIN, 1.20, { buysM5: 60, sellsM5: 30, volM5: 20000 }),
  );
  const loView = view({ price: 1.20, buysM5: 60, sellsM5: 30, volM5: 20000, volH1: 60000 });
  const loSig = detectLiftoff(loView, lo, cfg, T0 + 45 * MIN);
  assert.equal(loSig.setup, 'liftoff');
  assert.equal(judgeScan(loView, lo, cfg, T0 + 45 * MIN).liftoff.passed, true);

  // And where every judge fails, every wrapper returns null — no phantom fires.
  const deadSamples = [sample(T0, 1.0), sample(T0 + 30000, 0.99), sample(T0 + 60000, 0.98)];
  const deadView = view({ price: 0.98, volM5: 100, buysM5: 1, sellsM5: 9, chgH1: -5 });
  const dvs = judgeScan(deadView, deadSamples, cfg, T0 + 60000);
  assert.equal(detect(deadView, deadSamples, cfg, T0 + 60000), null);
  assert.equal(detectChurn(deadView, deadSamples, cfg, T0 + 60000), null);
  assert.equal(detectLiftoff(deadView, deadSamples, cfg, T0 + 60000), null);
  assert.ok(Object.values(dvs).every(vd => !vd.passed));
});

test('scanstamps: (a/c) a folded-but-never-evaluated session says so at finalize', () => {
  const { bot } = rig();
  bot._foldScan(view({ price: 1, mc: 100 }), T0);
  bot._foldScan(view({ price: 2, mc: 200 }), T0 + MIN);
  bot._scanSweep(T0 + MIN + 601_000);
  assert.equal(bot.journal.scanSessions.length, 1);
  const rec = bot.journal.scanSessions[0];
  assert.equal(rec.evaluated, false);
  assert.match(rec.evalWhy, /never poll-evaluated/);
  assert.equal(rec.evals, 0);
  assert.equal(rec.verdicts, undefined);
  assert.deepEqual(rec.decisions, [], 'the legacy fields are untouched');
  assert.deepEqual(rec.setups, []);
});

test('scanstamps: (c) a session folded while held names the held reason', () => {
  const { bot } = rig();
  bot._foldScan(view({ price: 1 }), T0);
  bot._noteScanHeld('MINT1');
  bot._scanSweep(T0 + 601_000);
  const rec = bot.journal.scanSessions[0];
  assert.equal(rec.evaluated, false);
  assert.match(rec.evalWhy, /held as an open position/);
});

test('scanstamps: (a) stamps ride the finalized record — best verdict wins, closest call named', () => {
  const { cfg, bot } = rig();
  const v = view({ price: 1.10, volM5: 5000, volH1: 60000, buysM5: 30, sellsM5: 10 });
  const samples = [sample(T0, 1.0), sample(T0 + 30000, 1.05), sample(T0 + 60000, 1.10)];
  bot._foldScan(v, T0);
  // first tick: the coin is under the mc door — an eligible-stage verdict
  bot._foldScanVerdicts('MINT1', judgeScan(view({ mc: 5000, price: 1.10, volM5: 5000 }), samples, cfg, T0 + 60000));
  // second tick: in band, judged on the legs — the legs verdict must WIN the
  // stamp even though its bottleneck margin is worse than the door's
  bot._foldScanVerdicts('MINT1', judgeScan(v, samples, cfg, T0 + 60000));
  bot._scanSweep(T0 + 601_000);
  const rec = bot.journal.scanSessions[0];
  assert.equal(rec.evals, 2);
  assert.equal(rec.verdicts.pop.stage, 'legs');
  assert.deepEqual(rec.verdicts.pop.fails.map(f => f.metric), ['gainPct', 'volM5']);
  assert.equal(rec.closest.setup, 'pop');
  assert.equal(rec.closest.passed, false);
  assert.equal(rec.evaluated, undefined, 'an evaluated session carries verdicts, not the never-evaluated stamp');
});

test('scanstamps: (d) SCAN_STAMPS=0 — records exactly as before stamps shipped', () => {
  const { cfg, bot } = rig({ scanStamps: 0 });
  const v = popView();
  bot._foldScan(v, T0);
  bot._foldScanVerdicts('MINT1', judgeScan(v, POP_SAMPLES, cfg, T0 + 60000)); // inert under the switch
  bot._noteScanHeld('MINT1');                                                  // inert too
  assert.equal(bot.scanFold.get('MINT1').verdicts, undefined);
  bot._scanSweep(T0 + 601_000);
  const rec = bot.journal.scanSessions[0];
  for (const k of ['verdicts', 'closest', 'evals', 'evaluated', 'evalWhy']) {
    assert.equal(k in rec, false, `${k} must not exist with stamps off`);
  }
  assert.deepEqual(rec.decisions, []);
  assert.deepEqual(rec.setups, []);
});

test('scanstamps: the card aggregates a failing-condition histogram from stamped sessions', () => {
  const sessions = [
    { id: 'a-1', mint: 'A', samples: 9, runFromFirst: 40, signaled: false, verdicts: {
      pop: { evaluated: true, passed: false, fails: [{ metric: 'gainPct' }, { metric: 'volM5' }] },
      churn: { evaluated: true, passed: false, fails: [{ metric: 'dropPct' }] },
    } },
    { id: 'b-2', mint: 'B', samples: 9, runFromFirst: 3, signaled: false, verdicts: {
      pop: { evaluated: true, passed: false, fails: [{ metric: 'gainPct' }] },
      liftoff: { evaluated: true, passed: true, fails: [] }, // fired its side, dropped downstream
    } },
    { id: 'c-3', mint: 'C', samples: 9, runFromFirst: 2, signaled: false, evaluated: false },
    { id: 'd-4', mint: 'D', samples: 9, runFromFirst: 2, signaled: false }, // pre-stamps record
  ];
  const card = buildScanCard(sessions, () => null, T0);
  assert.equal(card.totals.evaluatedSessions, 2);
  assert.equal(card.totals.neverEvaluated, 1);
  assert.equal(card.totals.passedNotSignaled, 1);
  assert.deepEqual(card.totals.failHistogram, { pop: { gainPct: 2, volM5: 1 }, churn: { dropPct: 1 } });
});

test('scanstamps: the $DODO shape — door first, then the volume leg, liftoff never old enough', () => {
  // Live values the night $DODO ran 42x under watch with an empty record.
  const cfg = testCfg({
    minMc: 5000, minLiqUsd: 7500, minLiqToMc: 0.015,
    popGainPct: 25, popMaxGainPct: 75, popMinVolM5: 12500, popMinBuysM5: 10,
    maxDrawFromPeak: 0.225, popMaxBelowHigh: 0.45, popMaxDropH6: 60,
  });
  // First sight: mc $4,847 — under the $5,000 door before any detector leg.
  const first = judgeScan(view({ price: 1, mc: 4847, liq: 8000 }), [], cfg, T0);
  assert.equal(first.pop.stage, 'eligible');
  assert.deepEqual(first.pop.fails[0], { metric: 'mc', value: 4847, threshold: 5000, op: '>=' });
  // Mid-run (16 minutes in, like the real session): in band and vertical —
  // window gain +200% blows the +75% chase cap, and the session's best 5m
  // volume ($7,104) never reaches the floor.
  const samples = [];
  for (let i = 0; i <= 15; i++) samples.push(sample(T0 + i * MIN, 1));
  samples.push(sample(T0 + 16 * MIN, 3));
  const runView = view({ price: 3, mc: 205789, liq: 30000, volM5: 7104, volH1: 38649, buysM5: 60, sellsM5: 30, chgH1: 1058, chgH6: 1058 });
  const run = judgeScan(runView, samples, cfg, T0 + 16 * MIN);
  assert.equal(run.pop.stage, 'legs');
  assert.deepEqual(run.pop.fails, [
    { metric: 'gainPct', value: 200, threshold: 75, op: '<=' },
    { metric: 'volM5', value: 7104, threshold: 12500, op: '>=' },
  ]);
  // The session stamp keeps the LEGS verdict over the door verdict.
  assert.equal(betterScanVerdict(first.pop, run.pop), run.pop);
  // Liftoff structurally could not judge it: 1 minute of history vs the
  // 20-minute minimum — the verdict says exactly that.
  assert.equal(run.liftoff.stage, 'structure');
  assert.match(run.liftoff.failReason, /20m needed/);
  // The closest call across the run tick is pop (legs stage outranks the rest).
  const cc = closestCall(run);
  assert.equal(cc.setup, 'pop');
  assert.equal(cc.passed, false);
});
