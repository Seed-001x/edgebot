// Flow-Exit Watcher (user order 2026-10-15, RECORD-ONLY): when a tracked
// wallet's buy takes the bot in, watch THAT wallet's balance in the mint —
// journal its first big trim and its exit, and at the bot's close score the
// race (who got out first, and what exiting with the wallet would have
// paid vs what the bot's own stack banked). Pins: trigger attribution
// (FlowWatch.evaluate stamps the firing wallet; resolveTrigger's fallback
// chain), the watch lifecycle (baseline, silent adds, trim once, exit once,
// plunge = exit only, immediate exit on a zero first read, failed reads
// skipped), the final classification (exited-first / held-through /
// unknown-at-close / unknown) with the delta computed ONLY for a journaled
// exit-first, boot-scan dedupe (no re-fire after a simulated restart, peak
// reconstructed from the trim record), unresolvable triggers skipped, the
// scorecard aggregates + read-time joins, and the HTTP surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FlowExits, resolveTrigger, buildFlowExitCard, foldFlowExitJournal, FLOWEXIT_POLL_MS } from '../src/flowExits.js';
import { FlowWatch } from '../src/flowWatch.js';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { testCfg, tmp } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const MIN = 60000;
const CHAIRMAN = 'Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6';
const YENNI = '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG';
const WA = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WB = 'Wa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MINT = 'MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 10)); };
const readFx = (dir) => { try { return fs.readFileSync(path.join(dir, 'flow_exits.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// ---- harness: a watcher over a tmp journal with a scriptable balance book ----
function harness(dir, t0 = T0) {
  let t = t0;
  const cfg = { rpcUrls: [], flowNames: { [YENNI]: 'yenni', [CHAIRMAN]: 'chairman' }, flowSoloWallets: [YENNI, CHAIRMAN], flowWallets: [WA, WB] };
  const journal = new Journal(dir, { now: () => t });
  const bal = new Map();       // 'owner|mint' -> uiAmount | 'ERR' (throw) | unset (null read)
  const states = new Map();    // position id -> positionState object
  let reads = 0;
  const fetchBalance = async (owner, mint) => {
    reads++;
    const v = bal.get(owner + '|' + mint);
    if (v === 'ERR') throw new Error('rpc down');
    return v == null ? null : v;
  };
  const fx = new FlowExits({ cfg, journal, now: () => t, fetchBalance, positionState: (id) => states.get(id) || { open: false } });
  return { cfg, journal, bal, states, fx, setT: (v) => { t = v; }, reads: () => reads };
}
const setBal = (h, v) => h.bal.set(YENNI + '|' + MINT, v);
const pos = (over = {}) => ({ id: 'ABCDEF-1000', mint: MINT, symbol: 'KEK', setup: 'flow', entryTs: T0, entrySol: 0.05, ...over });
const sig = (over = {}) => ({ setup: 'flow', label: 'flow: yenni bought 9.03 SOL', metrics: { wallets: [YENNI], maxSol: 9.03, count: 1, kind: 'solo', wallet: YENNI, walletSol: 9.03, buyTs: T0 - 5000 }, ...over });
const openState = (over = {}) => ({ open: true, movePct: 5, peakPct: 10, markSol: 0.06, bankedSol: 0, botRemainingFrac: 1, ...over });

// ---- trigger attribution ----
test('flowexits attribution: FlowWatch.evaluate stamps the firing wallet (solo / size / confluence)', () => {
  const mk = () => {
    const triggers = [];
    const w = new FlowWatch({ cfg: testCfg({ flowWallets: [WA, WB], flowSoloWallets: [CHAIRMAN, YENNI], flowNames: { [CHAIRMAN]: 'chairman', [YENNI]: 'yenni' } }), onTrigger: (mint, agg) => triggers.push(agg), now: () => T0, log: () => {} });
    return { w, triggers };
  };
  { // solo: the solo wallet itself, its own size and buy ts
    const { w, triggers } = mk();
    w.recordBuy({ wallet: YENNI, mint: MINT, sol: 0.85, ts: T0 - 3000 });
    assert.equal(triggers[0].wallet, YENNI);
    assert.equal(triggers[0].walletSol, 0.85);
    assert.equal(triggers[0].buyTs, T0 - 3000);
  }
  { // size: the big roster buyer
    const { w, triggers } = mk();
    w.recordBuy({ wallet: WA, mint: MINT, sol: 1.3, ts: T0 - 2000 });
    assert.equal(triggers[0].kind, 'size');
    assert.equal(triggers[0].wallet, WA);
    assert.equal(triggers[0].walletSol, 1.3);
    assert.equal(triggers[0].buyTs, T0 - 2000);
  }
  { // confluence: the DECIDING buy (the one that completed the set)
    const { w, triggers } = mk();
    w.recordBuy({ wallet: WA, mint: MINT, sol: 0.3, ts: T0 - 9000 });
    w.recordBuy({ wallet: WB, mint: MINT, sol: 0.4, ts: T0 - 1000 });
    assert.equal(triggers[0].kind, 'confluence');
    assert.equal(triggers[0].wallet, WB);
    assert.equal(triggers[0].walletSol, 0.4);
    assert.equal(triggers[0].buyTs, T0 - 1000);
  }
});

test('flowexits attribution: resolveTrigger fallback chain + unresolvable', () => {
  const cfg = { flowNames: { [YENNI]: 'yenni' } };
  // metrics.wallet wins
  assert.equal(resolveTrigger(cfg, sig()).wallet, YENNI);
  assert.equal(resolveTrigger(cfg, sig()).name, 'yenni');
  assert.equal(resolveTrigger(cfg, sig()).sol, 9.03);
  // lone metrics.wallets entry
  const lone = resolveTrigger(cfg, { setup: 'flow', metrics: { wallets: [YENNI], kind: 'solo' }, label: null });
  assert.equal(lone.wallet, YENNI);
  // label name reversed through flowNames (legacy signals without the stamp)
  const legacy = resolveTrigger(cfg, { setup: 'flow', metrics: { kind: 'solo' }, label: 'flow: yenni bought 2.50 SOL' });
  assert.equal(legacy.wallet, YENNI);
  assert.equal(legacy.sol, 2.5);
  // confluence label + several wallets + no stamp: unresolvable
  assert.equal(resolveTrigger(cfg, { setup: 'flow', metrics: { wallets: [WA, WB], kind: 'confluence' }, label: 'flow: 2 tracked wallets bought within 15m (max 0.40 SOL)' }), null);
  assert.equal(resolveTrigger(cfg, { setup: 'flow', metrics: {}, label: null }), null);
  assert.equal(resolveTrigger(cfg, null), null);
});

// ---- lifecycle ----
test('flowexits: baseline, silent adds raise it, trim once at ≤50%, exit once at ≤5%', async () => {
  const dir = tmp(); const h = harness(dir);
  h.states.set('ABCDEF-1000', openState());
  setBal(h, 1000);
  const start = h.fx.start(pos(), sig());
  assert.ok(start && start.type === 'start');
  assert.equal(start.wallet, YENNI);
  assert.equal(start.triggerSol, 9.03);
  await flush(); // start's immediate read sets the baseline
  assert.deepEqual(readFx(dir).map(r => r.type), ['start']);
  // an ADD raises the baseline silently (1000 -> 1600): a dip to 900 is now
  // 56% of peak (no trim yet), and no record is written for the add
  setBal(h, 1600);
  await h.fx.tick(T0 + FLOWEXIT_POLL_MS);
  setBal(h, 900);
  await h.fx.tick(T0 + 2 * FLOWEXIT_POLL_MS);
  assert.deepEqual(readFx(dir).map(r => r.type), ['start']);
  // 700 = 43.75% of the 1600 peak -> trim, carrying the bot's state snapshot
  setBal(h, 700);
  h.states.set('ABCDEF-1000', openState({ movePct: 12.5, peakPct: 30, markSol: 0.07, bankedSol: 0.01, botRemainingFrac: 0.6 }));
  await h.fx.tick(T0 + 3 * FLOWEXIT_POLL_MS);
  let recs = readFx(dir);
  assert.deepEqual(recs.map(r => r.type), ['start', 'trim']);
  assert.equal(recs[1].remainingFrac, 0.4375);
  assert.equal(recs[1].botMovePct, 12.5);
  assert.equal(recs[1].botPeakPct, 30);
  assert.equal(recs[1].markSol, 0.07);
  // deeper but not out: still ONE trim
  setBal(h, 600);
  await h.fx.tick(T0 + 4 * FLOWEXIT_POLL_MS);
  assert.equal(readFx(dir).filter(r => r.type === 'trim').length, 1);
  // 60 = 3.75% of peak -> exit, once
  setBal(h, 60);
  await h.fx.tick(T0 + 5 * FLOWEXIT_POLL_MS);
  setBal(h, 0);
  await h.fx.tick(T0 + 6 * FLOWEXIT_POLL_MS);
  recs = readFx(dir);
  assert.deepEqual(recs.map(r => r.type), ['start', 'trim', 'exit']);
  assert.equal(recs[2].remainingFrac, 0.0375);
});

test('flowexits: a plunge straight through both thresholds is an EXIT, not a trim', async () => {
  const dir = tmp(); const h = harness(dir);
  h.states.set('ABCDEF-1000', openState());
  setBal(h, 1000);
  h.fx.start(pos(), sig());
  await flush();
  setBal(h, 20); // 2% of peak
  await h.fx.tick(T0 + FLOWEXIT_POLL_MS);
  assert.deepEqual(readFx(dir).map(r => r.type), ['start', 'exit']);
});

test('flowexits: zero balance on the FIRST read is an immediate exit (wallet beat the fill)', async () => {
  const dir = tmp(); const h = harness(dir);
  h.states.set('ABCDEF-1000', openState());
  setBal(h, 0); // token account gone before the bot's first poll
  h.fx.start(pos(), sig());
  await flush();
  const recs = readFx(dir);
  assert.deepEqual(recs.map(r => r.type), ['start', 'exit']);
  assert.equal(recs[1].firstRead, true);
  assert.equal(recs[1].remainingFrac, 0);
});

test('flowexits: failed reads are skipped silently; the 60s tick throttle holds', async () => {
  const dir = tmp(); const h = harness(dir);
  h.states.set('ABCDEF-1000', openState());
  setBal(h, 'ERR');
  h.fx.start(pos(), sig());
  await flush(); // the immediate read threw — no baseline, no record beyond start
  assert.deepEqual(readFx(dir).map(r => r.type), ['start']);
  setBal(h, 1000);
  const before = h.reads();
  await h.fx.tick(T0 + FLOWEXIT_POLL_MS);
  await h.fx.tick(T0 + FLOWEXIT_POLL_MS + 30000); // inside the cadence — no read
  assert.equal(h.reads(), before + 1);
  setBal(h, 400);
  await h.fx.tick(T0 + 2 * FLOWEXIT_POLL_MS);
  assert.deepEqual(readFx(dir).map(r => r.type), ['start', 'trim']);
});

// ---- finals + delta ----
test('flowexits: exited-first final — delta = mark at wallet exit minus actual remainder proceeds', async () => {
  const dir = tmp(); const h = harness(dir);
  h.states.set('ABCDEF-1000', openState());
  setBal(h, 1000);
  h.fx.start(pos(), sig());
  await flush();
  setBal(h, 30); // wallet out
  // At the exit moment the bot's remainder marked 0.09 SOL realizable, with
  // 0.02 SOL already banked from an earlier TP1.
  h.states.set('ABCDEF-1000', openState({ markSol: 0.09, bankedSol: 0.02, botRemainingFrac: 0.6, movePct: 50, peakPct: 80 }));
  await h.fx.tick(T0 + FLOWEXIT_POLL_MS);
  // The close: total proceeds 0.10 SOL (exitSol present) -> the remainder
  // actually fetched 0.10 - 0.02 = 0.08 -> delta = 0.09 - 0.08 = +0.01.
  const fin = await h.fx.finalize(pos(), { ts: T0 + 10 * MIN, reason: 'trailing stop', pnlSol: 0.049, entrySol: 0.05, exitSol: 0.10, feesSol: 0.001 });
  assert.equal(fin.walletState, 'exited-first');
  assert.equal(fin.deltaSol, 0.01);
  assert.equal(fin.pnlSol, 0.049);
  assert.equal(fin.walletExitTs, T0 + FLOWEXIT_POLL_MS);
  // fallback proceeds path (no exitSol on the close): proceeds = entry + pnl + fees
  const dir2 = tmp(); const h2 = harness(dir2);
  h2.states.set('ABCDEF-1000', openState());
  setBal(h2, 1000);
  h2.fx.start(pos(), sig());
  await flush();
  setBal(h2, 10);
  h2.states.set('ABCDEF-1000', openState({ markSol: 0.05, bankedSol: 0.01 }));
  await h2.fx.tick(T0 + FLOWEXIT_POLL_MS);
  const fin2 = await h2.fx.finalize(pos(), { ts: T0 + 10 * MIN, reason: 'bleed exit', pnlSol: -0.01, entrySol: 0.05, exitSol: undefined, feesSol: 0.001 });
  // proceeds 0.041; remainder fetched 0.041 - 0.01 = 0.031; delta = 0.05 - 0.031 = +0.019
  assert.equal(fin2.walletState, 'exited-first');
  assert.equal(fin2.deltaSol, 0.019);
});

test('flowexits: finals — held-through / unknown-at-close / unknown (failed read)', async () => {
  { // held-through: wallet still holds >5% at the final read
    const dir = tmp(); const h = harness(dir);
    h.states.set('ABCDEF-1000', openState());
    setBal(h, 1000); h.fx.start(pos(), sig()); await flush();
    setBal(h, 900);
    const fin = await h.fx.finalize(pos(), { ts: T0 + 5 * MIN, reason: 'TP2 + trail', pnlSol: 0.02, entrySol: 0.05, exitSol: 0.071, feesSol: 0.001 });
    assert.equal(fin.walletState, 'held-through');
    assert.equal(fin.deltaSol, null);
  }
  { // unknown-at-close: balance cratered inside the final poll gap — no
    // journaled exit event, so no exited-first claim and no delta
    const dir = tmp(); const h = harness(dir);
    h.states.set('ABCDEF-1000', openState());
    setBal(h, 1000); h.fx.start(pos(), sig()); await flush();
    setBal(h, 20); // (never polled at this level)
    const fin = await h.fx.finalize(pos(), { ts: T0 + 5 * MIN, reason: 'ratchet', pnlSol: 0, entrySol: 0.05, exitSol: 0.051, feesSol: 0.001 });
    assert.equal(fin.walletState, 'unknown-at-close');
    assert.equal(fin.deltaSol, null);
  }
  { // unknown: the final read itself failed
    const dir = tmp(); const h = harness(dir);
    h.states.set('ABCDEF-1000', openState());
    setBal(h, 1000); h.fx.start(pos(), sig()); await flush();
    setBal(h, 'ERR');
    const fin = await h.fx.finalize(pos(), { ts: T0 + 5 * MIN, reason: 'ratchet', pnlSol: 0, entrySol: 0.05, exitSol: null, feesSol: null });
    assert.equal(fin.walletState, 'unknown');
  }
  { // finalize of a never-watched position is a no-op
    const dir = tmp(); const h = harness(dir);
    assert.equal(await h.fx.finalize(pos(), { pnlSol: 0 }), null);
    assert.equal(readFx(dir).length, 0);
  }
});

// ---- skips ----
test('flowexits: unresolvable triggers and non-flow setups are skipped silently', async () => {
  const dir = tmp(); const h = harness(dir);
  h.states.set('ABCDEF-1000', openState());
  setBal(h, 1000);
  assert.equal(h.fx.start(pos(), { setup: 'flow', metrics: { wallets: [WA, WB], kind: 'confluence' }, label: 'flow: 2 tracked wallets bought within 15m (max 0.40 SOL)' }), null);
  assert.equal(h.fx.start(pos(), { setup: 'pop', metrics: {}, label: null }), null);
  assert.equal(h.fx.start(pos({ id: 'ZZZZZZ-1' }), sig({ setup: 'trend' })), null);
  await flush();
  assert.equal(readFx(dir).length, 0);
  assert.equal(h.fx.watches.size, 0);
});

// ---- boot dedupe / restore ----
test('flowexits: boot rebuild — fired trim/exit never re-fire, peak reconstructed, final still scores', async () => {
  const dir = tmp(); const h = harness(dir);
  h.states.set('ABCDEF-1000', openState());
  setBal(h, 1000);
  h.fx.start(pos(), sig());
  await flush();
  setBal(h, 400); // trim at 40% of 1000
  await h.fx.tick(T0 + FLOWEXIT_POLL_MS);
  h.states.set('ABCDEF-1000', openState({ markSol: 0.09, bankedSol: 0.02 }));
  setBal(h, 30); // exit at 3%
  await h.fx.tick(T0 + 2 * FLOWEXIT_POLL_MS);
  assert.deepEqual(readFx(dir).map(r => r.type), ['start', 'trim', 'exit']);
  // Simulated restart: a NEW watcher over the same journal + the position
  // still open. Balance still at 3% — nothing may re-fire.
  const h2 = harness(dir);
  h2.states.set('ABCDEF-1000', openState());
  h2.fx.restore([pos()]);
  assert.equal(h2.fx.watches.size, 1);
  setBal(h2, 30);
  await h2.fx.tick(T0 + 3 * FLOWEXIT_POLL_MS);
  setBal(h2, 500); // even a re-add + fall may not re-fire the exit... (500/1000 = 50%: no new trim either)
  await h2.fx.tick(T0 + 4 * FLOWEXIT_POLL_MS);
  assert.deepEqual(readFx(dir).map(r => r.type), ['start', 'trim', 'exit']);
  // Peak reconstruction proof: the restored baseline came from the trim
  // record (400 / 0.4 = 1000) — a drop to 400 (40% of 1000) does nothing new,
  // but the watch is live: finalize scores the race off the RESTORED exit.
  const fin = await h2.fx.finalize(pos(), { ts: T0 + 9 * MIN, reason: 'trailing stop', pnlSol: 0.049, entrySol: 0.05, exitSol: 0.10, feesSol: 0.001 });
  assert.equal(fin.walletState, 'exited-first');
  assert.equal(fin.deltaSol, 0.01); // restored exitRec carried markSol 0.09 / bankedSol 0.02
  // restore with no start record: nothing watched
  const h3 = harness(tmp());
  h3.fx.restore([pos({ id: 'NOPE-1' })]);
  assert.equal(h3.fx.watches.size, 0);
});

// ---- scorecard ----
test('flowexits: scorecard aggregates + read-time joins + readiness', () => {
  const S = (id, buyTs) => ({ type: 'start', id, ts: buyTs + 2000, mint: MINT, symbol: 'KEK', wallet: YENNI, walletName: 'yenni', kind: 'solo', triggerSol: 1, triggerBuyTs: buyTs, entryTs: buyTs + 2000, entrySol: 0.05 });
  const recs = [
    S('A-1', T0),
    { type: 'exit', id: 'A-1', ts: T0 + 300000, mint: MINT, symbol: 'KEK', walletName: 'yenni', remainingFrac: 0.02, botMovePct: 40, botPeakPct: 90 },
    { type: 'final', id: 'A-1', ts: T0 + 600000, walletState: 'exited-first', pnlSol: 0.02, deltaSol: 0.01, reason: 'trail' },
    S('B-2', T0),
    { type: 'trim', id: 'B-2', ts: T0 + 120000, mint: MINT, symbol: 'KEK', walletName: 'yenni', remainingFrac: 0.4, botMovePct: -5, botPeakPct: 3 },
    { type: 'final', id: 'B-2', ts: T0 + 400000, walletState: 'held-through', pnlSol: -0.01, deltaSol: null, reason: 'bleed' },
    S('C-3', T0),
  ];
  const card = buildFlowExitCard(recs);
  assert.equal(card.watched, 3);
  assert.equal(card.watching, 1);
  assert.equal(card.events, 2);
  assert.deepEqual(card.walletFirst, { n: 1, share: 0.5 });
  assert.equal(card.medianWalletHoldSec, 300); // exit ts - trigger buy ts
  assert.deepEqual(card.botPnlWalletFirst, { n: 1, totalSol: 0.02, medianSol: 0.02 });
  assert.deepEqual(card.counterfactual, { n: 1, totalDeltaSol: 0.01, medianDeltaSol: 0.01 });
  assert.equal(card.ready, false);
  assert.equal(card.recent.length, 2);
  assert.equal(card.recent[0].kind, 'exit'); // newest first
  assert.equal(card.recent[0].heldSec, 300);
  assert.equal(card.recent[0].botOpen, false);
  assert.equal(card.recent[0].botPnlSol, 0.02); // joined from the final at read time
  assert.equal(card.recent[0].deltaSol, 0.01);
  assert.equal(card.recent[1].kind, 'trim');
  assert.equal(card.recent[1].botPnlSol, -0.01);
  assert.equal(card.recent[1].deltaSol, null);
  // readiness: 10 wallet-first finals flips it
  const many = [];
  for (let i = 0; i < 10; i++) {
    many.push(S(`W-${i}`, T0), { type: 'exit', id: `W-${i}`, ts: T0 + 60000, remainingFrac: 0 }, { type: 'final', id: `W-${i}`, ts: T0 + 120000, walletState: 'exited-first', pnlSol: 0.001, deltaSol: 0 });
  }
  const card2 = buildFlowExitCard(many);
  assert.equal(card2.walletFirst.n, 10);
  assert.equal(card2.walletFirst.share, 1);
  assert.equal(card2.ready, true);
  // fold sanity: unknown types / id-less lines ignored
  assert.equal(foldFlowExitJournal([{ type: 'bogus', id: 'X' }, { type: 'start' }, null]).size, 1);
});

test('flowexits: module scorecard on an empty journal is the zero shape', () => {
  const h = harness(tmp());
  const card = h.fx.scorecard();
  assert.equal(card.enabled, true);
  assert.equal(card.watched, 0);
  assert.equal(card.watching, 0);
  assert.equal(card.events, 0);
  assert.deepEqual(card.walletFirst, { n: 0, share: null });
  assert.equal(card.medianWalletHoldSec, null);
  assert.equal(card.ready, false);
  assert.deepEqual(card.recent, []);
});

// ---- HTTP surface ----
test('flowexits: HTTP GET /flowexits serves the empty-state card on a fresh bot', async () => {
  const dir = tmp();
  const cfg = testCfg({ dataDir: dir });
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => T0, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  assert.ok(bot.flowExits, 'watcher constructed on the bot');
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const card = await (await fetch(base + '/flowexits')).json();
    assert.equal(card.enabled, true);
    assert.equal(card.watched, 0);
    assert.equal(card.watching, 0);
    assert.equal(card.events, 0);
    assert.deepEqual(card.walletFirst, { n: 0, share: null });
    assert.equal(card.medianWalletHoldSec, null);
    assert.deepEqual(card.botPnlWalletFirst, { n: 0, totalSol: null, medianSol: null });
    assert.deepEqual(card.counterfactual, { n: 0, totalDeltaSol: null, medianDeltaSol: null });
    assert.equal(card.ready, false);
    assert.deepEqual(card.recent, []);
  } finally { srv.close(); }
});
