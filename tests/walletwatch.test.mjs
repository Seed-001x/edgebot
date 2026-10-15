// Wallet-task shadow detectors (Phases 4–6, user go 2026-10-15): dev launches
// + survivor confluence, log-only. These tests pin the classifiers, the
// confluence window math, the candle outcome math, the qualification flags
// (baseline: runners 21.8% / crashes 38.1% / rug <15% / median peak >= 2x),
// the event lifecycle (create → first sell → finalize → reload), and the
// /devwatch surface. Nothing here may trade — the module has no exec path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletWatch, classifyDevBuy, findConfluence, computeOutcome, summarizeEvents, devStatus, confluenceStatus, BASELINE } from '../src/walletWatch.js';
import { parseWalletSells } from '../src/flowWatch.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { tmp, testCfg, view } from './helpers.mjs';
import { LAMPORTS } from '../src/util.js';

const T0 = 1_000_000_000_000;
const SETS = {
  baseline: BASELINE,
  devs: [{ address: 'DEV1', name: 'mitch dev' }],
  survivors: [
    { entity: 'E1', name: 'paper', cluster: 'paper', wallets: ['W1'] },
    { entity: 'E2', name: 'multi', cluster: 'multi', wallets: ['W2', 'W3'] },
  ],
};

test('classifyDevBuy: creator, early, late, unknown', () => {
  assert.equal(classifyDevBuy({ creator: 'DEV1', createdTs: T0, buyTs: T0 + 5000, wallet: 'DEV1' }), 'created');
  assert.equal(classifyDevBuy({ creator: 'OTHER', createdTs: T0, buyTs: T0 + 30 * 60000, wallet: 'DEV1' }), 'early');
  assert.equal(classifyDevBuy({ creator: 'OTHER', createdTs: T0, buyTs: T0 + 61 * 60000, wallet: 'DEV1' }), null);
  assert.equal(classifyDevBuy({ creator: null, createdTs: null, buyTs: T0, wallet: 'DEV1' }), null);
});

test('findConfluence: distinct clusters inside the window fire at the deciding buy', () => {
  const buys = [
    { cluster: 'paper', entity: 'E1', wallet: 'W1', mint: 'M', sol: 1, ts: T0 },
    { cluster: 'paper', entity: 'E1', wallet: 'W1', mint: 'M', sol: 1, ts: T0 + 60000 },
    { cluster: 'multi', entity: 'E2', wallet: 'W2', mint: 'M', sol: 2, ts: T0 + 2 * 60000 },
  ];
  const t = findConfluence(buys, { windowMs: 5 * 60000, minClusters: 2 });
  assert.equal(t.ts, T0 + 2 * 60000);
  assert.deepEqual(t.clusters.sort(), ['multi', 'paper']);
  assert.equal(t.maxSol, 2);
  // same entity via a second wallet is ONE voice — no fire
  const sameEnt = [
    { cluster: 'multi', entity: 'E2', wallet: 'W2', mint: 'M', sol: 1, ts: T0 },
    { cluster: 'multi', entity: 'E2', wallet: 'W3', mint: 'M', sol: 1, ts: T0 + 60000 },
  ];
  assert.equal(findConfluence(sameEnt, { windowMs: 5 * 60000, minClusters: 2 }), null);
  // outside the window — no fire
  const apart = [
    { cluster: 'paper', entity: 'E1', wallet: 'W1', mint: 'M', sol: 1, ts: T0 },
    { cluster: 'multi', entity: 'E2', wallet: 'W2', mint: 'M', sol: 1, ts: T0 + 6 * 60000 },
  ];
  assert.equal(findConfluence(apart, { windowMs: 5 * 60000, minClusters: 2 }), null);
});

