// flowWatch.js — smart-wallet flow detector (user 2026-10-14).
//
// The signal is a WALLET, not a chart: when tracked smart wallets buy a coin, the
// buy nominates it into the bot's normal signal pipeline (Bot._evalFlow → onSignal —
// every gate, veto, risk check and exit unchanged). Detection runs on the existing
// Helius RPC (cfg.rpcUrls) by polling each wallet's recent signatures — deliberately
// NOT the PumpPortal trade stream, which is balance-gated and dark while its wallet
// sits under the 0.02 SOL streaming threshold.
//
// A "buy" is measured the way exec.sellProceeds measures a sell, from parsed-tx
// balance deltas: the wallet's token balance of a mint ROSE in a tx where SOL
// (native + WSOL) net-LEFT the wallet. That reads pump.fun bonding-curve buys,
// PumpSwap buys and Jupiter swaps identically, with no instruction parsing.
//
// Triggers (all sizes first pass a 0.1 SOL anti-dust floor):
//   solo       — a FLOW_SOLO_WALLETS wallet buys, any size (user: "whatever it buys
//                should pop on the signals regardless of the setup")
//   size       — one tracked wallet buys >= FLOW_MIN_SOL of a mint
//   confluence — >= FLOW_WALLETS_CONFL distinct tracked wallets buy the same mint
//                within FLOW_WINDOW_MIN minutes
// Fail-open throughout: an RPC error logs and skips the cycle, never crashes the bot.

import { fetchJson, SOL_MINT, LAMPORTS } from './util.js';

export const FLOW_DUST_SOL = 0.1;

const keyStr = (k) => (typeof k === 'string' ? k : (k && k.pubkey) || '');
export const shortAddr = (a) => `${String(a).slice(0, 4)}…${String(a).slice(-4)}`;

export async function flowRpc(rpcUrls, method, params, timeout = 12000) {
  let last;
  for (const url of rpcUrls || []) {
    try {
      const j = await fetchJson(url, { method: 'POST', timeout, body: { jsonrpc: '2.0', id: 1, method, params }, throwOnError: true });
      if (j && j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    } catch (e) { last = e; }
  }
  throw new Error(`rpc ${method} failed: ${last && last.message}`);
}

/**
 * Pure: the buys `wallet` made in one parsed transaction.
 * Returns [{ mint, sol }] where sol is the SOL that net-left the wallet in the tx
 * (its total spend; a tx that buys two mints attributes the full spend to each —
 * trigger sizing reads maxSol as "this wallet committed ~this much here").
 */
export function parseWalletBuys(tx, wallet) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const meta = tx.meta;
  const tokSum = (list, mint) => (list || []).filter(b => b && b.mint === mint && b.owner === wallet)
    .reduce((a, b) => a + (Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0), 0);
  const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys || []).map(keyStr);
  const idx = keys.indexOf(wallet);
  let solDelta = idx >= 0 ? (Number(meta.postBalances[idx]) - Number(meta.preBalances[idx])) / LAMPORTS : 0;
  solDelta += tokSum(meta.postTokenBalances, SOL_MINT) - tokSum(meta.preTokenBalances, SOL_MINT);
  if (!(solDelta < 0)) return []; // SOL didn't net-leave the wallet — not a buy tx (sell, transfer-in, airdrop)
  const spent = -solDelta;
  const mints = new Set();
  for (const b of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) if (b && b.mint && b.mint !== SOL_MINT) mints.add(b.mint);
  const buys = [];
  for (const mint of mints) {
    const d = tokSum(meta.postTokenBalances, mint) - tokSum(meta.preTokenBalances, mint);
    if (d > 0) buys.push({ mint, sol: spent });
  }
  return buys;
}

/**
 * Pure: the sells `wallet` made in one parsed transaction — mirror of
 * parseWalletBuys: the wallet's token balance of a mint FELL in a tx where SOL
 * (native + WSOL) net-ENTERED the wallet. Returns [{ mint, sol }] with sol =
 * the SOL that net-entered (total proceeds attributed per mint, as buys do).
 */
export function parseWalletSells(tx, wallet) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const meta = tx.meta;
  const tokSum = (list, mint) => (list || []).filter(b => b && b.mint === mint && b.owner === wallet)
    .reduce((a, b) => a + (Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0), 0);
  const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys || []).map(keyStr);
  const idx = keys.indexOf(wallet);
  let solDelta = idx >= 0 ? (Number(meta.postBalances[idx]) - Number(meta.preBalances[idx])) / LAMPORTS : 0;
  solDelta += tokSum(meta.postTokenBalances, SOL_MINT) - tokSum(meta.preTokenBalances, SOL_MINT);
  if (!(solDelta > 0)) return []; // SOL didn't net-enter the wallet — not a sell tx
  const got = solDelta;
  const mints = new Set();
  for (const b of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) if (b && b.mint && b.mint !== SOL_MINT) mints.add(b.mint);
  const sells = [];
  for (const mint of mints) {
    const d = tokSum(meta.preTokenBalances, mint) - tokSum(meta.postTokenBalances, mint);
    if (d > 0) sells.push({ mint, sol: got });
  }
  return sells;
}

