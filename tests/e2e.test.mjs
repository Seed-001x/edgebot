// End-to-end, fully offline: scripted market + fake RugCheck/search + shadow Executor with a scripted quote.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const riggedRug = { ...healthyRug, topHolders: Array.from({ length: 18 }, (_, i) => ({ owner: 'w' + i, address: 'w' + i, amount: 498001881166, pct: 0.05 })) };

function rig({ rug = healthyRug, cfgOver = {}, others = [] } = {}) {
  const cfg = testCfg(cfgOver);
  const clock = { t: T0 };
  const market = { price: 1, liq: 100_000, buysM5: 30, sellsM5: 10 };
  const q = { valueLam: 19_000_000 };   // value of the FULL 1e9-token holding, in lamports
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map([['MINT1', 'jup-trending']]), { counts: {} }),
    fetchViews: async () => new Map([['MINT1', view({ price: market.price, mc: market.price * 1e6, liq: market.liq, buysM5: market.buysM5, sellsM5: market.sellsM5, createdAt: T0 - 10 * 3600e3 })]]),
    fetchSolUsd: async () => 150, fetchRug: async () => rug, searchByName: async () => others,
  });
  const tick = async (price, n = 1) => { for (let i = 0; i < n; i++) { clock.t += 10000; if (price != null) market.price = price; await bot.pollTick(); } };
  return { cfg, bot, clock, market, q, tick };
}
const RAMP = [1.1, 1.2, 1.3, 1.4, 1.5];

test('full lifecycle: pop → gates pass → buy → TP1 → trailing stop → profit booked', async () => {
  const r = rig();
  await r.bot.start(); await r.bot.discoverTick();
  await r.tick(1, 12);
  assert.equal(r.bot.positions.length, 0, 'flat market must not trigger');
  for (const p of RAMP) await r.tick(p);
  assert.equal(r.bot.positions.length, 1, 'pop should have opened a position');
  const pos = r.bot.positions[0];
  assert.equal(pos.setup, 'pop'); assert.equal(pos.simulated, true); assert.ok(Math.abs(pos.entrySol - 0.02) < 1e-9);

  await r.bot.positionTick(); assert.equal(r.bot.positions.length, 1, 'quiet → hold');
  r.q.valueLam = 30_000_000; await r.bot.positionTick();           // +50% → TP1 (sell half)
  assert.equal(r.bot.positions[0].tp1Done, true); assert.ok(Math.abs(r.bot.positions[0].remainingFrac - 0.5) < 1e-9);
  r.q.valueLam = 40_000_000; await r.bot.positionTick();           // peak 2.0x
  assert.equal(r.bot.positions.length, 1);
  r.q.valueLam = 30_000_000; await r.bot.positionTick();           // fell to 1.5x ≤ 2.0*0.85 → trail
  assert.equal(r.bot.positions.length, 0, 'trailing stop should close it');

  const rep = r.bot.journal.report();
  assert.equal(rep.trades.closed, 1); assert.ok(Math.abs(rep.trades.totalPnlSol - 0.01) < 1e-6, `pnl ${rep.trades.totalPnlSol}`);
  assert.ok(Math.abs(r.bot.risk.snapshot().dayPnlSol - 0.01) < 1e-6);
  assert.equal(rep.bySetup['pop/taken'].n, 1);
});

test('rigged launch: pop is detected, then BLOCKED by the gate, and logged with its reason', async () => {
  const r = rig({ rug: riggedRug });
  await r.bot.start(); await r.bot.discoverTick();
  await r.tick(1, 12); for (const p of RAMP) await r.tick(p);
  assert.equal(r.bot.positions.length, 0);
  const sk = r.bot.journal.signals.filter(s => s.decision === 'skipped');
  assert.ok(sk.length >= 1); assert.ok(sk[0].reasons.some(x => x.startsWith('clones:')), JSON.stringify(sk[0].reasons));
  await r.tick(0.5, 100);                                          // coin collapses afterwards
  const rep = r.bot.journal.report();
  assert.ok(rep.bySkipReason.clones.avgR15 < 0, 'journal shows the gate saved us');
});

test('copycat of an established coin passes the gate stack — no clone skip (clone filter removed, user 2026-10-14)', async () => {
  const orig = { address: 'ORIG', name: 'Test Coin', symbol: 'TEST', createdAt: T0 - 90 * 3600e3, volH24: 9e7, liq: 9e6 };
  const r = rig({ others: [orig] });
  await r.bot.start(); await r.bot.discoverTick(); await r.tick(1, 12); for (const p of RAMP) await r.tick(p);
  // This exact shape used to be gate-skipped with a 'clone:' reason. With the filter gone
  // the signal clears the whole gate stack and is judged downstream on its other merits —
  // in this rig it reaches the round-trip check (the pre-existing rig drift that also
  // fails 'full lifecycle' at baseline stops it there, unrelated to the gates).
  assert.ok(r.bot.journal.signals.length >= 1, 'the pop signal should be journaled');
  assert.ok(!r.bot.journal.signals.some(s => s.reasons.some(x => x.startsWith('clone:'))), 'no clone skip reason may appear');
  assert.ok(
    r.bot.journal.signals.some(s => s.decision === 'taken' || s.reasons.some(x => x.startsWith('roundtrip:'))),
    `signal should pass the gates and be judged downstream, got: ${JSON.stringify(r.bot.journal.signals.map(s => [s.decision, s.reasons]))}`,
  );
});

