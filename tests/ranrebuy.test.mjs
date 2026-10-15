// Ran-rebuy block (user 2026-10-15, "for tonight"): a mint the bot already
// traded whose coin printed >= 5x that trade's entry price at ANY point since
// the entry — including after the bot sold — cannot be re-bought until 3h
// after that trade's close. Tonight's exhibit is BOOT (ridden 2026-10-14,
// re-bought the next night after the run). These tests pin the rule exactly:
// the most-recent-close anchor, the 3h window (expiry re-allows, and no
// candle fetch is spent outside it), the 5x line (exactly 5.0x blocks), the
// journal fold that makes pre-deploy trades count, the partial-coverage
// semantics (a >= 5x print in a partial window still blocks; a sub-5x partial
// read is inconclusive and fails open), the 5-min measurement cache (failures
// never cached), the fail-open contract, and the bot wiring (journal, stats,
// metrics, knob).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ranRebuyCheck, judgeRanPeak, foldLastTrades, RAN_REBUY_TTL_MS } from '../src/gate.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const MIN = 60000, H = 3600000;

// Entry price 0.5 USD keeps the multiples exact in binary floating point
// (2.5 / 0.5 === 5, 3.1 / 0.5 === 6.2 to the printed digit).
const ENTRY = 0.5;
const prior = (over = {}) => ({ mint: 'MINT1', id: 'p1', symbol: 'BOOT', entryTs: T0 - 2 * H, closeTs: T0 - 1 * H, entryPriceUsd: ENTRY, ...over });
// GT minute candle rows [tsSec, o, h, l, c, v], ascending.
const candle = (tsMs, high, close = high) => [Math.floor(tsMs / 1000), close, high, Math.min(close, high) * 0.99, close, 100];
const series = (entryTs, peakHigh, { startOffsetMin = -1, minutes = 130 } = {}) => {
  const out = [];
  for (let m = startOffsetMin; m < minutes; m++) {
    const ts = entryTs + m * MIN;
    out.push(candle(ts, m === 30 ? peakHigh : ENTRY * 1.1));
  }
  return out;
};
const impl = (candles, counter = null) => async () => { if (counter) counter.calls++; return candles; };
const run = (p, candles, over = {}) => ranRebuyCheck(p, { mult: 5, hours: 3, now: T0, candlesImpl: impl(candles), cache: new Map(), ...over });

test('ranrebuy: a >= 5x print since entry, close inside 3h — blocked with the ran reason', async () => {
  const r = await run(prior(), series(T0 - 2 * H, ENTRY * 6.2));
  assert.equal(r.pass, false);
  assert.match(r.reason, /^already ran 5x\+ since our entry \(peak 6\.2x\), rebuy blocked until \d{2}:\d{2} ET$/);
  assert.equal(r.blockedUntil, T0 - 1 * H + 3 * H, 'the wait ends 3h after the prior close');
  assert.equal(r.priorCloseTs, T0 - 1 * H);
  assert.ok(Math.abs(r.peakRatio - 6.2) < 1e-9);
  assert.equal(r.lookupFailed, false);
});

test('ranrebuy: exactly 5.0x blocks (the line is >=)', async () => {
  const r = await run(prior(), series(T0 - 2 * H, ENTRY * 5));
  assert.equal(r.pass, false);
  assert.equal(r.peakRatio, 5);
});

test('ranrebuy: the run happened AFTER the exit — still blocked (peak is measured to now, not to the close)', async () => {
  // Flat while held (entry .. close = first 60 min), the 6.2x print lands an hour after the close.
  const cs = [];
  for (let m = -1; m < 130; m++) cs.push(candle(T0 - 2 * H + m * MIN, m === 120 ? ENTRY * 6.2 : ENTRY * 1.05));
  const r = await run(prior(), cs);
  assert.equal(r.pass, false);
  assert.ok(Math.abs(r.peakRatio - 6.2) < 1e-9);
});

test('ranrebuy: peak >= 5x but the close is older than 3h — passes, and no candle fetch is spent', async () => {
  const counter = { calls: 0 };
  const r = await ranRebuyCheck(prior({ closeTs: T0 - 3 * H - 1000 }), { mult: 5, hours: 3, now: T0, candlesImpl: impl(series(T0 - 2 * H, ENTRY * 9), counter), cache: new Map() });
  assert.equal(r.pass, true);
  assert.match(r.reason, /outside the 3h rebuy window/);
  assert.equal(counter.calls, 0, 'outside the window the measurement never happens');
});

