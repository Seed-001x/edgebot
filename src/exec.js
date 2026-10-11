// exec.js — swaps via Jupiter. Two modes behind ONE interface:
//   shadow : live Jupiter quotes, simulated fills, nothing is signed or sent.
//   real   : signs with WALLET_PRIVATE_KEY and broadcasts through RPC_URLS.
//
// Safety properties:
//  - The key is read from the environment only, lazily, only in real mode; never logged or returned.
//  - roundTrip() prices an immediate sell-back BEFORE any buy. If the sell-back is worth less than
//    cfg.minRoundTrip of the spend (thin pool, heavy impact, transfer tax, honeypot) the trade is refused.
//  - Exits are judged on markValue() = a live Jupiter SELL quote (what you could actually get), not screen price.
//  - Any error → throws; the caller treats that as "no trade". No partial state is recorded on failure.

import { fetchJson, SOL_MINT, LAMPORTS, sleep } from './util.js';

const toLamports = (sol) => BigInt(Math.floor(sol * LAMPORTS));

export class Executor {
  /**
   * @param cfg   config
   * @param hooks optional injection for tests: { quote, rpc, send, env }
   */
  constructor(cfg, hooks = {}) {
    this.cfg = cfg;
    this.real = !!cfg.realMode;
    this.quoteFn = hooks.quote || ((i, o, a, bps) => this.jupQuote(i, o, a, bps));
    this.rpcFn = hooks.rpc || ((m, p) => this.rpc(m, p));
    this.sendFn = hooks.send || ((b64) => this.sendRaw(b64));
    this.env = hooks.env || process.env;
    this._kp = null;
    this.shadowSol = cfg.shadowStartSol;
  }