test('computeOutcome: checkpoints, peak, dip from minute candles', () => {
  const entryTs = T0;
  const candles = [];
  for (let m = 0; m <= 65; m++) {
    const base = 100;
    const c = m === 0 ? 100 : m <= 20 ? 100 + m * 5 : m <= 40 ? 200 - (m - 20) * 2 : 160 - (m - 40);
    candles.push([Math.floor((entryTs + m * 60000) / 1000), base, c * 1.02, c * 0.99, c, 1000]);
  }
  const out = computeOutcome(candles, entryTs);
  assert.equal(out.entryPrice, 100);
  assert.ok(Math.abs(out.r5 - 0.25) < 0.011, `r5 ${out.r5}`);          // close at +5m = 125
  assert.ok(Math.abs(out.r60 - 0.4) < 0.011, `r60 ${out.r60}`);        // close at +60m = 140
  assert.ok(Math.abs(out.maxRet - 1.04) < 0.02, `maxRet ${out.maxRet}`); // high 204 at +20m
  assert.equal(out.peakMin, 20);
  assert.equal(computeOutcome([], entryTs), null);
});

test('qualification flags: qualified / collecting / demoted against the baseline', () => {
  const ev = (i, maxRet, minRet, r60 = 0.2) => ({ ts: T0 + i * 60000, out: { done: true, maxRet, minRet, r60 } });
  const good = Array.from({ length: 10 }, (_, i) => ev(i, 1.5, -0.2));       // all double, no crashes
  assert.equal(devStatus(good, BASELINE, 10), 'qualified');
  assert.equal(devStatus(good.slice(0, 9), BASELINE, 10), 'collecting');    // not enough sample
  const faded = [...good, ...Array.from({ length: 10 }, (_, i) => ev(10 + i, 0.1, -0.8, -0.5))]; // latest window all crash
  assert.equal(devStatus(faded, BASELINE, 10), 'demoted');
  const bad = Array.from({ length: 10 }, (_, i) => ev(i, 0.1, -0.8, -0.5));
  assert.equal(devStatus(bad, BASELINE, 10), 'collecting');                 // never qualified → not "demoted"
  const cnf = Array.from({ length: 30 }, (_, i) => ev(i, 0.8, -0.3));
  assert.equal(confluenceStatus(cnf, BASELINE, 30), 'qualified');           // 100% runners (>50% peak), 0% crashes
  assert.equal(confluenceStatus(cnf.slice(0, 29), BASELINE, 30), 'collecting');
  const s = summarizeEvents(good);
  assert.equal(s.runnerShare, 1); assert.equal(s.medPeak, 2.5);
});

test('parseWalletSells: token down + SOL in is a sell; a buy is not', () => {
  const sellTx = {
    meta: { err: null, preBalances: [10 * LAMPORTS], postBalances: [Math.round(10.5 * LAMPORTS)],
      preTokenBalances: [{ mint: 'M', owner: 'DEV1', uiTokenAmount: { uiAmount: 1000 } }],
      postTokenBalances: [{ mint: 'M', owner: 'DEV1', uiTokenAmount: { uiAmount: 400 } }] },
    transaction: { message: { accountKeys: [{ pubkey: 'DEV1' }] } },
  };
  const sells = parseWalletSells(sellTx, 'DEV1');
  assert.equal(sells.length, 1); assert.equal(sells[0].mint, 'M'); assert.ok(Math.abs(sells[0].sol - 0.5) < 1e-9);
  const buyTx = {
    meta: { err: null, preBalances: [10 * LAMPORTS], postBalances: [Math.round(9 * LAMPORTS)],
      preTokenBalances: [], postTokenBalances: [{ mint: 'M', owner: 'DEV1', uiTokenAmount: { uiAmount: 1000 } }] },
    transaction: { message: { accountKeys: [{ pubkey: 'DEV1' }] } },
  };
  assert.deepEqual(parseWalletSells(buyTx, 'DEV1'), []);
});

