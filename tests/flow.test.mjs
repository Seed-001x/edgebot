// Smart-wallet flow detector (user 2026-10-14): parser + trigger fixtures.
// Solo wallets (user-named: "chairman", "yenni") fire alone on any buy >= the
// 0.1 SOL anti-dust floor; roster wallets need size (>= FLOW_MIN_SOL) or confluence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowWatch, parseWalletBuys, FLOW_DUST_SOL } from '../src/flowWatch.js';
import { loadConfig } from '../src/config.js';
import { SOL_MINT, LAMPORTS } from '../src/util.js';
import { testCfg, tmp } from './helpers.mjs';

const CHAIRMAN = 'Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6';
const YENNI = '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG';
const WA = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WB = 'Wa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MINT = 'MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const NOW = 1_000_000_000_000;

// ---- parser fixtures ----
const buyTx = (wallet, mint, solSpent, tokGain = 1000) => ({
  meta: {
    err: null,
    preBalances: [10 * LAMPORTS], postBalances: [Math.round((10 - solSpent) * LAMPORTS)],
    preTokenBalances: [],
    postTokenBalances: [{ mint, owner: wallet, uiTokenAmount: { uiAmount: tokGain } }],
  },
  transaction: { message: { accountKeys: [{ pubkey: wallet }] } },
});

test('flow parse: a buy reads as token balance up + SOL out', () => {
  const buys = parseWalletBuys(buyTx(WA, MINT, 0.42), WA);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].mint, MINT);
  assert.ok(Math.abs(buys[0].sol - 0.42) < 1e-9);
});

test('flow parse: a sell is not a buy (token balance down, SOL in)', () => {
  const sellTx = {
    meta: {
      err: null,
      preBalances: [10 * LAMPORTS], postBalances: [Math.round(10.5 * LAMPORTS)],
      preTokenBalances: [{ mint: MINT, owner: WA, uiTokenAmount: { uiAmount: 1000 } }],
      postTokenBalances: [{ mint: MINT, owner: WA, uiTokenAmount: { uiAmount: 400 } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: WA }] } },
  };
  assert.deepEqual(parseWalletBuys(sellTx, WA), []);
});

test('flow parse: a token transfer-in with no SOL spent is not a buy', () => {
  const tx = buyTx(WA, MINT, 0); // balance unchanged → no SOL left the wallet
  assert.deepEqual(parseWalletBuys(tx, WA), []);
});

test('flow parse: failed and malformed txs yield nothing', () => {
  const errTx = buyTx(WA, MINT, 1); errTx.meta.err = { InstructionError: [0, 'x'] };
  assert.deepEqual(parseWalletBuys(errTx, WA), []);
  assert.deepEqual(parseWalletBuys(null, WA), []);
  assert.deepEqual(parseWalletBuys({}, WA), []);
});

// ---- trigger fixtures ----
function mkWatch(over = {}) {
  const triggers = [];
  const w = new FlowWatch({
    cfg: testCfg({ flowWallets: [WA, WB], flowSoloWallets: [CHAIRMAN, YENNI], flowNames: { [CHAIRMAN]: 'chairman', [YENNI]: 'yenni' }, ...over }),
    onTrigger: (mint, agg) => triggers.push({ mint, agg }),
    now: () => NOW,
    log: () => {},
  });
  return { w, triggers };
}

test('flow: solo wallet buy of 0.2 SOL fires solo (chairman, named label)', () => {
  const { w, triggers } = mkWatch();
  w.recordBuy({ wallet: CHAIRMAN, mint: MINT, sol: 0.2, ts: NOW });
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].agg.kind, 'solo');
  assert.equal(triggers[0].agg.label, 'flow: chairman bought 0.20 SOL');
});

test('flow: solo wallet yenni fires alone and the label uses her name', () => {
  const { w, triggers } = mkWatch();
  w.recordBuy({ wallet: YENNI, mint: MINT, sol: 0.85, ts: NOW });
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].agg.kind, 'solo');
  assert.equal(triggers[0].agg.label, 'flow: yenni bought 0.85 SOL');
});

