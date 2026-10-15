// flowExits.js — Flow-Exit Watcher (user 2026-10-15, RECORD-ONLY).
//
// Flow signals (flowWatch.js) fire when tracked smart wallets BUY; when such
// a signal is taken, the bot enters — and never looks at the triggering
// wallet again. This watcher answers the question the user actually trades
// on: "did the wallet that took us in already leave — and would leaving with
// them have beaten our own exit stack?" For every flow-triggered position it
// polls the trigger wallet's token balance for the mint (~60s), journals the
// wallet's first big trim and its exit to flow_exits.jsonl, and at the bot's
// close writes a final record scoring the race: who got out first, and —
// when the wallet won — the SOL delta between the bot's realizable mark at
// the wallet-exit moment and what the bot actually banked for that remainder
// by its real close (deltaSol; positive = following the wallet out would
// have made MORE).
//
// HARD BOUNDARIES: strictly record-only. No trading decision reads this
// module's state; it never buys, sells, signs or posts. Every public method
// is fail-silent — a watcher failure (RPC down, torn file, anything) can
// never reach a trading path. Balance reads reuse flowWatch's RPC helper
// (getTokenAccountsByOwner for an arbitrary owner, the same read the bot's
// own balance checks use).
//
// Detection honesty: the baseline is the PEAK OBSERVED balance. A trim the
// wallet made before our first successful read is invisible — the first
// read IS the baseline — so a wallet that dumps within seconds of its buy
// (before the bot even fills) reads as an immediate exit only when the
// balance is already ~zero; a partial pre-read trim silently lowers the
// baseline. Likewise, at close, a final read ≤5% with NO journaled exit
// event is 'unknown-at-close', never 'exited-first': the read cannot prove
// the wallet beat the bot out (it may have sold inside the last poll gap),
// and only a journaled event earns a deltaSol.
import fs from 'node:fs';
import { median, round } from './util.js';
import { flowRpc, shortAddr } from './flowWatch.js';

export const FLOWEXIT_POLL_MS = 60000;   // balance poll cadence per watched position
export const FLOWEXIT_TRIM_FRAC = 0.50;  // balance ≤ 50% of peak baseline → trim event
export const FLOWEXIT_EXIT_FRAC = 0.05;  // balance ≤ 5% of peak baseline (or gone) → exit event
const CARD_CACHE_MS = 60000;

// ---------- pure trigger resolution (tested directly) ----------

/** Resolve the specific wallet whose buy triggered a taken flow signal.
 *  Sources, strongest first: sig.metrics.wallet (the firing wallet stamped
 *  by FlowWatch.evaluate since 2026-10-15), a lone metrics.wallets entry,
 *  then the label's named wallet ("flow: yenni bought 9.03 SOL") reversed
 *  through cfg.flowNames. Returns { wallet, name, sol, buyTs, kind } or
 *  null when the trigger cannot be attributed — the caller skips the
 *  position silently. */
export function resolveTrigger(cfg = {}, sig = {}) {
  const m = (sig && sig.metrics) || {};
  const names = (cfg && cfg.flowNames) || {};
  let wallet = m.wallet || null;
  if (!wallet && Array.isArray(m.wallets) && m.wallets.length === 1) wallet = m.wallets[0];
  let sol = m.walletSol != null ? m.walletSol : (m.maxSol != null ? m.maxSol : null);
  const buyTs = m.buyTs || null;
  if ((!wallet || sol == null) && sig && sig.label) {
    const lm = /^flow: (.+?) bought ([\d.]+) SOL/.exec(String(sig.label));
    if (lm) {
      if (!wallet) {
        const byName = Object.entries(names).find(([, nm]) => nm === lm[1]);
        if (byName) wallet = byName[0];
      }
      if (wallet && sol == null) sol = Number(lm[2]);
    }
  }
  if (!wallet) return null;
  return { wallet, name: names[wallet] || shortAddr(wallet), sol, buyTs, kind: m.kind || null };
}

// ---------- pure scorecard (tested directly) ----------

/** Fold raw journal lines into per-position { start, trim, exit, final }
 *  (first record of each type wins — the watcher claims before it writes,
 *  so a duplicate line can only be a torn-write artifact). */
