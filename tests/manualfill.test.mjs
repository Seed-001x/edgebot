// D1 follow-ups (user 2026-10-14): (1) the real manual-sell fill read from the
// detected sell transaction's SOL + token balance deltas — close records and
// the paired shadow comparison price the manual side off the chain, not a
// mark; (2) the one-tap reason set is exactly the user's six. Record-only:
// every test pins a record shape or an API contract, never a trading decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { EXIT_REASONS, EXIT_REASON_LABELS } from '../src/learn.js';
import { startServer } from '../src/server.js';
import { testCfg, view, tmp } from './helpers.mjs';

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
  return { cfg, bot, clock, q };
}

// A real-mode Executor whose RPC is a fixture wallet: two sells of MINT1
// (1500 + 500 whole tokens), one buy (must be ignored), fees 5000 lamports
// paid by the wallet on each sell.
function fillExec() {
  const kp = Keypair.generate();
  const addr = kp.publicKey.toBase58();
  const cfg = testCfg({ realMode: true });
  const tok = (amount, uiAmount) => ({ mint: 'MINT1', owner: addr, uiTokenAmount: { amount, decimals: 6, uiAmount } });
  const txs = {
    SIGSELL1: {
      meta: {
        fee: 5000, err: null,
        preBalances: [5_000_000_000], postBalances: [5_745_000_000], // +0.745 SOL net
        preTokenBalances: [tok('2000000000', 2000)], postTokenBalances: [tok('500000000', 500)],
      },
      transaction: { message: { accountKeys: [{ pubkey: addr }, { pubkey: 'POOL' }] } },
    },
    SIGSELL2: {
      meta: {
        fee: 5000, err: null,
        preBalances: [6_000_000_000], postBalances: [6_245_000_000], // +0.245 SOL native…
        preTokenBalances: [tok('500000000', 500)],
        postTokenBalances: [tok('0', 0), { mint: SOL_MINT, owner: addr, uiTokenAmount: { amount: '100000000', decimals: 9, uiAmount: 0.1 } }], // …+0.1 via WSOL
      },
      transaction: { message: { accountKeys: [{ pubkey: addr }, { pubkey: 'POOL' }] } },
    },
    SIGBUY: {
      meta: {
        fee: 5000, err: null,
        preBalances: [7_000_000_000], postBalances: [6_900_000_000],
        preTokenBalances: [tok('0', 0)], postTokenBalances: [tok('100000000', 100)],
      },
      transaction: { message: { accountKeys: [{ pubkey: addr }, { pubkey: 'POOL' }] } },
    },
  };
  const rpc = async (method, params) => {
    if (method === 'getSignaturesForAddress') return Object.keys(txs).map(signature => ({ signature, blockTime: 2_000_000_000, err: null }));
    if (method === 'getTransaction') return txs[params[0]] || null;
    throw new Error('unexpected rpc ' + method);
  };
  const exec = new Executor(cfg, { rpc, env: { WALLET_PRIVATE_KEY: bs58.encode(kp.secretKey) } });
  return { exec, addr };
}

test('FU1 sellFill: fill = (SOL delta + fee paid) / tokens sold, aggregated over the sell txs', async () => {
  const { exec } = fillExec();
  const f = await exec.sellFill('MINT1', {});
  assert.ok(f, 'fill parsed');
  assert.deepEqual(f.sigs, ['SIGSELL1', 'SIGSELL2'], 'the buy tx is not a sell');
  assert.equal(f.txCount, 2);
  assert.equal(f.tokensRawSold, '2000000000');
  assert.equal(f.tokensWhole, 2000);
  assert.equal(f.decimals, 6);
  assert.equal(f.proceedsNetSol, 1.09, 'net = 0.745 + (0.245 native + 0.1 WSOL)');
  assert.equal(f.feeSol, 0.00001, 'both sell fees, paid by the wallet');
  assert.equal(f.grossSol, 1.09001, 'gross adds the fees back — the SOL delta is net of them');
  assert.ok(Math.abs(f.fillSol - 1.09001 / 2000) < 1e-12, `fill ${f.fillSol}`);
});