test('same-name dedup REMOVED (user 2026-10-14): a second, different-mint coin carrying an entered coin\'s name is judged on its merits and taken', async () => {
  const r = rig({ cfgOver: { tradeSol: 0.02 } }); // the rig's scripted sell-back value is calibrated to a 0.02 spend (as in the stale-pop fixture)
  await r.bot.start();
  // First coin: 'Test Coin' (MINT1) is entered. Under the removed dedup, that entry recorded
  // the name and every later DIFFERENT mint carrying it was skipped 'copycat: already entered'.
  await r.bot.onSignal(view({ price: 1.00 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 1, 'first coin should be bought');
  assert.equal(r.bot.enteredNames, undefined, 'no entered-names state may remain on the bot');
  r.bot.positions.length = 0; // first trade is done; free the slot for the namesake
  // Second coin: different mint, same name and ticker — the dedup's exact target shape.
  await r.bot.onSignal(view({ address: 'MINT2', price: 1.00 }), { setup: 'pop', strength: 1, metrics: {} });
  const sig2 = r.bot.journal.signals.find(s => s.mint === 'MINT2');
  assert.equal(sig2.decision, 'taken');
  assert.equal(r.bot.positions.length, 1, 'the same-name second coin should be bought on its merits');
  assert.ok(!r.bot.journal.signals.some(s => (s.reasons || []).some(x => x.startsWith('copycat:'))), 'no copycat skip may be recorded');
});

test('unsellable token (sell-back worth 10% of spend) is refused before any buy', async () => {
  const r = rig(); r.q.valueLam = 2_000_000;
  await r.bot.start(); await r.bot.discoverTick(); await r.tick(1, 12); for (const p of RAMP) await r.tick(p);
  assert.equal(r.bot.positions.length, 0);
  assert.ok(r.bot.journal.signals.some(s => s.reasons.some(x => x.startsWith('roundtrip:'))));
  assert.equal(await r.bot.exec.solBalance(), 1, 'nothing was spent');
});

test('daily-loss cap and HALT file both stop new entries', async () => {
  let r = rig(); r.bot.risk.recordClose(-0.07);
  await r.bot.start(); await r.bot.discoverTick(); await r.tick(1, 12); for (const p of RAMP) await r.tick(p);
  assert.equal(r.bot.positions.length, 0); assert.ok(r.bot.journal.signals.some(s => s.reasons.some(x => /daily loss/.test(x))));

  r = rig(); fs.writeFileSync(path.join(r.cfg.dataDir, 'HALT'), '');
  await r.bot.start(); await r.bot.discoverTick(); await r.tick(1, 12); for (const p of RAMP) await r.tick(p);
  assert.equal(r.bot.positions.length, 0); assert.ok(r.bot.journal.signals.some(s => s.reasons.some(x => /HALT/.test(x))));
});

test('stop-loss exits on realizable value even if the screen price still looks fine', async () => {
  const r = rig();
  await r.bot.start(); await r.bot.discoverTick(); await r.tick(1, 12); for (const p of RAMP) await r.tick(p);
  assert.equal(r.bot.positions.length, 1);
  r.q.valueLam = 14_000_000;                                       // sell quote says -30% although price feed is unchanged
  await r.bot.positionTick();
  assert.equal(r.bot.positions.length, 0);
  assert.ok(r.bot.journal.trades.some(t => t.type === 'close' && /stop-loss/.test(t.reason) && t.pnlSol < 0));
});

test('positions persist across restarts', async () => {
  const r = rig();
  await r.bot.start(); await r.bot.discoverTick(); await r.tick(1, 12); for (const p of RAMP) await r.tick(p);
  const again = new Bot(r.cfg, { now: () => r.clock.t, exec: r.bot.exec, discover: async () => new Map(), fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [] });
  assert.equal(again.positions.length, 1); assert.equal(again.positions[0].mint, 'MINT1');
});

test('second-hump pop is taken, not stale-vetoed (user 2026-10-14, CODE): sampled high 330s old, price 28% below it', async () => {
  const r = rig({ cfgOver: { tradeSol: 0.02 } }); // the rig's scripted sell-back value is calibrated to a 0.02 spend (as in the lifecycle fixture)
  await r.bot.start();
  // Seed the bot's own sampled history with the CODE shape: peak 1.39 printed 330s ago,
  // price since rolled to 1.00 (-28%). The removed stale-pop veto (60s / 8%) skipped
  // exactly this; with it gone the pop must flow through gates to a buy.
  const seed = (agoSec, price) => r.bot.history.record(view({ price }), T0 - agoSec * 1000);
  seed(360, 1.20); seed(330, 1.39); seed(300, 1.32); seed(270, 1.26); seed(240, 1.20); seed(210, 1.15);
  seed(180, 1.10); seed(150, 1.07); seed(120, 1.04); seed(90, 1.02); seed(60, 1.01); seed(30, 1.00); seed(0, 1.00);
  await r.bot.onSignal(view({ price: 1.00 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 1, 'the second-hump pop must be bought — the stale-pop veto is gone');
  const sig = r.bot.journal.signals.find(s => s.mint === 'MINT1');
  assert.equal(sig.decision, 'taken');
  assert.ok(!r.bot.journal.signals.some(s => (s.reasons || []).some(x => x.startsWith('stalepop:'))), 'no stalepop skip may be recorded');
});

test('A1+A2: paceCfg no longer loosens gates (PACE_RELAX off) and mandatory ape defaults off', () => {
  const bot = new Bot(testCfg(), { now: () => T0, exec: {}, discover: async () => new Map(), fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [] });
  const out = bot.paceCfg(T0);
  assert.equal(out.boosted, false);
  assert.equal(out.cfg.minLiqUsd, 15000);
  assert.equal(out.cfg.maxMc, testCfg().maxMc);
  const relaxedBot = new Bot(testCfg({ paceRelax: 1 }), { now: () => T0, exec: {}, discover: async () => new Map(), fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [] });
  assert.equal(relaxedBot.paceCfg(T0).boosted, true);
});