test('flow: solo buy under the 0.1 SOL anti-dust floor does not fire', () => {
  const { w, triggers } = mkWatch();
  w.recordBuy({ wallet: YENNI, mint: MINT, sol: FLOW_DUST_SOL - 0.01, ts: NOW });
  assert.equal(triggers.length, 0);
});

test('flow: non-solo wallet buy of 0.2 SOL does NOT fire alone', () => {
  const { w, triggers } = mkWatch();
  w.recordBuy({ wallet: WA, mint: MINT, sol: 0.2, ts: NOW });
  assert.equal(triggers.length, 0);
});

test('flow: single tracked buy >= FLOW_MIN_SOL (1.0) fires on size', () => {
  const { w, triggers } = mkWatch();
  w.recordBuy({ wallet: WA, mint: MINT, sol: 1.3, ts: NOW });
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].agg.kind, 'size');
  assert.ok(/bought 1\.30 SOL/.test(triggers[0].agg.label), triggers[0].agg.label);
});

test('flow: two tracked wallets on the same mint inside the window fire confluence', () => {
  const { w, triggers } = mkWatch();
  w.recordBuy({ wallet: WA, mint: MINT, sol: 0.3, ts: NOW });
  assert.equal(triggers.length, 0, 'one small buy is not enough');
  w.recordBuy({ wallet: WB, mint: MINT, sol: 0.4, ts: NOW + 60000 });
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].agg.kind, 'confluence');
  assert.equal(triggers[0].agg.count, 2);
  assert.equal(triggers[0].agg.label, 'flow: 2 tracked wallets bought within 15m (max 0.40 SOL)');
});

test('flow: confluence window expires — the same two buys 20m apart do not fire', () => {
  const { w, triggers } = mkWatch();
  let t = NOW;
  w.now = () => t;
  w.recordBuy({ wallet: WA, mint: MINT, sol: 0.3, ts: t });
  t += 20 * 60000;
  w.recordBuy({ wallet: WB, mint: MINT, sol: 0.4, ts: t });
  assert.equal(triggers.length, 0);
});

test('flow: duplicate signature does not double-fire (poll watermark + seen set)', async () => {
  const triggers = [];
  let sigList = [{ signature: 'sig-old', blockTime: NOW / 1000 - 60 }];
  const rpcFn = async (method, params) => {
    if (method === 'getSignaturesForAddress') return sigList;
    if (method === 'getTransaction') return buyTx(CHAIRMAN, MINT, 0.42);
    throw new Error(`unexpected ${method}`);
  };
  const w = new FlowWatch({
    cfg: testCfg({ flowWallets: [], flowSoloWallets: [CHAIRMAN], flowNames: { [CHAIRMAN]: 'chairman' } }),
    onTrigger: (mint, agg) => triggers.push({ mint, agg }),
    now: () => NOW, rpcFn, log: () => {},
  });
  await w.poll(); // first contact: watermark adopts sig-old, history is NOT processed
  assert.equal(triggers.length, 0);
  sigList = [{ signature: 'sig-new', blockTime: NOW / 1000 }, { signature: 'sig-old', blockTime: NOW / 1000 - 60 }];
  await w.poll(); // processes sig-new exactly once
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].agg.kind, 'solo');
  await w.poll(); // same list again — nothing new, no second fire
  assert.equal(triggers.length, 1);
});

test('flow config: wallet lists and the names map parse from env', () => {
  const cfg = loadConfig({
    DATA_DIR: tmp(),
    FLOW_WALLETS: `${WA}, ${WB}`,
    FLOW_SOLO_WALLETS: `${CHAIRMAN},${YENNI}`,
    FLOW_WALLET_NAMES: `${CHAIRMAN}:chairman,${YENNI}:yenni`,
  });
  assert.deepEqual(cfg.flowWallets, [WA, WB]);
  assert.deepEqual(cfg.flowSoloWallets, [CHAIRMAN, YENNI]);
  assert.equal(cfg.flowNames[CHAIRMAN], 'chairman');
  assert.equal(cfg.flowNames[YENNI], 'yenni');
  const empty = loadConfig({ DATA_DIR: tmp() });
  assert.deepEqual(empty.flowWallets, []);
  assert.deepEqual(empty.flowSoloWallets, []);
  assert.deepEqual(empty.flowNames, {});
});