export function foldFlowExitJournal(records) {
  const byId = new Map();
  for (const r of records || []) {
    if (!r || !r.id || !r.type) continue;
    let e = byId.get(r.id);
    if (!e) { e = { start: null, trim: null, exit: null, final: null }; byId.set(r.id, e); }
    if (r.type === 'start' && !e.start) e.start = r;
    else if (r.type === 'trim' && !e.trim) e.trim = r;
    else if (r.type === 'exit' && !e.exit) e.exit = r;
    else if (r.type === 'final' && !e.final) e.final = r;
  }
  return byId;
}

export function buildFlowExitCard(records) {
  const byId = foldFlowExitJournal(records);
  const entries = [...byId.values()].filter(e => e.start);
  const finals = entries.filter(e => e.final).map(e => e.final);
  const wf = entries.filter(e => e.final && e.final.walletState === 'exited-first');
  const holdSecs = wf.map(e => (e.exit && e.start ? (e.exit.ts - (e.start.triggerBuyTs || e.start.entryTs)) / 1000 : null)).filter(Number.isFinite);
  const wfPnl = wf.map(e => e.final.pnlSol).filter(Number.isFinite);
  const deltas = finals.map(f => f.deltaSol).filter(Number.isFinite);
  const evs = [];
  for (const e of entries) { if (e.trim) evs.push({ e, rec: e.trim }); if (e.exit) evs.push({ e, rec: e.exit }); }
  const recent = evs.sort((a, b) => b.rec.ts - a.rec.ts).slice(0, 12).map(({ e, rec }) => ({
    ts: rec.ts,
    symbol: rec.symbol != null ? rec.symbol : (e.start ? e.start.symbol : null),
    wallet: rec.walletName != null ? rec.walletName : (e.start ? e.start.walletName : null),
    kind: rec.type,
    heldSec: e.start ? Math.round((rec.ts - (e.start.triggerBuyTs || e.start.entryTs)) / 1000) : null,
    remainingFrac: rec.remainingFrac != null ? rec.remainingFrac : null,
    botMovePct: rec.botMovePct != null ? rec.botMovePct : null,
    botPeakPct: rec.botPeakPct != null ? rec.botPeakPct : null,
    botOpen: !e.final,
    botPnlSol: e.final ? (e.final.pnlSol != null ? e.final.pnlSol : null) : null,
    deltaSol: e.final ? (e.final.deltaSol != null ? e.final.deltaSol : null) : null,
  }));
  return {
    watched: entries.length,
    watching: entries.length - finals.length,
    events: evs.length,
    walletFirst: { n: wf.length, share: finals.length ? round(wf.length / finals.length) : null },
    medianWalletHoldSec: holdSecs.length ? Math.round(median(holdSecs)) : null,
    botPnlWalletFirst: {
      n: wfPnl.length,
      totalSol: wfPnl.length ? round(wfPnl.reduce((a, b) => a + b, 0), 6) : null,
      medianSol: wfPnl.length ? round(median(wfPnl), 6) : null,
    },
    counterfactual: {
      n: deltas.length,
      totalDeltaSol: deltas.length ? round(deltas.reduce((a, b) => a + b, 0), 6) : null,
      medianDeltaSol: deltas.length ? round(median(deltas), 6) : null,
    },
    ready: wf.length >= 10,
    recent,
  };
}

// ---------- default balance read (injectable for tests) ----------

/** The trigger wallet's total balance of `mint` across its token accounts
 *  (uiAmount). An empty account list reads 0 — the account being gone IS a
 *  zero balance. Throws when every RPC fails; callers treat that as "no
 *  read this tick", never as a zero. */