test('FU1 sellFill: bot signatures are excluded; nothing parseable → null; shadow → null', async () => {
  const { exec } = fillExec();
  const one = await exec.sellFill('MINT1', { excludeSigs: new Set(['SIGSELL2']) });
  assert.equal(one.txCount, 1);
  assert.ok(Math.abs(one.fillSol - 0.745005 / 1500) < 1e-12, 'single-tx fill');
  const empty = new Executor(testCfg({ realMode: true }), {
    rpc: async (m) => (m === 'getSignaturesForAddress' ? [] : null),
    env: { WALLET_PRIVATE_KEY: bs58.encode(Keypair.generate().secretKey) },
  });
  assert.equal(await empty.sellFill('MINT1', {}), null, 'no sell txs → null, never fabricated');
  const shadow = new Executor(testCfg({}), { rpc: async () => { throw new Error('must not be called'); } });
  assert.equal(await shadow.sellFill('MINT1', {}), null, 'shadow mode never reads the chain');
});

test('FU1 manual exit: close + manual record carry the chain fill; the paired side prices off it', async () => {
  const { bot, clock } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0]; // 1000 whole tokens (1e9 raw, 6dp), entry 0.02 SOL
  const buyFeeEst = pos.feesSol;
  bot.lastSolUsd = 150;
  bot.exec.sellFill = async () => ({ sigs: ['SX1'], txCount: 1, tokensRawSold: '1000000000', decimals: 6, tokensWhole: 1000, proceedsNetSol: 0.03, feeSol: 0.000005, grossSol: 0.030005, fillSol: 0.030005 / 1000 });
  const n = T0 + 20 * 60000;
  clock.t = n;
  const rec = await bot.recordManualExit(pos, 0.029, n, 'sold in own wallet'); // mark says 0.029 — the chain says 0.03
  // the manual-exit (learning) record
  assert.equal(rec.fillSource, 'chainTx');
  assert.ok(Math.abs(rec.exitFillSol - 0.000030005) < 1e-12);
  // the close record
  const close = bot.journal.trades.find(t => t.type === 'close' && t.id === rec.id);
  assert.ok(Math.abs(close.exitFillSol - 0.000030005) < 1e-12, 'exit fill from the sell tx, not null');
  assert.ok(Math.abs(close.exitFillUsd - 0.000030005 * 150) < 1e-9, 'USD via the live SOL/USD');
  assert.equal(close.fillSource, 'chainTx');
  assert.equal(close.sellTxFeeSol, 0.000005, 'the real sell fee, from the tx');
  assert.deepEqual(close.sellSigs, ['SX1']);
  assert.ok(Math.abs(close.feesSol - (buyFeeEst + 0.000005)) < 1e-9, 'feesSol = buy estimate + real sell fee');
  assert.equal(close.feesSource, 'chainTxSellFee+calibratedTxFees', 'the mix is labeled as a mix');
  // the paired shadow comparison: manual side is the REAL proceeds, not the mark
  const st = bot.paired.pending.get(rec.id);
  assert.ok(st, 'paired watch registered');
  assert.equal(st.manualMarkSol, 0.03, 'real net proceeds — not the 0.029 mark');
  assert.equal(st.manualFillSource, 'chainTx');
  bot.paired.tick(() => null, n + 61 * 60000, bot.cfg, 150); // cap expiry finalizes
  const done = bot.paired.done.find(d => d.id === rec.id);
  assert.equal(done.manualMarkSource, 'chainTx');
  assert.equal(done.manualMarkSol, 0.03);
  assert.equal(done.manualRemainderPnlSol, 0.01, 'human remainder: 0.03 realized − 0.02 basis');
  assert.ok(Math.abs(done.manualFillSol - 0.000030005) < 1e-12);
});

