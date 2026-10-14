// Churn detector (user 2026-10-14): a dumped coin basing at its lows with a trade
// count that refuses to die. Fixtures are the two shapes from the design discussion:
// Vwhale (real accumulation at support — MUST fire) and Urara-style wash churn
// (sustained count, dust-sized trades — MUST NOT fire), plus a still-falling knife.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, detectChurn } from '../src/detect.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view, sample } from './helpers.mjs';

const cfg = testCfg();
const NOW = 1_000_000_000_000;

// Peak 2.0 at −50m, straight decline to 0.94 (−53%) at −25m, then 25 minutes of
// basing prints hugging the low. Flow values are parameters so each test can break
// exactly one condition.
function basingSeries({ buys = 92, sells = 88, volPerTx = 25 } = {}) {
  const out = [];
  const flow = { buysM5: buys, sellsM5: sells, volM5: (buys + sells) * volPerTx };
  for (let t = NOW - 50 * 60000; t <= NOW - 25 * 60000; t += 10000) {
    const f = (t - (NOW - 50 * 60000)) / (25 * 60000);
    out.push(sample(t, 2.0 - (2.0 - 0.94) * f, flow));
  }
  let i = 0;
  for (let t = NOW - 25 * 60000 + 10000; t <= NOW; t += 10000, i++) {
    out.push(sample(t, i % 3 === 0 ? 0.95 : 0.99, flow));
  }
  return out;
}

test('churn: Vwhale shape fires — dumped 53%, basing 25m, 180 tx/5m, share 0.51, $25 avg trade', () => {
  const s = basingSeries();
  // the classic detectors see nothing here (no pop, trend paused) — churn is the catch
  assert.equal(detect(view({ price: 0.98 }), s, cfg, NOW), null);
  const r = detectChurn(view({ price: 0.98 }), s, cfg, NOW);
  assert.ok(r, 'expected a churn signal');
  assert.equal(r.setup, 'churn');
  assert.ok(Math.abs(r.metrics.dropPct - 53) < 0.6, `dropPct ${r.metrics.dropPct}`);
  assert.equal(r.metrics.txM5, 180);
  assert.ok(Math.abs(r.metrics.buyShare - 0.51) < 0.01);
  assert.equal(r.label, 'churn: -53% off peak, basing 25m, 180 tx/5m, share 0.51');
});

test('churn: wash shape does NOT fire — sustained count but dust average trade size (Urara)', () => {
  // 1950 tx/5m at $1.20 a trade: the count is real, the money isn't. Share (0.49)
  // passes, drop/base pass — the avg-USD floor is the only thing standing, by design
  // (it sits above the botflow $6 / dust $1.5 hard-gate floors).
  const s = basingSeries({ buys: 950, sells: 1000, volPerTx: 1.2 });
  assert.equal(detectChurn(view({ price: 0.98 }), s, cfg, NOW), null);
});

test('churn: still falling does NOT fire — new lows inside the stable window', () => {
  const out = [];
  const flow = { buysM5: 92, sellsM5: 88, volM5: 180 * 25 };
  for (let t = NOW - 30 * 60000; t <= NOW; t += 10000) {
    const f = (t - (NOW - 30 * 60000)) / (30 * 60000);
    out.push(sample(t, 2.0 - (2.0 - 0.90) * f, flow)); // the last print IS the latest low
  }
  assert.equal(detectChurn(view({ price: 0.90 }), out, cfg, NOW), null);
});

test('churn: an exit stampede does NOT fire — buy share below the 0.40 two-way floor', () => {
  const s = basingSeries({ buys: 50, sells: 130, volPerTx: 25 }); // share 0.28
  assert.equal(detectChurn(view({ price: 0.98 }), s, cfg, NOW), null);
});

test('churn: a quiet base does NOT fire — trade count died at the lows', () => {
  const s = basingSeries({ buys: 20, sells: 18, volPerTx: 25 }); // 38 tx/5m < 120
  assert.equal(detectChurn(view({ price: 0.98 }), s, cfg, NOW), null);
});

test('churn: disabled by CHURN_ENABLED=0', () => {
  assert.equal(detectChurn(view({ price: 0.98 }), basingSeries(), testCfg({ churnEnabled: false }), NOW), null);
});

// ---- basing watch: a dumped coin stays watchlist-pinned past the normal TTL ----
const T0 = 1_000_000_000_000;
function pinRig() {
  const cfg = testCfg();
  const clock = { t: T0 };
  const market = { price: 2 };
  let discoverOn = true;
  const exec = new Executor(cfg, { quote: async (input) => (input === SOL_MINT ? { outAmount: '1000000000', priceImpactPct: '0.01' } : { outAmount: '0' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(discoverOn ? new Map([['MINT1', 'test']]) : new Map(), { counts: {} }),
    fetchViews: async () => new Map([['MINT1', view({ price: market.price, mc: market.price * 1e6, createdAt: T0 - 10 * 3600e3 })]]),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  return { bot, clock, market, setDiscover: (on) => { discoverOn = on; } };
}

test('basing watch: dumped coin is pinned, survives the TTL prune, and is released when the pin expires', async () => {
  const r = pinRig();
  await r.bot.start();
  await r.bot.discoverTick();
  assert.ok(r.bot.watch.has('MINT1'));
  const tick = async (price) => { r.clock.t += 10000; r.market.price = price; await r.bot.pollTick(); };
  await tick(2); await tick(2); await tick(2);       // sampled peak at 2.0
  await tick(0.9); await tick(0.9); await tick(0.9); // −55% from the peak → pinned
  assert.equal(r.bot.churnPinned('MINT1', r.clock.t), true);
  r.setDiscover(false);                              // discovery stops re-adding it
  r.clock.t += 30 * 60000;                           // past WATCH_TTL_MIN (20m)
  await r.bot.discoverTick();
  assert.ok(r.bot.watch.has('MINT1'), 'pin must hold the mint past the normal TTL');
  r.clock.t += 3 * 3600000;                          // past CHURN_WATCH_H (3h)
  await r.bot.discoverTick();
  assert.equal(r.bot.watch.has('MINT1'), false, 'expired pin releases the mint to the normal prune');
});

test('basing watch: a coin that never dumped is pruned on the normal TTL', async () => {
  const r = pinRig();
  await r.bot.start();
  await r.bot.discoverTick();
  const tick = async (price) => { r.clock.t += 10000; r.market.price = price; await r.bot.pollTick(); };
  await tick(2); await tick(2); await tick(1.9); // −5%: no pin
  assert.equal(r.bot.churnPinned('MINT1', r.clock.t), false);
  r.setDiscover(false);
  r.clock.t += 30 * 60000;
  await r.bot.discoverTick();
  assert.equal(r.bot.watch.has('MINT1'), false);
});