test('ranrebuy: peak 3x within the window — passes clean (the coin never ran)', async () => {
  const r = await run(prior(), series(T0 - 2 * H, ENTRY * 3));
  assert.equal(r.pass, true);
  assert.equal(r.lookupFailed, false);
  assert.ok(Math.abs(r.peakRatio - 3) < 1e-9);
  assert.match(r.reason, /under the 5x ran line/);
});

test('ranrebuy: no prior trade — passes, no fetch', async () => {
  const counter = { calls: 0 };
  const r = await ranRebuyCheck(null, { mult: 5, hours: 3, now: T0, candlesImpl: impl([], counter), cache: new Map() });
  assert.equal(r.pass, true);
  assert.equal(counter.calls, 0);
});

test('ranrebuy: candle fetch throws — passes open and reports lookupFailed', async () => {
  const r = await ranRebuyCheck(prior(), { mult: 5, hours: 3, now: T0, candlesImpl: async () => { throw new Error('gt down'); }, cache: new Map() });
  assert.equal(r.pass, true);
  assert.equal(r.lookupFailed, true);
  assert.match(r.reason, /fail-open/);
  const r2 = await ranRebuyCheck(prior(), { mult: 5, hours: 3, now: T0, candlesImpl: async () => null, cache: new Map() });
  assert.equal(r2.pass, true); assert.equal(r2.lookupFailed, true, 'a null candle body is a failed lookup too');
});

test('ranrebuy: missing prior entry price / entry time — passes open + lookupFailed, no fetch', async () => {
  const counter = { calls: 0 };
  const r = await ranRebuyCheck(prior({ entryPriceUsd: null }), { mult: 5, hours: 3, now: T0, candlesImpl: impl([], counter), cache: new Map() });
  assert.equal(r.pass, true); assert.equal(r.lookupFailed, true); assert.match(r.reason, /entry price missing/);
  const r2 = await ranRebuyCheck(prior({ entryTs: null }), { mult: 5, hours: 3, now: T0, candlesImpl: impl([], counter), cache: new Map() });
  assert.equal(r2.pass, true); assert.equal(r2.lookupFailed, true); assert.match(r2.reason, /entry time missing/);
  assert.equal(counter.calls, 0);
});

test('ranrebuy: partial candle coverage — a >= 5x print still blocks; a sub-5x read is inconclusive (fail-open)', async () => {
  // The series starts 30 min AFTER the entry (pool migration): every candle
  // in it is still since-entry, so the 6.2x print is a true positive...
  const hot = await run(prior(), series(T0 - 2 * H, ENTRY * 6.2, { startOffsetMin: 30 }));
  assert.equal(hot.pass, false);
  // ...but a 3x peak in the same partial window cannot prove the coin never ran.
  const cold = await run(prior(), series(T0 - 2 * H, ENTRY * 3, { startOffsetMin: 30 }));
  assert.equal(cold.pass, true);
  assert.equal(cold.lookupFailed, true);
  assert.match(cold.reason, /partly measurable/);
});

test('ranrebuy: measurements cache per mint for 5 min — failures are never cached', async () => {
  const counter = { calls: 0 };
  const cache = new Map();
  const candles = series(T0 - 2 * H, ENTRY * 6.2);
  const a = await ranRebuyCheck(prior(), { mult: 5, hours: 3, now: T0, candlesImpl: impl(candles, counter), cache });
  assert.equal(a.pass, false);
  const b = await ranRebuyCheck(prior(), { mult: 5, hours: 3, now: T0 + 60_000, candlesImpl: impl(candles, counter), cache });
  assert.equal(b.pass, false);
  assert.equal(counter.calls, 1, 'the second verdict inside the window rides the cached measurement');
  const c = await ranRebuyCheck(prior(), { mult: 5, hours: 3, now: T0 + RAN_REBUY_TTL_MS + 1000, candlesImpl: impl(candles, counter), cache });
  assert.equal(c.pass, false);
  assert.equal(counter.calls, 2, 'after the TTL the peak is re-measured');
  let calls2 = 0;
  const flaky = async () => { calls2++; if (calls2 === 1) throw new Error('gt down'); return candles; };
  const cache2 = new Map();
  const f1 = await ranRebuyCheck(prior(), { mult: 5, hours: 3, now: T0, candlesImpl: flaky, cache: cache2 });
  assert.equal(f1.lookupFailed, true);
  const f2 = await ranRebuyCheck(prior(), { mult: 5, hours: 3, now: T0 + 1000, candlesImpl: flaky, cache: cache2 });
  assert.equal(f2.pass, false, 'the retry measures fresh and blocks');
  assert.equal(calls2, 2);
});