async function defaultFetchBalance(cfg, owner, mint) {
  if (!cfg.rpcUrls || !cfg.rpcUrls.length) return null;
  const res = await flowRpc(cfg.rpcUrls, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const value = (res && res.value) || [];
  let total = 0;
  for (const a of value) {
    const info = a && a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
    const ui = info && info.tokenAmount ? Number(info.tokenAmount.uiAmount) : NaN;
    if (Number.isFinite(ui)) total += ui;
  }
  return total;
}

// ---------- the watcher ----------

export class FlowExits {
  /**
   * deps: { cfg, journal, now, fetchBalance(owner, mint) -> uiAmount|null,
   *         positionState(id) -> { open, movePct, peakPct, markSol,
   *         bankedSol, botRemainingFrac } | null, log }
   * positionState is the Bot's own mark feed (the same realizable-move
   * measure the exit stack judges); the watcher never computes prices.
   */
  constructor({ cfg = {}, journal = null, now = () => Date.now(), fetchBalance = null, positionState = null, log = null } = {}) {
    this.cfg = cfg;
    this.journal = journal;
    this.now = now;
    this.fetchBalance = fetchBalance || ((owner, mint) => defaultFetchBalance(this.cfg, owner, mint));
    this.positionState = positionState;
    this.log = log;
    this.watches = new Map();   // id -> live watch state
    this.starts = new Map();    // id -> start record (journal-derived)
    this.finals = new Set();    // ids with a final record
    this.trimFired = new Set(); // journal-derived dedupe — rebuilt at boot
    this.exitFired = new Set();
    this.exitRecs = new Map();  // id -> exit event record
    this.trimRecs = new Map();  // id -> trim event record (peak reconstruction)
    this.lastTick = 0;
    this.cardCache = null;
    this.cardCacheTs = 0;
    this._restore();
  }

  _file() { return this.journal && this.journal.f ? this.journal.f.fexit : null; }

  _readAll() {
    const f = this._file();
    if (!f) return [];
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn tail line — skip */ }
    }
    return out;
  }

  _append(rec) { try { if (this.journal) this.journal.flowExit(rec); } catch { /* record-only */ } }

  _restore() {
    for (const r of this._readAll()) {
      if (!r || !r.id) continue;
      if (r.type === 'start' && !this.starts.has(r.id)) this.starts.set(r.id, r);
      else if (r.type === 'trim') { this.trimFired.add(r.id); if (!this.trimRecs.has(r.id)) this.trimRecs.set(r.id, r); }
      else if (r.type === 'exit') { this.exitFired.add(r.id); if (!this.exitRecs.has(r.id)) this.exitRecs.set(r.id, r); }
      else if (r.type === 'final') this.finals.add(r.id);
    }
  }

  _watchFromStart(startRec) {
    const trim = this.trimRecs.get(startRec.id) || null;
    // Peak reconstruction across a restart: the trim event stored both the
    // balance and the fraction, so the pre-restart peak is recoverable
    // exactly. With no trim on record the balance never crossed 50% of the
    // old peak, and the first post-boot read simply re-baselines.
    const peakBal = trim && trim.remainingFrac > 0 && Number.isFinite(trim.balance) ? trim.balance / trim.remainingFrac : null;
    return {
      rec: startRec, peakBal,
      trimFired: this.trimFired.has(startRec.id),
      exitFired: this.exitFired.has(startRec.id),
      exitRec: this.exitRecs.get(startRec.id) || null,
      finalizing: false,
    };
  }

  /** Re-establish watches for positions open at boot (Bot calls this once
   *  from its constructor). Only positions with a journaled start record
   *  can be re-watched — their trigger attribution lives in that record. */
  restore(openPositions) {
    try {
      for (const pos of openPositions || []) {
        if (!pos || pos.setup !== 'flow' || this.watches.has(pos.id)) continue;
        const startRec = this.starts.get(pos.id);
        if (!startRec || this.finals.has(pos.id)) continue;
        this.watches.set(pos.id, this._watchFromStart(startRec));
      }
    } catch { /* record-only */ }
  }

  /** Begin watching a freshly opened flow-triggered position. Synchronous
   *  claim (watch state + journal start land before any await) so a second
   *  call for the same position can never double-start. Returns the start
   *  record, or null when the trigger wallet is unresolvable (skipped
   *  silently, per spec) or the position is not flow-triggered. */
  start(pos, sig) {
    try {
      if (!pos || !sig || sig.setup !== 'flow') return null;
      if (this.watches.has(pos.id)) return null;
      if (this.starts.has(pos.id)) {
        // Already journaled (a restart raced a re-entry seam): adopt the
        // existing record instead of writing a second start.
        if (!this.finals.has(pos.id)) this.watches.set(pos.id, this._watchFromStart(this.starts.get(pos.id)));
        return null;
      }
      const trig = resolveTrigger(this.cfg, sig);
      if (!trig) return null;
      const ts = this.now();
      const rec = {
        type: 'start', id: pos.id, ts, mint: pos.mint, symbol: pos.symbol || null,
        wallet: trig.wallet, walletName: trig.name, kind: trig.kind,
        triggerSol: trig.sol, triggerBuyTs: trig.buyTs,
        entryTs: pos.entryTs || ts, entrySol: pos.entrySol != null ? pos.entrySol : null,
      };
      this.starts.set(pos.id, rec);
      const w = { rec, peakBal: null, trimFired: false, exitFired: false, exitRec: null, finalizing: false };
      this.watches.set(pos.id, w);
      this._append(rec);
      if (this.log) this.log(`[flowexits] watching ${rec.symbol}: trigger wallet ${rec.walletName} (${rec.triggerSol != null ? rec.triggerSol.toFixed(2) + ' SOL' : 'size unknown'}) — record only`);
      // First read immediately (fire-and-forget): the baseline should be set
      // as close to the wallet's buy as possible, before any trim lands.
      this._pollOne(w, ts).catch(() => {});
      return rec;
    } catch { return null; }
  }

  /** Poll pass — rides the bot's poll tick, self-throttled to ~60s,
   *  fail-silent throughout. */
  async tick(n = this.now()) {
    try {
      if (n - this.lastTick < FLOWEXIT_POLL_MS) return;
      this.lastTick = n;
      for (const w of [...this.watches.values()]) {
        if (w.finalizing) continue;
        // Hygiene: a watched id whose position vanished without the close
        // funnel finalizing us (ensureClose is the single funnel, so this
        // should never happen) stops being polled instead of leaking RPC.
        let st = null;
        try { st = this.positionState ? this.positionState(w.rec.id) : null; } catch { st = null; }
        if (st && st.open === false) { this.watches.delete(w.rec.id); continue; }
        await this._pollOne(w, n).catch(() => {});
      }
    } catch { /* shadow watcher — fail silent */ }
  }

  async _pollOne(w, n) {
    if (w.finalizing) return;
    let bal = null;
    try { bal = await this.fetchBalance(w.rec.wallet, w.rec.mint); } catch { bal = null; }
    if (bal == null || !Number.isFinite(bal) || bal < 0) return; // failed read — skip the tick silently
    if (w.peakBal == null) {
      // FIRST successful read. Zero means the wallet already left (it
      // provably held the mint at its buy, which precedes our entry) —
      // journal the exit now. A positive read IS the baseline: whatever it
      // trimmed before this moment is invisible by construction.
      if (bal <= 0) { w.peakBal = 0; this._fire(w, 'exit', n, 0, bal, true); }
      else w.peakBal = bal;
      return;
    }
    if (bal > w.peakBal) w.peakBal = bal; // an add raises the baseline; adds are never journaled
    const frac = w.peakBal > 0 ? bal / w.peakBal : 0;
    // Exit is judged before trim: a plunge straight through both thresholds
    // is an exit, not a trim.
    if (!w.exitFired && frac <= FLOWEXIT_EXIT_FRAC) { this._fire(w, 'exit', n, frac, bal, false); return; }
    if (!w.trimFired && frac <= FLOWEXIT_TRIM_FRAC) this._fire(w, 'trim', n, frac, bal, false);
  }

  _fire(w, kind, n, frac, bal, firstRead) {
    // Claim in the dedupe sets BEFORE journaling — the claim is the dedupe.
    if (kind === 'trim') { if (w.trimFired) return null; w.trimFired = true; this.trimFired.add(w.rec.id); }
    if (kind === 'exit') { if (w.exitFired) return null; w.exitFired = true; this.exitFired.add(w.rec.id); }
    let st = null;
    try { st = this.positionState ? this.positionState(w.rec.id) : null; } catch { st = null; }
    const rec = {
      type: kind, id: w.rec.id, ts: n, mint: w.rec.mint, symbol: w.rec.symbol,
      wallet: w.rec.wallet, walletName: w.rec.walletName,
      remainingFrac: round(frac), balance: bal, peakBalance: w.peakBal, firstRead: !!firstRead,
      botMovePct: st && st.movePct != null ? st.movePct : null,
      botPeakPct: st && st.peakPct != null ? st.peakPct : null,
      markSol: st && st.markSol != null ? st.markSol : null,
      bankedSol: st && st.bankedSol != null ? st.bankedSol : null,
      botRemainingFrac: st && st.botRemainingFrac != null ? st.botRemainingFrac : null,
    };
    this._append(rec);
    if (kind === 'trim') this.trimRecs.set(w.rec.id, rec);
    if (kind === 'exit') { w.exitRec = rec; this.exitRecs.set(w.rec.id, rec); }
    if (this.log) this.log(`[flowexits] ${w.rec.symbol}: trigger wallet ${w.rec.walletName} ${kind === 'exit' ? 'EXITED' : 'trimmed'} (${(frac * 100).toFixed(0)}% of peak balance left) — record only`);
    return rec;
  }

  /** Close the watch at the bot's close funnel (ensureClose). One last
   *  balance read classifies the wallet's end state; the delta is computed
   *  ONLY for a journaled exit-first (see the honesty note at the top).
   *  close: { ts, reason, pnlSol, entrySol, exitSol, feesSol } from the
   *  funnel's full close record. Fire-and-forget safe; never throws. */
  async finalize(pos, close = {}) {
    try {
      const w = this.watches.get(pos.id);
      if (!w || w.finalizing) return null;
      w.finalizing = true;
      let finalBal = null, readOk = false;
      try {
        finalBal = await this.fetchBalance(w.rec.wallet, w.rec.mint);
        readOk = finalBal != null && Number.isFinite(finalBal) && finalBal >= 0;
      } catch { readOk = false; }
      let walletState, deltaSol = null;
      if (w.exitFired && w.exitRec) {
        walletState = 'exited-first';
        // deltaSol — the counterfactual, on the REMAINING position only:
        // markSol (snapshotted on the exit event) is what the remainder was
        // realizable for at the wallet-exit moment; the bot's actual take
        // for that same remainder is its total close proceeds minus what it
        // had already banked BEFORE the wallet left (bankedSol, also on the
        // exit event). Total proceeds = the close record's exitSol when the
        // exec layer provided it, else entrySol + pnlSol + feesSol (the
        // funnel's own identity: pnl = proceeds − entry − burned fees).
        const totalProceeds = close.exitSol != null ? close.exitSol
          : (close.pnlSol != null && close.entrySol != null ? close.entrySol + close.pnlSol + (close.feesSol || 0) : null);
        if (totalProceeds != null && w.exitRec.markSol != null && w.exitRec.bankedSol != null) {
          deltaSol = round(w.exitRec.markSol - (totalProceeds - w.exitRec.bankedSol), 6);
        }
      } else if (!readOk || w.peakBal == null) {
        walletState = 'unknown';
      } else {
        const frac = w.peakBal > 0 ? finalBal / w.peakBal : 0;
        walletState = frac > FLOWEXIT_EXIT_FRAC ? 'held-through' : 'unknown-at-close';
      }
      const rec = {
        type: 'final', id: pos.id, ts: close.ts || this.now(), mint: w.rec.mint, symbol: w.rec.symbol,
        wallet: w.rec.wallet, walletName: w.rec.walletName,
        reason: close.reason != null ? close.reason : null,
        pnlSol: close.pnlSol != null ? close.pnlSol : null,
        walletState, walletExitTs: w.exitRec ? w.exitRec.ts : null, deltaSol,
      };
      this._append(rec);
      this.finals.add(pos.id);
      this.watches.delete(pos.id);
      if (this.log) this.log(`[flowexits] ${w.rec.symbol}: closed — wallet ${walletState}${deltaSol != null ? `, exiting with the wallet would have differed by ${deltaSol >= 0 ? '+' : ''}${deltaSol.toFixed(4)} SOL` : ''} (record only)`);
      return rec;
    } catch { return null; }
  }

  /** GET /flowexits payload. Computed from the FULL journal file (never a
   *  capped tail — readiness spans weeks of flow entries), ~60s cache. */
  scorecard() {
    const n = this.now();
    if (this.cardCache && n - this.cardCacheTs < CARD_CACHE_MS) return this.cardCache;
    const records = this._readAll();
    const card = { enabled: true, generatedTs: n, journalRecords: records.length, ...buildFlowExitCard(records) };
    this.cardCache = card;
    this.cardCacheTs = n;
    return card;
  }
}