function watchRig(dir, over = {}) {
  const cfg = testCfg({});
  const clock = { t: T0 };
  const views = new Map([['MINTD', view({ address: 'MINTD', symbol: 'DEVCOIN', pairAddress: 'POOL1' })]]);
  const ww = new WalletWatch({
    cfg, dir, now: () => clock.t, sets: SETS,
    rpcFn: async () => [],
    fetchViews: async (ms) => new Map(ms.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchCoin: async () => ({ creator: 'DEV1', createdTs: T0 - 30000, symbol: 'DEVCOIN' }),
    fetchCandles: async () => [],
    shadowGates: async () => ({ gates: { rug: { pass: false, reason: 'x' } }, gatePass: false }),
    log: () => {},
    ...over,
  });
  return { ww, clock };
}

test('dev launch lifecycle: event, dedupe, first sell, reload persistence', async () => {
  const dir = tmp();
  const { ww } = watchRig(dir);
  await ww.onDevBuy('DEV1', { mint: 'MINTD', sol: 2.5 }, T0);
  assert.equal(ww.events.size, 1);
  const ev = [...ww.events.values()][0];
  assert.equal(ev.sub, 'created');
  assert.equal(ev.entryTs, T0 - 30000 + 60000);
  assert.equal(ev.gatePass, false);
  assert.equal(ev.firstBlocker, 'rug');
  await ww.onDevBuy('DEV1', { mint: 'MINTD', sol: 1 }, T0 + 60000); // same dev+coin: not a new launch
  assert.equal(ww.events.size, 1);
  ww.onDevSell('DEV1', { mint: 'MINTD', sol: 3 }, T0 + 10 * 60000);
  assert.equal(ev.devSell.sol, 3);
  ww.onDevSell('DEV1', { mint: 'MINTD', sol: 1 }, T0 + 12 * 60000); // second sell ignored
  assert.equal(ev.devSell.sol, 3);
  const { ww: ww2 } = watchRig(dir);
  assert.equal(ww2.events.size, 1, 'event survives reload');
  assert.equal([...ww2.events.values()][0].devSell.sol, 3);
  assert.ok(ww2.launchedKeys.has('DEV1:MINTD'));
});

test('confluence event from two entities; snapshot aggregates + flags', async () => {
  const { ww, clock } = watchRig(tmp());
  ww.onSurvivorBuy('W1', { mint: 'MINTD', sol: 1.2 }, T0);
  assert.equal(ww.events.size, 0);
  ww.onSurvivorBuy('W3', { mint: 'MINTD', sol: 0.8 }, T0 + 2 * 60000); // W3 is entity E2 (multi)
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(ww.events.size, 1);
  const ev = [...ww.events.values()][0];
  assert.equal(ev.kind, 'confluence');
  assert.deepEqual(ev.entities.sort(), ['E1', 'E2']);
  assert.equal(ev.entryTs, T0 + 2 * 60000);
  const snap = ww.snapshot();
  assert.equal(snap.counts.survivorEntities, 2);
  assert.equal(snap.confluence.events, 1);
  assert.equal(snap.confluence.status, 'collecting');
  assert.equal(snap.devs[0].name, 'mitch dev');
  assert.equal(snap.devs[0].status, 'collecting');
  clock.t += 1000;
});

test('finalizeTick: candles produce the outcome; partial after 6h without a path', async () => {
  const candles = [];
  for (let m = 0; m <= 65; m++) candles.push([Math.floor((T0 + m * 60000) / 1000), 100, (100 + m) * 1.01, (100 + m) * 0.99, 100 + m, 1000]);
  const { ww, clock } = watchRig(tmp(), { fetchCandles: async () => candles });
  await ww.onDevBuy('DEV1', { mint: 'MINTD', sol: 1 }, T0 + 30000); // createdTs T0-30s → entry T0+30s
  const ev = [...ww.events.values()][0];
  clock.t = ev.entryTs + 66 * 60000;
  await ww.finalizeTick(clock.t);
  assert.ok(ev.out && ev.out.done);
  assert.ok(ev.out.maxRet > 0.5, `peak tracked: ${ev.out.maxRet}`);
  const snap = ww.snapshot();
  assert.equal(snap.devs[0].finalized, 1);
});

test('GET /devwatch serves the snapshot from a live bot', async () => {
  const cfg = testCfg({});
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => T0, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  const srv = startServer(bot, 0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/devwatch`);
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.counts.devWallets, 23);
    assert.equal(s.counts.survivorEntities, 225);
    assert.equal(s.counts.survivorWallets, 297);
    assert.equal(s.devs.length, 23);
    assert.ok(s.devs.every(d => d.status === 'collecting'));
    assert.equal(s.baseline.runnerShare, 0.218);
  } finally { srv.close(); }
});