test('ranrebuy: judgeRanPeak is pure — entry-minute high counts, pre-entry minutes do not, coverage is honest', () => {
  const entryTs = T0 - 2 * H;
  const cs = [
    candle(entryTs - 5 * MIN, ENTRY * 50),  // before the entry — must not count
    candle(entryTs, ENTRY * 6.2),           // the entry minute itself
    candle(entryTs + 10 * MIN, ENTRY * 2),
  ];
  const j = judgeRanPeak(cs, entryTs, ENTRY);
  assert.ok(Math.abs(j.peakRatio - 6.2) < 1e-9, 'the 50x pre-entry candle is excluded');
  assert.equal(j.covered, true);
  const late = judgeRanPeak([candle(entryTs + 30 * MIN, ENTRY * 2)], entryTs, ENTRY);
  assert.equal(late.covered, false, 'a series starting after the entry minute is partial');
  assert.equal(judgeRanPeak([], entryTs, ENTRY), null);
  assert.equal(judgeRanPeak(cs, entryTs, null), null, 'no entry price — unmeasurable');
});

test('ranrebuy: foldLastTrades — most recent close anchors, price resolution order, pre-deploy pair found', () => {
  const trades = [
    { type: 'open', id: 'old', mint: 'M', symbol: 'OLD', ts: T0 - 30 * H, entryFillUsd: 0.25 },
    { type: 'close', id: 'old', mint: 'M', symbol: 'OLD', ts: T0 - 29 * H, entryFillUsd: 0.25 },
    // BOOT-shaped pair: the trade that closed before this gate existed.
    { type: 'open', id: 'boot', mint: 'M', symbol: 'BOOT', ts: T0 - 6 * H, entryFillUsd: 5e-7 },
    { type: 'close', id: 'boot', mint: 'M', symbol: 'BOOT', ts: T0 - 1 * H, entryFillUsd: 5e-7, pnlSol: 0.0323 },
    // A close whose open aged out of the tail: price falls back to the entry snapshot.
    { type: 'close', id: 'ghost', mint: 'G', symbol: 'GST', ts: T0 - 2 * H, entry: { price: 7e-6 } },
    { type: 'close', id: 'nots', mint: 'N', symbol: 'NTS' },
    { type: 'sell', id: 'boot', mint: 'M', ts: T0 - 30 * MIN },
  ];
  const last = foldLastTrades(trades);
  const m = last.get('M');
  assert.equal(m.id, 'boot', 'the most recent close anchors the mint, not the older trade');
  assert.equal(m.entryTs, T0 - 6 * H);
  assert.equal(m.closeTs, T0 - 1 * H);
  assert.equal(m.entryPriceUsd, 5e-7, 'the journaled entry fill (USD) is the price');
  const g = last.get('G');
  assert.equal(g.entryTs, null, 'no surviving open — entry time unknown');
  assert.equal(g.entryPriceUsd, 7e-6, 'snapshot price is the fallback');
  assert.equal(last.has('N'), false, 'a close with no timestamp anchors nothing');
});

test('ranrebuy: most-recent anchoring end to end — an older ran trade does not block when the newer trade stayed quiet', async () => {
  const trades = [
    { type: 'open', id: 'ran', mint: 'M', ts: T0 - 26 * H, entryFillUsd: ENTRY },
    { type: 'close', id: 'ran', mint: 'M', ts: T0 - 25 * H, entryFillUsd: ENTRY },
    { type: 'open', id: 'quiet', mint: 'M', ts: T0 - 2 * H, entryFillUsd: ENTRY },
    { type: 'close', id: 'quiet', mint: 'M', ts: T0 - 1 * H, entryFillUsd: ENTRY },
  ];
  const p = foldLastTrades(trades).get('M');
  let seenEntryTs = null;
  const r = await ranRebuyCheck(p, {
    mult: 5, hours: 3, now: T0, cache: new Map(),
    candlesImpl: async (mint, entryTs) => { seenEntryTs = entryTs; return series(entryTs, ENTRY * 3); },
  });
  assert.equal(r.pass, true, 'governed by the newer, quiet trade');
  assert.equal(seenEntryTs, T0 - 2 * H, 'the peak is measured from the NEWER entry');
});

// ---------------------------------------------------------------- bot wiring
const BT0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