export class FlowWatch {
  /**
   * deps: { cfg, onTrigger(mint, agg), now, rpcFn(method, params), log }
   * agg: { wallets: [addr...], maxSol, count, kind: 'solo'|'size'|'confluence', label }
   */
  constructor({ cfg, onTrigger, now = Date.now, rpcFn = null, log = console.log }) {
    this.cfg = cfg;
    this.onTrigger = onTrigger || (() => {});
    this.now = now;
    this.log = log;
    this.rpcFn = rpcFn || ((m, p) => flowRpc(cfg.rpcUrls, m, p));
    this.wallets = [...new Set([...(cfg.flowWallets || []), ...(cfg.flowSoloWallets || [])])];
    this.solo = new Set(cfg.flowSoloWallets || []);
    this.lastSig = new Map();  // wallet -> newest signature already seen (watermark)
    this.seenSigs = new Set(); // every processed signature (scroll-off guard)
    this.buys = [];            // recent buys { wallet, mint, sol, ts }
    this.timer = null;
    this.polling = false;
  }

  get active() {
    return !!(this.cfg.flowEnabled && this.wallets.length && this.cfg.rpcUrls && this.cfg.rpcUrls.length);
  }

  nameFor(wallet) {
    const named = this.cfg.flowNames && this.cfg.flowNames[wallet];
    return named || shortAddr(wallet);
  }

  start() {
    if (!this.active || this.timer) return;
    this.timer = setInterval(() => { this.poll().catch(e => this.log(`[flow] poll failed: ${e && e.message}`)); }, this.cfg.flowPollSec * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async poll() {
    if (this.polling || !this.active) return;
    this.polling = true;
    try {
      for (const w of this.wallets) {
        try { await this.pollWallet(w); }
        catch (e) { this.log(`[flow] wallet ${shortAddr(w)} poll failed: ${e && e.message}`); }
      }
    } finally { this.polling = false; }
  }

  async pollWallet(wallet) {
    const sigs = await this.rpcFn('getSignaturesForAddress', [wallet, { limit: 25 }]);
    if (!Array.isArray(sigs) || !sigs.length) return;
    // First contact: adopt the newest signature as the watermark WITHOUT processing
    // history — flow fires on new buys, not on what a wallet did before boot.
    if (!this.lastSig.has(wallet)) { this.lastSig.set(wallet, sigs[0].signature); return; }
    const fresh = [];
    for (const s of sigs) {
      if (!s || !s.signature) continue;
      if (s.signature === this.lastSig.get(wallet)) break;
      if (!this.seenSigs.has(s.signature)) fresh.push(s);
    }
    if (sigs[0] && sigs[0].signature) this.lastSig.set(wallet, sigs[0].signature);
    for (const s of fresh.reverse()) { // oldest first, so buys land in time order
      this.seenSigs.add(s.signature);
      if (s.err) continue;
      let tx = null;
      try {
        tx = await this.rpcFn('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      } catch { tx = null; }
      if (!tx) continue;
      const ts = s.blockTime ? s.blockTime * 1000 : this.now();
      for (const b of parseWalletBuys(tx, wallet)) this.recordBuy({ wallet, mint: b.mint, sol: b.sol, ts });
    }
    if (this.seenSigs.size > 5000) this.seenSigs = new Set([...this.seenSigs].slice(-2000));
  }

  /** Record one observed buy and fire onTrigger if a trigger condition now holds. */
  recordBuy({ wallet, mint, sol, ts }) {
    if (!(sol >= FLOW_DUST_SOL)) return; // anti-dust floor on every trigger path
    const n = this.now();
    this.buys.push({ wallet, mint, sol, ts: ts || n });
    const horizon = this.cfg.flowWindowMin * 60000 * 2;
    this.buys = this.buys.filter(b => n - b.ts <= horizon);
    const trig = this.evaluate(mint, n);
    if (trig) this.onTrigger(mint, trig);
  }

  /** Pure trigger judgment over the buys currently inside the window for one mint. */
  evaluate(mint, n = this.now()) {
    const winMs = this.cfg.flowWindowMin * 60000;
    const recent = this.buys.filter(b => b.mint === mint && n - b.ts <= winMs);
    if (!recent.length) return null;
    const wallets = [...new Set(recent.map(b => b.wallet))];
    const maxSol = Math.max(...recent.map(b => b.sol));
    const base = { wallets, maxSol, count: wallets.length };
    // Firing-wallet attribution (2026-10-15, for the flow-exit watcher): the
    // specific wallet whose buy this trigger is — the qualifying buy for
    // solo/size; for confluence, the DECIDING buy (the most recent one in
    // the window: evaluate() runs right after recordBuy appends it, so the
    // newest buy is the one that completed the set).
    const stamp = (b) => ({ wallet: b.wallet, walletSol: b.sol, buyTs: b.ts || null });
    const soloBuy = recent.filter(b => this.solo.has(b.wallet)).sort((a, b) => b.sol - a.sol)[0];
    if (soloBuy) return { ...base, kind: 'solo', ...stamp(soloBuy), label: `flow: ${this.nameFor(soloBuy.wallet)} bought ${soloBuy.sol.toFixed(2)} SOL` };
    const big = recent.filter(b => b.sol >= this.cfg.flowMinSol).sort((a, b) => b.sol - a.sol)[0];
    if (big) return { ...base, kind: 'size', ...stamp(big), label: `flow: ${this.nameFor(big.wallet)} bought ${big.sol.toFixed(2)} SOL` };
    if (wallets.length >= this.cfg.flowWalletsConfl) {
      const deciding = recent.reduce((a, b) => ((b.ts || 0) >= (a.ts || 0) ? b : a));
      return { ...base, kind: 'confluence', ...stamp(deciding), label: `flow: ${wallets.length} tracked wallets bought within ${this.cfg.flowWindowMin}m (max ${maxSol.toFixed(2)} SOL)` };
    }
    return null;
  }
}