  // ------------------------------------------------------------ wallet
  async keypair() {
    if (this._kp) return this._kp;
    const raw = (this.env.WALLET_PRIVATE_KEY || '').trim();
    if (!raw) throw new Error('WALLET_PRIVATE_KEY not set');
    const [{ Keypair }, bs58mod] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
    const bs58 = bs58mod.default || bs58mod;
    try { this._kp = Keypair.fromSecretKey(bs58.decode(raw)); }
    catch { throw new Error('WALLET_PRIVATE_KEY is not a valid base58 secret key'); }
    return this._kp;
  }
  // top-20 token accounts for a mint: { [tokenAccount]: rawAmount } (read-only RPC; works in shadow mode too)
  async largestAccounts(mint) {
    const r = await this.rpcFn('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    const out = {};
    for (const a of (r && r.value) || []) out[a.address] = Number(a.amount);
    return out;
  }

  // raw balance of `mint` held by an arbitrary owner (read-only; used for the creator wallet)
  async ownerBalance(owner, mint) {
    const r = await this.rpcFn('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let total = 0;
    for (const a of (r && r.value) || []) { const t = a.account?.data?.parsed?.info?.tokenAmount; if (t && t.amount) total += Number(t.amount); }
    return total;
  }

  async address() { return this.real ? (await this.keypair()).publicKey.toBase58() : 'shadow'; }

  async solBalance() {
    if (!this.real) return this.shadowSol;
    const pub = await this.address();
    const r = await this.rpcFn('getBalance', [pub, { commitment: 'confirmed' }]);
    return Number(r && r.value) / LAMPORTS;
  }

  async tokenBalance(mint) {
    if (!this.real) return null; // shadow positions track their own balance
    const pub = await this.address();
    const r = await this.rpcFn('getTokenAccountsByOwner', [pub, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let total = 0n;
    for (const a of (r && r.value) || []) {
      const amt = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info && a.account.data.parsed.info.tokenAmount;
      if (amt && amt.amount) total += BigInt(amt.amount);
    }
    return total;
  }

  // ------------------------------------------------------------ Jupiter
  async jupQuote(inputMint, outputMint, amount, slippageBps) {
    const headers = this.cfg.jupApiKey ? { 'x-api-key': this.cfg.jupApiKey } : {};
    const u = `${this.cfg.jupBase}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const q = await fetchJson(u, { timeout: 12000, headers, throwOnError: true });
        if (!q || !q.outAmount) throw new Error('no route');
        return q;
      } catch (e) { last = e; await sleep(400 * (i + 1)); }
    }
    throw new Error('jupiter quote failed: ' + (last && last.message));
  }

  async jupSwapTx(quote, userPublicKey) {
    const headers = this.cfg.jupApiKey ? { 'x-api-key': this.cfg.jupApiKey } : {};
    const j = await fetchJson(`${this.cfg.jupBase}/swap`, {
      method: 'POST', timeout: 20000, headers, throwOnError: true,
      body: { quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: this.cfg.priorityFeeLamports },
    });
    if (!j || !j.swapTransaction) throw new Error('jupiter: no swap transaction');
    return j.swapTransaction;
  }

  // ------------------------------------------------------------ RPC
  async rpc(method, params, timeout = 15000) {
    let last;
    for (const url of this.cfg.rpcUrls) {
      try {
        const j = await fetchJson(url, { method: 'POST', timeout, body: { jsonrpc: '2.0', id: 1, method, params }, throwOnError: true });
        if (j && j.error) throw new Error(j.error.message || 'rpc error');
        return j.result;
      } catch (e) { last = e; }
    }
    throw new Error(`rpc ${method} failed: ${last && last.message}`);
  }

  async sendRaw(b64) {
    return this.rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' }], 30000);
  }

  async confirm(sig, timeoutMs = 45000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await this.rpcFn('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
        const st = r && r.value && r.value[0];
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
          if (st.err) throw new Error('tx failed on-chain: ' + JSON.stringify(st.err));
          return true;
        }
      } catch (e) { if (String(e.message).startsWith('tx failed')) throw e; }
      await sleep(1500);
    }
    return false; // unknown — caller checks balances
  }

  async signAndSend(quote) {
    const kp = await this.keypair();
    const { VersionedTransaction } = await import('@solana/web3.js');
    const b64 = await this.jupSwapTx(quote, kp.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    tx.sign([kp]);
    const signed = Buffer.from(tx.serialize()).toString('base64');
    const sig = await this.sendFn(signed);
    const ok = await this.confirm(sig);
    return { sig, confirmed: ok };
  }

  // ------------------------------------------------------------ trading API
  /**
   * Price an immediate buy + sell-back. ratio = sell-back SOL / spent SOL.
   * Throws if either side has no route (treated as "do not trade").
   */
  async roundTrip(mint, sol) {
    const lam = toLamports(sol);
    const buy = await this.quoteFn(SOL_MINT, mint, lam.toString(), this.cfg.buyBps);
    const sell = await this.quoteFn(mint, SOL_MINT, String(buy.outAmount), this.cfg.sellBps);
    return {
      tokensOut: BigInt(buy.outAmount),
      solBack: Number(sell.outAmount) / LAMPORTS,
      ratio: Number(sell.outAmount) / Number(lam),
      impactPct: Number(buy.priceImpactPct || 0) * 100,
      buyQuote: buy,
    };
  }

  /** Live realizable value (SOL) of `tokensRaw` tokens. */
  async markValue(mint, tokensRaw) {
    const amt = BigInt(tokensRaw);
    if (amt <= 0n) return 0;
    const q = await this.quoteFn(mint, SOL_MINT, amt.toString(), this.cfg.sellBps);
    return Number(q.outAmount) / LAMPORTS;
  }

  async buy(mint, sol, preQuote = null) {
    const lam = toLamports(sol);
    const quote = preQuote || await this.quoteFn(SOL_MINT, mint, lam.toString(), this.cfg.buyBps);
    if (!this.real) {
      this.shadowSol -= sol;
      return { tokensRaw: String(quote.outAmount), solSpent: sol, sig: null, simulated: true };
    }
    const before = (await this.tokenBalance(mint)) || 0n;
    const { sig, confirmed } = await this.signAndSend(quote);
    let after = before;
    for (let i = 0; i < 5; i++) {
      after = (await this.tokenBalance(mint)) || 0n;
      if (after > before) break;
      await sleep(1500);
    }
    if (after <= before) throw new Error(`buy not confirmed (sig ${sig}, confirmed=${confirmed}) — no tokens received`);
    return { tokensRaw: (after - before).toString(), solSpent: sol, sig, simulated: false };
  }

  /** Sell up to `tokensRaw` (clamped to wallet balance in real mode). */
  async sell(mint, tokensRaw) {
    let amt = BigInt(tokensRaw);
    if (this.real) {
      const bal = (await this.tokenBalance(mint)) || 0n;
      if (bal < amt) amt = bal;
    }
    if (amt <= 0n) return { tokensSold: '0', solOut: 0, sig: null, simulated: !this.real };
    const quote = await this.quoteFn(mint, SOL_MINT, amt.toString(), this.cfg.sellBps);
    const solOut = Number(quote.outAmount) / LAMPORTS;
    if (!this.real) {
      this.shadowSol += solOut;
      return { tokensSold: amt.toString(), solOut, sig: null, simulated: true };
    }
    const { sig } = await this.signAndSend(quote);
    const after = (await this.tokenBalance(mint)) || 0n;
    const sold = BigInt(tokensRaw) > after ? BigInt(tokensRaw) - after : 0n; // trust chain over quote
    if (sold <= 0n) throw new Error(`sell not confirmed (sig ${sig})`);
    return { tokensSold: (sold < amt ? sold : amt).toString(), solOut, sig, simulated: false };
  }
}