test('FU1 manual exit: sell tx unreadable → today\'s nulls, mark-based pair, nothing blocked', async () => {
  const { bot, clock } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0];
  bot.exec.sellFill = async () => null; // tx not found / unparseable
  const n = T0 + 10 * 60000;
  clock.t = n;
  const rec = await bot.recordManualExit(pos, 0.024, n, 'sold in own wallet');
  const close = bot.journal.trades.find(t => t.type === 'close' && t.id === rec.id);
  assert.equal(close.exitFillSol, null, 'no fill read — null preserved, never invented');
  assert.equal(close.feesSource, 'calibratedTxFees', 'fees stay the calibrated tx-fee estimate');
  const st = bot.paired.pending.get(rec.id);
  assert.equal(st.manualMarkSol, 0.024, 'pair falls back to the mark');
  assert.equal(st.manualFillSource, null);
});

test('FU1 partial manual sell (reconcile): the fill read lands on the close; the pair values the full remainder at the realized price', async () => {
  const { bot, clock } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0]; // books hold 1000 whole tokens
  // the user sold only 400 of them (one tx) before the position reconciled out
  bot.exec.sellFill = async () => ({ sigs: ['SP1'], txCount: 1, tokensRawSold: '400000000', decimals: 6, tokensWhole: 400, proceedsNetSol: 0.012, feeSol: 0.000005, grossSol: 0.012005, fillSol: 0.012005 / 400 });
  clock.t = T0 + 30 * 60000;
  const ok = await bot.closeExternal(pos, 'reconcile: tokens no longer in wallet (manual sell)');
  assert.equal(ok, true);
  const close = bot.journal.trades.find(t => t.type === 'close' && t.id === pos.id);
  assert.ok(Math.abs(close.exitFillSol - 0.012005 / 400) < 1e-12, 'partial sell fill on the close record');
  assert.equal(close.fillSource, 'chainTx');
  const st = bot.paired.pending.get(pos.id);
  assert.equal(st.manualMarkSol, 0.03, 'remainder valued at the realized net price: 0.012 × 1000/400');
  assert.equal(st.manualFillSource, 'chainTx');
});

test('FU2 reasons: the settable set is exactly the user\'s six, labels verbatim', () => {
  assert.deepEqual(EXIT_REASONS, ['stalled', 'volume_died', 'wick', 'chart_off', 'gut', 'other']);
  assert.deepEqual(EXIT_REASONS.map(k => EXIT_REASON_LABELS[k]), ['stalled', 'volume died', 'wick', 'chart off', 'gut', 'other']);
});

test('FU2 exittag: all six accepted onto the snapshot-carrying record; legacy reasons rejected; set inspectable on /learn', async () => {
  const { bot } = rig();
  await bot.start();
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    // /learn exposes the live set with the user's exact labels
    const learn0 = await (await fetch(base + '/learn')).json();
    assert.deepEqual(learn0.exitReasons, [
      { key: 'stalled', label: 'stalled' }, { key: 'volume_died', label: 'volume died' },
      { key: 'wick', label: 'wick' }, { key: 'chart_off', label: 'chart off' },
      { key: 'gut', label: 'gut' }, { key: 'other', label: 'other' },
    ]);
    // each of the six: one POST, persisted on the manual record that carries the snapshot
    for (const [i, reason] of EXIT_REASONS.entries()) {
      const id = 'mx' + i;
      bot.journal.manualExit({ id, mint: 'M' + i, symbol: 'T' + i, ts: T0 + i, heldMin: 3, entry: { holders: 10 }, reason: null, snapshot: { path: [], distFromPeakPct: -5 } });
      const r = await post('/exittag', { id, reason });
      assert.equal(r.status, 200, reason);
      const m = bot.journal.manual.find(x => x.id === id);
      assert.equal(m.reason, reason, 'tag persisted');
      assert.ok(m.snapshot, 'snapshot and tag share one record');
    }
    // a legacy v1.9 reason is no longer settable (historical tags stay as-is)
    for (const legacy of ['dev_bundle', 'farm_wallets']) {
      const r = await post('/exittag', { id: 'mx0', reason: legacy });
      assert.equal(r.status, 400, legacy + ' rejected');
    }
    const m0 = bot.journal.manual.find(x => x.id === 'mx0');
    assert.equal(m0.reason, 'stalled', 'rejected tags never overwrite a saved one');
  } finally { srv.close(); }
});