// A BOOT-shaped journal pair written into the data dir BEFORE the Bot is
// constructed: the boot fold must find it (this is the pre-deploy-trade case).
function seedBootJournal(dir) {
  const rows = [
    { type: 'open', id: 'boot1', mint: 'MINT1', symbol: 'BOOT', setup: 'pop', entrySol: 0.05, ts: BT0 - 5 * H, entryFillSol: 3.33e-9, entryFillUsd: 5e-7 },
    { type: 'close', id: 'boot1', mint: 'MINT1', symbol: 'BOOT', setup: 'pop', entrySol: 0.05, pnlSol: 0.0323, ts: BT0 - 1 * H, entryFillUsd: 5e-7 },
  ];
  fs.writeFileSync(path.join(dir, 'trades.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function rig({ cfgOver = {}, candlesImpl = null, seed = false } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver });
  if (seed) seedBootJournal(cfg.dataDir);
  const clock = { t: BT0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const rrCache = new Map();
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug,
    ranRebuyCheck: (prior, o) => ranRebuyCheck(prior, { ...o, candlesImpl, cache: rrCache }),
  });
  return { cfg, bot, clock };
}
// Candles for the seeded BOOT trade, at BOOT's price scale: the series is
// built at the unit-test scale (entry 0.5, peak 3.1) and shifted down by 1e6,
// giving entry 5e-7 USD with a 6.2x print 30 min after the entry.
const bootCandles = (mint, entryTs) => series(entryTs, ENTRY * 6.2).map(c => [c[0], c[1] / 1e6, c[2] / 1e6, c[3] / 1e6, c[4] / 1e6, c[5]]);

test('ranrebuy bot: a re-run of a coin we already rode is skipped at the gate (prior rebuilt from the journal at boot)', async () => {
  const { bot } = rig({ seed: true, candlesImpl: async (mint, entryTs) => bootCandles(mint, entryTs) });
  await bot.start();
  const entriesAtBoot = bot.stats.entries; // 1: stats mirror the seeded journal's historical open
  await bot.onSignal(view({ symbol: 'BOOT' }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(bot.positions.length, 0, 'no position opens');
  assert.equal(bot.stats.entries, entriesAtBoot, 'the blocked signal added no entry');
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec, 'skip journaled');
  assert.ok(rec.reasons[0].startsWith('ranRebuy: already ran 5x+ since our entry (peak 6.2x)'), JSON.stringify(rec.reasons));
  assert.equal(rec.gates.ranRebuy.pass, false);
  assert.ok(Math.abs(rec.gates.ranRebuy.peakRatio - 6.2) < 1e-6);
  assert.equal(rec.gates.ranRebuy.blockedUntil, BT0 - 1 * H + 3 * H);
  assert.deepEqual(rec.metrics.ranRebuy, { peakRatio: rec.gates.ranRebuy.peakRatio, priorCloseTs: BT0 - 1 * H, blockedUntil: BT0 - 1 * H + 3 * H });
  assert.equal(bot.stats.ranRebuy.blocked, 1);
  assert.equal(bot.stats.ranRebuy.lookupFailed, 0);
});

test('ranrebuy bot: a failed peak lookup passes the candidate open, counts once, and the shadow verdict carries it', async () => {
  const { cfg, bot } = rig({ seed: true, candlesImpl: async () => { throw new Error('gt down'); } });
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(BT0)); // stop the pipeline at the risk layer, freeze1b-style
  await bot.start();
  await bot.onSignal(view({ symbol: 'BOOT' }), { setup: 'pop', strength: 1, metrics: {} });
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec, 'skip journaled (by risk, not by the ran-rebuy gate)');
  assert.deepEqual(rec.reasons, ['risk: HALT file present'], 'the failed lookup did not block');
  assert.equal(bot.stats.ranRebuy.lookupFailed, 1, 'only the live evaluation counts');
  assert.equal(bot.stats.ranRebuy.blocked, 0);
  assert.ok(rec.shadowGates && rec.shadowGates.ranRebuy, 'shadow gate verdict carries the ran-rebuy result');
  assert.equal(rec.shadowGates.ranRebuy.pass, true);
  assert.match(rec.shadowGates.ranRebuy.reason, /fail-open/);
});

test('ranrebuy bot: RAN_REBUY=0 — the check is never consulted', async () => {
  let calls = 0;
  const { cfg, bot } = rig({ seed: true, cfgOver: { ranRebuy: 0 }, candlesImpl: async () => { calls++; return []; } });
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(BT0));
  await bot.start();
  await bot.onSignal(view({ symbol: 'BOOT' }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(calls, 0, 'no candle fetch while the knob is off');
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec);
  assert.equal(rec.gates.ranRebuy, undefined);
  assert.equal(bot.stats.ranRebuy, undefined);
});

test('ranrebuy bot: a mint the bot never traded is never consulted (no prior, no fetch, no stamp)', async () => {
  let calls = 0;
  const { cfg, bot } = rig({ candlesImpl: async () => { calls++; return []; } });
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(BT0));
  await bot.start();
  await bot.onSignal(view({ symbol: 'FRESH' }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(calls, 0);
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec);
  assert.equal(rec.gates.ranRebuy, undefined);
  assert.equal(bot.stats.ranRebuy, undefined);
});
