// curveChain.js — the instant-graduation gate's missing evidence.
//
// DexScreener zeroes a coin's bonding-curve pair the moment it graduates (0 buys / 0 sells
// forever), so the gate read "curve history unknown" and waved every graduated coin
// through — CPU and discat (2026-10-12) both bonded in a handful of buys and bled
// through it. The curve's true history is immutable on-chain: every curve interaction
// touches the bonding-curve PDA, so count the buy transactions there directly.
//
// A "buy" here = a successful curve transaction containing at least one Pump buy
// instruction — the same unit DexScreener's txns count and pump.fun's trade feed use.
// Bundled launches pack several buy INSTRUCTIONS per transaction (discat: 13 buys in
// 3 txs, one second, then MigrateV2) — buyIxs is kept alongside for the report reason.

import { createHash } from 'node:crypto';
import { fetchJson } from './util.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const disc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
export const BUY_DISCS = new Set(['buy', 'buy_exact_sol_in', 'buy_exact_quote_in', 'buy_v3'].map(disc));
export const SELL_DISCS = new Set(['sell', 'sell_exact_quote', 'sell_v3'].map(disc));

const keyStr = (k) => (typeof k === 'string' ? k : (k && k.pubkey) || '');

/** Classify one raw getTransaction (json encoding) result: pump buy/sell instruction counts. */
export function classifyTx(tx, bs58decode) {
  const out = { buyIxs: 0, sellIxs: 0 };
  if (!tx || !tx.transaction || !tx.transaction.message) return out;
  const msg = tx.transaction.message;
  const meta = tx.meta || {};
  const loaded = meta.loadedAddresses || {};
  const keys = [...(msg.accountKeys || []).map(keyStr), ...(loaded.writable || []), ...(loaded.readonly || [])];
  const scan = (ixs) => {
    for (const ix of ixs || []) {
      const pid = ix.programId || keys[ix.programIdIndex];
      if (pid !== PUMP_PROGRAM || !ix.data) continue;
      let hex = '';
      try { hex = Buffer.from(bs58decode(ix.data)).toString('hex').slice(0, 16); } catch { continue; }
      if (BUY_DISCS.has(hex)) out.buyIxs++;
      else if (SELL_DISCS.has(hex)) out.sellIxs++;
    }
  };
  scan(msg.instructions);
  for (const inner of meta.innerInstructions || []) scan(inner.instructions);
  return out;
}

/** Pure counting over classified txs (oldest first). */
export function countCurveHistory(classified) {
  let buys = 0, buyIxs = 0, sells = 0;
  for (const c of classified || []) {
    if (!c || c.err) continue;
    if (c.buyIxs > 0) { buys++; buyIxs += c.buyIxs; }
    if (c.sellIxs > 0) sells++;
  }
  return { buys, buyIxs, sells };
}

async function rpc(rpcUrls, method, params, timeout = 12000) {
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

const cache = new Map(); // mint -> completed scan (curve history never changes after graduation)

/**
 * Count a graduated coin's true curve buys from chain history.
 * Returns { buys, buyIxs, sells, source: 'chain' } or null when undeterminable
 * (RPC down, too many signatures to scan, deadline hit) — callers fall back to
 * the pre-existing fail-open behavior rather than blocking on missing evidence.
 */
export async function fetchChainCurveHistory(mint, { rpcUrls, maxBuys = 5, maxSigs = 150, deadlineMs = 9000 } = {}) {
  if (!mint || !rpcUrls || !rpcUrls.length) return null;
  if (cache.has(mint)) return cache.get(mint);
  const t0 = Date.now();
  try {
    const [{ PublicKey }, bs58mod] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
    const decode = bs58mod.decode || (bs58mod.default && bs58mod.default.decode);
    const [curve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
      new PublicKey(PUMP_PROGRAM),
    );
    const sigs = await rpc(rpcUrls, 'getSignaturesForAddress', [curve.toBase58(), { limit: 1000 }]);
    if (!Array.isArray(sigs)) return null;
    if (sigs.length > maxSigs) {
      // More curve interactions than any ≤5-buy launch can produce in practice;
      // the count floor alone clears the gate. (buys ≤ sigs, and a coin with 150+
      // curve txs was not filled by 5 buy txs in any realistic pattern.)
      const r = { buys: sigs.length, buyIxs: 0, sells: 0, source: 'chain' };
      cache.set(mint, r);
      return r;
    }
    const ok = sigs.filter(s => s && !s.err).reverse(); // oldest first
    const classified = [];
    let complete = true;
    for (let i = 0; i < ok.length; i += 10) {
      if (Date.now() - t0 > deadlineMs) { complete = false; break; }
      const batch = ok.slice(i, i + 10);
      const txs = await Promise.all(batch.map(s =>
        rpc(rpcUrls, 'getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }]).catch(() => null),
      ));
      for (const tx of txs) classified.push(tx ? { err: false, ...classifyTx(tx, decode) } : { err: true, buyIxs: 0, sellIxs: 0 });
      // Early exit: once buy txs exceed the gate's line the verdict cannot change.
      if (countCurveHistory(classified).buys > maxBuys) break;
    }
    const r = { ...countCurveHistory(classified), source: 'chain' };
    // A partial scan under the line is NOT evidence — the unscanned tail could hold
    // more buys. Only a complete scan, or a partial already over the line (counts
    // only grow), may speak.
    if (!complete && r.buys <= maxBuys) return null;
    if (r.buys > 0) cache.set(mint, r);
    return r;
  } catch {
    return null;
  }
}
