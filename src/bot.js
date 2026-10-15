// bot.js — orchestrator. All I/O comes in through `deps` so the whole loop is testable offline.
//
//   discoverTick : refresh the watchlist from every source (quota-based)
//   pollTick     : re-poll watchlist + open positions (10s), update history, run detectors, handle signals
//   positionTick : mark open positions by live SELL quote and apply exit rules
//
// Entry order (cheap → expensive, every skip is journaled with its reason):
//   detector → risk limits → gates (RugCheck) → round-trip quote → buy

import fs from 'node:fs';
import path from 'node:path';
import { History } from './history.js';
import { detect, detectChurn, detectLiftoff, eligible, fastPop, fastPopFloors } from './detect.js';
import { runGates, hasHardFail, tempRuleViolation, blockedNameWord, extensionCheck, freshHistoryCheck, flowSnapshotCheck, shallowDipCheck, summarizeGateChecks, holderSamples, foldLastTrades } from './gate.js';
import { computeSignalFields } from './signalFields.js';
import { evaluateExit } from './exits.js';
import { ShadowFlow, ratchetArmed, ratchetShadowFire } from './ratchetShadow.js';
import { bundleRisk, bundleDecision, pickTracked, linkedWeights, CREATOR_KEY } from './bundleWatch.js';
import { Journal } from './journal.js';
import { Risk } from './risk.js';
import { postCallout } from './callout.js';
import { CalloutLab } from './calloutLab.js';
import { FlowExits } from './flowExits.js';
import { StructureWatch } from './structureWatch.js';
import { snapshotFeatures, externalExit } from './learn.js';

import { PostExitTracker, PairedShadowExits } from './postExit.js';
import { ShadowTrades } from './shadowTrades.js';
import { WalletWatch } from './walletWatch.js';
import { buildTradeReport } from './reports.js';
import { configStamp } from './stamp.js';

export class Bot {
  /**
   * deps: { discover(cfg), fetchViews(mints), fetchSolUsd(), fetchRug(mint), exec, now }
   */
  constructor(cfg, deps) {
    this.cfg = cfg; this.d = deps; this.now = deps.now || Date.now;
    this.exec = deps.exec;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    this.history = new History();
    this.journal = new Journal(cfg.dataDir, { now: this.now });
    this.calloutLab = new CalloutLab({ cfg, journal: this.journal, now: this.now }); // Callout Shadow Lab (record-only): journals would-calls + scores them as a follower would have fared; can never post, sign, or trade
    this.flowExits = new FlowExits({ cfg, journal: this.journal, now: this.now, positionState: (id) => this._flowExitPosState(id), log: console.log }); // Flow-Exit Watcher (record-only): polls the wallet that triggered a flow entry for its trim/exit and scores the race at close; no decision reads it
    this.structureWatch = new StructureWatch({ cfg, journal: this.journal, now: this.now, fetchHolders: (mint) => this._dasHolderSample(mint), log: console.log }); // Structure Watch (record-only): seeds every signaled mint into an hours-long staircase + holder-series watch with would-enter marks at confirmed higher lows; holder reads ride the same knob-respecting DAS helper as gate sampling; no decision reads it
    this.journal.onStructureSignal = (rec) => { try { this.structureWatch.seed(rec); } catch { /* observer only — never disturb the signal path */ } }; // seeding seam: the Journal.signal() funnel (taken/skipped/shadow/flow alike)
    this.risk = new Risk(cfg, { dir: cfg.dataDir, now: this.now });
    this.closedIds = new Set(this.journal.trades.filter(t => t.type === 'close').map(t => t.id)); // journaling guarantee (ensureClose)
    for (const t of this.journal.trades) if (t.type === 'close' && t.mint) this.risk.seedClosed(t.mint, t.ts); // re-entry block survives restarts/deploys
    this.lastTrades = foldLastTrades(this.journal.trades); // ran-rebuy block: most recent closed trade per mint, rebuilt from the journal so trades closed before this deploy (e.g. BOOT, 2026-10-14) anchor the rule on its first boot; ensureClose keeps it current
    this.postExit = new PostExitTracker(cfg.dataDir, this.now); // 5-min post-exit price tracker (observer only)
    this.paired = new PairedShadowExits(cfg.dataDir, this.now); // D1: virtual would-be exits paired to manual exits (observer only)
    this.streamEvalAt = new Map(); // mint -> ts of last stream-judge evaluation (v2 throttle, mirrors fastEvalAt)
    this.shadowStreamState = new Map(); // shadow virtual id -> stream-judge state (kept Bot-side: the virtual's own serialized state stays untouched)
    this.shadowTrades = new ShadowTrades(cfg.dataDir, this.now, { // trade-grade shadow (record-only): virtual positions for gate-passing shadow signals, run through the real exit stack
      txFeeSol: cfg.txFeeSol,
      onTick: (s, move, ts) => this._onShadowVirtualTick(s, move, ts),   // stream judge fire-quality probes (record-only)
      onClose: (s, rec) => this._onShadowVirtualClose(s, rec),          // stream judge completion records (record-only)
    });
    this.walletWatch = new WalletWatch({ // wallet-task shadow detectors (record-only): dev launches + survivor confluence over the Phase 1–3 sets
      cfg, dir: cfg.dataDir, now: this.now,
      fetchViews: deps.fetchViews,
      shadowGates: (v, setup) => this.shadowGateRecord(v, { setup, metrics: {} }, this.now()),
      noteMint: (m, s) => this.noteMint(m, s),
      onEvent: (ev) => this.noteCalloutEvent(ev), // Callout Shadow Lab tap (record-only)
    });
    this.cfgStamp = configStamp(cfg); // D1: config version stamp carried by entries + closes (record-only)
    this.lastSolUsd = null; // last SOL/USD the position loop saw (feeds observer marks)
    this.watch = new Map();      // mint -> { ts, source }
    this.intakeCounts = {};      // source -> mints added via noteMint since the last discovery cycle (scan-record bookkeeping, record-only)
    this.outcomeSeenAt = new Map(); // mint -> ts the outcome tracker last got a view (observer bookkeeping only)
    this.lastOutcomeTickTs = 0;
    this.latest = new Map();     // mint -> latest view
    this.lastSignal = new Map(); // mint -> ts
    this.latestAt = new Map();   // mint -> ts of the latest view fetch
    this.streamBuf = new Map();  // mint -> recent stream trades (fast pop detection)
    this.fastEvalAt = new Map(); // mint -> ts of last fast-pop evaluation
    this.shadowFlow = new ShadowFlow(); // held mints' streamed flow for the shadow ratchet judge (record-only)
    this.churnPins = new Map(); // mint -> { at, until } basing watch: dumped coins stay watchlist-pinned past the normal TTL (churn detector)
    this.curveSeen = new Set(); // mints whose latest view was the pump.fun bonding-curve pair — graduation handoff watches for the flip to an AMM pair
    this.posFile = path.join(cfg.dataDir, 'positions.json');
    this.positions = this.loadPositions();
    this.busy = { discover: false, poll: false, pos: false };
    this.stats = { discoverTicks: 0, pollTicks: 0, positionTicks: 0, signals: 0, entries: 0, exits: 0, errors: 0, lastError: null, sourceCounts: {}, lastDiscoverTs: 0, lastPollTs: 0, closesSinceReport: 0, lastReportTs: 0, reportIndex: 0, tempRules: null, fastPop: { fires: 0 }, ratchetShadow: { wouldFire: 0, completed: 0 }, exitConfirm: { confirmed: 0, cancelled: 0 }, shadowSignals: {}, liveFeed: { connected: false, events: 0, added: 0, reconnects: 0, lastEventTs: 0, lastError: null } };
    this.statsFile = path.join(cfg.dataDir, 'stats.json');
    this.entryTimes = []; // timestamps of entries (for pace keeper)
    this.PACE_TARGET = 120; // target trades per hour (2 per min)
    this.mintsFile = path.join(cfg.dataDir, 'entered-mints.json');
    this.enteredMints = this.loadEnteredMints();
    this.loadStats();
    this._syncShadowStats(); // the tracker owns its cumulative totals (persisted with its pending state) — stats mirrors them
    // Flow-Exit Watcher: re-establish watches for flow positions that were
    // open across this restart (their start records carry the attribution;
    // fired trims/exits are rebuilt from the journal and never re-fire).
    try { this.flowExits.restore(this.positions); } catch { /* observer only */ }
  }

  // Trade-grade shadow report card for /state (record-only): maintained from
  // the tracker's own totals at open/complete time (constructor, the shadow
  // journal point, and both tick paths call this after ticking the tracker).
  _syncShadowStats() {
    try { if (this.shadowTrades) this.stats.shadowTrades = this.shadowTrades.totalsView(); } catch { /* observer only */ }
  }

  /** Stream-judge state for one shadow virtual (get-or-create). Lives Bot-side
   *  keyed by virtual id so ShadowTrades' persisted state shape is untouched. */
  _shadowStreamStateFor(id) {
    let st = this.shadowStreamState.get(id);
    if (!st) { st = { streamPeakMove: null, streamArmed: false, streamFired: false, streamFireTs: null, streamTrades: 0, entryPriceSol: null, mint: null, probe30: false, probe60: false }; this.shadowStreamState.set(id, st); }
    return st;
  }

  /**
   * ShadowTrades tick hook (record-only): fire-quality probes for a virtual
   * the stream judge would-fired — what did its mark move do at the first
   * ticks >= 30s / >= 60s after the fire? Same shape as the real positions'
   * probes in judgeRatchetShadow, on the virtual's own view-mark move.
   */
  _onShadowVirtualTick(s, move, ts) {
    try {
      const st = this.shadowStreamState.get(s.id);
      if (!st || !st.streamFired || !st.streamFireTs || move == null) return;
      for (const atSec of [30, 60]) {
        const key = atSec === 30 ? 'probe30' : 'probe60';
        if (st[key] || ts - st.streamFireTs < atSec * 1000) continue;
        st[key] = true;
        this.journal.ratchetShadow({ kind: 'fire-quality', source: 'shadow', id: s.id, ts, mint: s.mint, symbol: s.symbol, atSec, jupMove: +move.toFixed(4) });
      }
    } catch { /* observer only */ }
  }

  /**
   * ShadowTrades close hook (record-only): the stream judge's completion
   * record for a virtual it ever saw armed — the shadow-book mirror of the
   * real positions' ensureClose record, journaled separately (source
   * 'shadow') and never pooled with the real sample. tickFireTs/leadSec are
   * null by construction: a virtual has no tick judge — its own exit-stack
   * close (exitReason/pnlSol on the record) is what a stream fire is scored
   * against.
   */
  _onShadowVirtualClose(s, rec) {
    try {
      const st = this.shadowStreamState.get(s.id);
      if (st) this.shadowStreamState.delete(s.id);
      if (!this.cfg.ratchetShadow || !st || !(st.streamArmed || st.streamFired)) return;
      this.journal.ratchetShadow({ kind: 'closed', outcome: 'closed', source: 'shadow', id: s.id, ts: rec.exitTs || this.now(), mint: s.mint, symbol: s.symbol, setup: s.setup, exitReason: rec.exitReason ?? null, pnlSol: rec.pnlSol ?? null, streamWouldFire: !!st.streamFired, streamFireTs: st.streamFireTs ?? null, tickFireTs: null, leadSec: null, jupArmed: null, tickArmed: null, streamArmed: !!st.streamArmed, streamCovered: (st.streamTrades || 0) > 0, streamTrades: st.streamTrades || 0 });
      if (this.shadowFlow && !this.positions.some(p => p.mint === s.mint) && !(this.shadowTrades && this.shadowTrades.openVirtual(s.mint))) this.shadowFlow.drop(s.mint);
    } catch { /* observer only */ }
  }

  loadStats() {
    try { const s = JSON.parse(fs.readFileSync(this.statsFile, 'utf8')); Object.assign(this.stats, s); return; }
    catch { /* no saved stats */ }
    // Seed from journal history so dashboard isn't empty after first deploy with persistence
    try {
      if (this.journal) {
        this.stats.signals = this.journal.signals.length;
        this.stats.entries = this.journal.trades.filter(t => t.type === 'open').length;
        this.stats.exits = this.journal.trades.filter(t => t.type === 'close').length;
      }
    } catch {}
  }
  saveStats() { try { fs.writeFileSync(this.statsFile, JSON.stringify(this.stats)); } catch { /* best effort */ } }
  loadEnteredMints() { try { return new Set(JSON.parse(fs.readFileSync(this.mintsFile, 'utf8'))); } catch { return new Set(); } }
  saveEnteredMints() { try { fs.writeFileSync(this.mintsFile, JSON.stringify([...this.enteredMints])); } catch { /* best effort */ } }

  // Pace keeper: returns a relaxed cfg if we're behind the hourly target.
  // Never overrides user blacklists, RugCheck safety, or risk limits.
  paceCfg(n) {
    const hourAgo = n - 3600000;
    this.entryTimes = this.entryTimes.filter(t => t > hourAgo);
    const pace = this.entryTimes.length;
    // Entry-fixes A2 (user 2026-10-13): the pace relaxer is OFF unless PACE_RELAX=1 — gates
    // run at face value. The always-on loosening (liq/mc floors ×0.6–0.7, maxMc ×1.5) is what
    // let BORING's $9.2k liquidity pass a $15k floor (relaxed bar: $9k).
    if (!this.cfg.paceRelax) return { cfg: this.cfg, boosted: false, pace };
    const relaxed = { ...this.cfg };
    if (relaxed.minVolH1) relaxed.minVolH1 *= 0.6;
    if (relaxed.minLiqUsd) relaxed.minLiqUsd *= 0.6;
    if (relaxed.minHolders) relaxed.minHolders = Math.max(50, Math.floor(relaxed.minHolders * 0.6));
    if (relaxed.maxMc) relaxed.maxMc *= 1.5;
    if (relaxed.minMc) relaxed.minMc *= 0.7;
    return { cfg: relaxed, boosted: true, pace };
  }

  // ------------------------------------------------------------ persistence
  loadPositions() { try { return JSON.parse(fs.readFileSync(this.posFile, 'utf8')); } catch { return []; } }
  savePositions() { try { fs.writeFileSync(this.posFile, JSON.stringify(this.positions)); } catch { /* best effort */ } }
  halted() { try { return fs.existsSync(path.join(this.cfg.dataDir, 'HALT')); } catch { return false; } }
  err(where, e) { this.stats.errors++; this.stats.lastError = `${where}: ${e && e.message ? e.message : e}`; }

  // ------------------------------------------------------------ boot
  async start() {
    const sol = await this.exec.solBalance();
    this.risk.initEquity(sol);
    // real mode: drop positions whose tokens are no longer in the wallet (sold/transferred outside the bot)
    if (this.cfg.realMode) {
      for (const p of [...this.positions]) {
        try {
          const bal = await this.exec.tokenBalance(p.mint);
          if (bal === 0n) await this.closeExternal(p, 'reconcile: tokens no longer in wallet (manual sell)');
          else if (bal != null) p.tokensRaw = bal.toString();
        } catch (e) { this.err('reconcile', e); }
      }
      this.savePositions();
    }
    return { solBalance: sol, openPositions: this.positions.length };
  }

  // THE funnel for closing a position in the journal: every path that removes a position
  // (bot sell, manual exit, reconcile, admin clear) goes through here, so every open gets
  // exactly one close record. The DINU ghost — sold on-chain, never journaled, position
  // never cleared — is the bug this makes structurally impossible. Also registers the
  // post-exit tracker and the every-N-trades report counter. Returns false when this
  // position was already closed (double-log guard).
  ensureClose(pos, rec) {
    if (this.closedIds.has(pos.id)) return false;
    this.closedIds.add(pos.id);
    const full = { type: 'close', ...rec };
    // D1 (record-only): EVERY close carries the full decision record, whichever
    // path closed it. The entry snapshot used to survive only on manual exits —
    // bot-managed closes dropped it here, which is why /learn's bot-winner
    // comparison was empty by construction. An explicit value in `rec` always
    // wins; the funnel only fills what the caller didn't provide. Fields the
    // exec layer genuinely doesn't produce at record time are null, never
    // invented. `feesSol` is the accumulated BURNED tx-fee estimate, calibrated
    // on-chain (D2 + rent analysis, 2026-10-14): cfg.txFeeSol per transaction
    // actually incurred — one for the buy, one per executed sell — where
    // txFeeSol = 5,000 base + configured priority fee (parsed buy txs' meta.fee
    // was exactly that). The 0.001514 token-account deposit is never counted:
    // the closeEmptyAccounts sweep refunds it. feesSource 'calibratedTxFees'
    // says exactly this — an estimate calibrated to chain, never chain-exact
    // (the manual path's chain-read sell fee is the exception; its label
    // says so).
    try {
      if (full.entry === undefined) full.entry = pos.entry || null;
      if (full.gates === undefined) full.gates = pos.gates || null;
      if (full.gatePass === undefined && pos.gatePass !== undefined) full.gatePass = pos.gatePass;
      if (full.stamp === undefined) full.stamp = pos.stamp || this.cfgStamp;
      if (full.tokensRaw === undefined) full.tokensRaw = pos.entryTokensRaw || pos.tokensRaw || null;
      if (full.decimals === undefined) full.decimals = pos.decimals ?? null;
      if (full.entryFillSol === undefined) full.entryFillSol = pos.entryFillSol ?? null;
      if (full.entryFillUsd === undefined) full.entryFillUsd = full.entryFillSol != null && pos.solUsdEntry > 0 ? +(full.entryFillSol * pos.solUsdEntry).toFixed(10) : null;
      if (full.exitFillSol === undefined) full.exitFillSol = null;
      if (full.exitFillUsd === undefined) full.exitFillUsd = null;
      if (full.feesSol === undefined) { full.feesSol = +((pos.feesSol || 0)).toFixed(6); full.feesSource = 'calibratedTxFees'; }
      if (full.path === undefined) full.path = pos.pathClass ?? null; // two-path class (user 2026-10-15): the 30-position judging sample reads it off the close
      if (full.pnlPct === undefined) full.pnlPct = full.pnlSol != null && full.entrySol > 0 ? +(full.pnlSol / full.entrySol * 100).toFixed(2) : null;
    } catch { /* record enrichment must never disturb the close itself */ }
    this.journal.trade(full);
    // Ran-rebuy block (user 2026-10-15): keep the most-recent-closed-trade map
    // current in-process (boot rebuilds it from the journal; this is the seam
    // every close passes through exactly once). entryFillUsd was just resolved
    // by the enrichment above; the position's signal-time USD price is the
    // fallback, mirroring foldLastTrades' resolution order.
    try {
      if (pos.mint) {
        const closeTs = full.ts || this.now();
        const prev = this.lastTrades.get(pos.mint);
        if (!prev || closeTs >= prev.closeTs) {
          this.lastTrades.set(pos.mint, { mint: pos.mint, id: pos.id, symbol: pos.symbol || null, entryTs: pos.entryTs ?? null, closeTs, entryPriceUsd: full.entryFillUsd != null && full.entryFillUsd > 0 ? full.entryFillUsd : (pos.entryPrice > 0 ? pos.entryPrice : null) });
        }
      }
    } catch { /* bookkeeping must never disturb the close itself */ }
    try {
      const v = this.latest.get(pos.mint);
      this.postExit.watch({ id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, exitTs: full.ts || this.now(), exitPriceUsd: v && v.price > 0 ? v.price : (pos.entryPrice || null), reason: full.reason || null, manual: !!full.manual, pnlSol: full.pnlSol ?? null });
    } catch { /* observer only — never disturb trading */ }
    try {
      this.stats.closesSinceReport = (this.stats.closesSinceReport || 0) + 1;
      if (this.stats.closesSinceReport >= (this.cfg.reportEveryTrades || 10)) this.makeTradeReport();
    } catch { /* reporting must never disturb trading */ }
    // shadow ratchet judge completion (record-only): every close of a position
    // either judge ever saw armed gets its comparison record — what actually
    // closed it, whether the live ratchet was the one that fired, and the move
    // at exit — so a would-fire can be scored against what the price trigger
    // really did. v2: a STREAM-armed/fired position lands the record even if
    // the tick judge never armed, carrying both fire timestamps (leadSec =
    // how much earlier the stream fired, only when both did) and the stream
    // coverage, so an uncovered mint reads as uncovered instead of absent.
    try {
      if (this.cfg.ratchetShadow && (pos.ratchetShadowArmed || pos.streamArmed || pos.streamFired)) {
        this.stats.ratchetShadow = this.stats.ratchetShadow || { wouldFire: 0, completed: 0 };
        this.stats.ratchetShadow.completed++;
        this.journal.ratchetShadow({ kind: 'closed', outcome: 'closed', source: 'real', id: pos.id, ts: rec.ts || this.now(), mint: pos.mint, symbol: pos.symbol, setup: pos.setup, exitReason: rec.reason || null, pnlSol: rec.pnlSol ?? null, ratchetFired: /^break-even ratchet/.test(rec.reason || ''), wouldFire: !!pos.ratchetShadowFired, actualExitMove: pos.ratchetShadowMove != null ? +pos.ratchetShadowMove.toFixed(4) : null, streamWouldFire: !!pos.streamFired, streamFireTs: pos.streamFireTs ?? null, tickFireTs: pos.ratchetShadowFireTs ?? null, leadSec: (pos.streamFireTs != null && pos.ratchetShadowFireTs != null) ? +((pos.ratchetShadowFireTs - pos.streamFireTs) / 1000).toFixed(2) : null, tickArmed: !!pos.ratchetShadowArmed, streamArmed: !!pos.streamArmed, streamCovered: (pos.streamTrades || 0) > 0, streamTrades: pos.streamTrades || 0 });
        if (!this.positions.some(p => p.id !== pos.id && p.mint === pos.mint) && !(this.shadowTrades && this.shadowTrades.openVirtual(pos.mint))) this.shadowFlow.drop(pos.mint);
      }
    } catch { /* observer only — never disturb trading */ }
    // Callout Shadow Lab (record-only): TP3 = this position's FINAL close, and
    // only when it had reached TP2 — the moonbag stage completing. ensureClose
    // is the single funnel every close passes through exactly once (bot sell,
    // manual exit, reconcile, admin clear), which is what makes it the
    // faithful seam: no close path can miss it and none can double-fire it.
    try {
      if (pos.tp2Done && this.calloutLab) {
        const lv = this.latest.get(pos.mint);
        this.calloutLab.record({ trigger: 'tp3', ts: rec.ts || this.now(), mint: pos.mint, symbol: pos.symbol, v: lv || { address: pos.mint, symbol: pos.symbol, name: pos.symbol, mc: pos.entryMc ?? null }, mc: lv ? lv.mc : (pos.entryMc ?? null), liquidity: lv ? lv.liq : null, setup: pos.setup, source: 'position', holding: false, linkId: pos.id }).catch(() => {});
      }
    } catch { /* observer only — never disturb trading */ }
    // Flow-Exit Watcher (record-only): the close funnel is the single seam
    // every close passes through exactly once, so the watch finalizes here —
    // one last balance read classifies whether the trigger wallet beat the
    // bot out, held through, or can't be known. Fire-and-forget; no-op for
    // positions that were never watched.
    try { if (this.flowExits) this.flowExits.finalize(pos, full).catch(() => {}); } catch { /* observer only — never disturb trading */ }
    return true;
  }

  makeTradeReport() {
    const until = this.now();
    const since = this.stats.lastReportTs || 0;
    const closes = this.journal.trades.filter(t => t.type === 'close' && (t.ts || 0) > since);
    const opens = this.journal.trades.filter(t => t.type === 'open');
    const staleAborts = this.journal.signals.filter(s => (s.ts || 0) > since && (s.reasons || []).some(r => String(r).startsWith('stale:'))).length;
    const index = (this.stats.reportIndex || 0) + 1;
    const rec = buildTradeReport({
      index, sinceTs: since, untilTs: until, closes, opens,
      signals: this.journal.signals,
      postExits: this.postExit.done, // matched per trade by position id inside the builder
      postExitPending: [...this.postExit.pending.keys()],
      staleAborts,
    });
    this.journal.addTradeReport(rec);
    this.stats.reportIndex = index;
    this.stats.lastReportTs = until;
    this.stats.closesSinceReport = 0;
    console.log(`[report] trade report #${index} written (${closes.length} closes, net ${rec.netSol} SOL)`);
  }

  // Real P&L of an out-of-bot exit, read from the chain itself: the proceeds of the
  // user's own sell transactions (the bot's sell signatures excluded) instead of a
  // last-quote guess. Returns { pnl } or null when the sells can't be parsed.
  async chainPnl(pos) {
    try {
      if (!this.exec.sellProceeds) return null;
      const excludeSigs = new Set(this.journal.trades.filter(t => t.id === pos.id && t.sig).map(t => t.sig));
      const r = await this.exec.sellProceeds(pos.mint, { sinceSec: Math.floor(pos.entryTs / 1000), excludeSigs });
      if (!r || !(r.proceedsSol > 0)) return null;
      return { pnl: (pos.realizedSol || 0) + r.proceedsSol - pos.entrySol - (pos.feesSol || 0) };
    } catch { return null; }
  }

  // D1 follow-up (user 2026-10-14): the real fill of the user's own sell(s),
  // read from the sell transaction(s) — SOL and token balance deltas plus the
  // fee the wallet paid (see exec.sellFill for the exact convention). Null
  // when the txs can't be found or parsed: the close then keeps today's
  // mark-based record, unchanged. Never throws into a close path.
  async chainSellFill(pos) {
    try {
      if (!this.exec.sellFill) return null;
      const excludeSigs = new Set(this.journal.trades.filter(t => t.id === pos.id && t.sig).map(t => t.sig));
      const r = await this.exec.sellFill(pos.mint, { sinceSec: Math.floor(pos.entryTs / 1000), excludeSigs });
      return r && r.fillSol > 0 ? r : null;
    } catch { return null; }
  }

  // Record fields a chain-read manual fill contributes — to the close record
  // and to the manual-exit record: the real per-token fill (chainTx-sourced),
  // the real sell fee folded into feesSol alongside the buy-side calibrated
  // tx fees (feesSource says exactly that mix), and manualValueSol: what the manual
  // remainder actually realized — net (after-fee) proceeds scaled to the
  // books' full remainder at the realized per-token net price, so the paired
  // shadow comparison prices the SAME remainder its virtual position holds.
  // {} when there is no fill.
  _manualFill(pos, fill) {
    if (!fill) return {};
    const booksWhole = Number(pos.tokensRaw) > 0 && fill.decimals != null ? Number(pos.tokensRaw) / 10 ** fill.decimals : null;
    return {
      exitFillSol: +fill.fillSol.toFixed(10),
      exitFillUsd: this.lastSolUsd > 0 ? +(fill.fillSol * this.lastSolUsd).toFixed(10) : null,
      fillSource: 'chainTx',
      sellTxFeeSol: +(fill.feeSol || 0).toFixed(6),
      sellSigs: fill.sigs || [],
      feesSol: +(((pos.feesSol || 0)) + (fill.feeSol || 0)).toFixed(6),
      feesSource: 'chainTxSellFee+calibratedTxFees',
      manualValueSol: booksWhole > 0 && fill.tokensWhole > 0 ? +((fill.proceedsNetSol * booksWhole) / fill.tokensWhole).toFixed(6) : fill.proceedsNetSol,
    };
  }

  /** Every full close (bot exit, reconcile, manual, admin) funnels through here exactly
   *  once: risk.recordClose does the books, and its risk-brake events mirror into the
   *  lazy stats.riskBrake counters. Partial TP sells never pass through — they are not
   *  closes and never count toward the brake. */
  _recordClose(pnl, mint, entrySol) {
    const ev = this.risk.recordClose(pnl, mint, entrySol);
    if (ev && (ev.red || ev.halvedNow || ev.wipeNow)) {
      const rb = this.stats.riskBrake = this.stats.riskBrake || { redCounted: 0, halvings: 0, wipeHalts: 0 };
      if (ev.red) rb.redCounted++;
      if (ev.halvedNow) rb.halvings++;
      if (ev.wipeNow) rb.wipeHalts++;
    }
  }

  // Admin removals go THROUGH the funnel too — a removed position gets its close record
  // (estimated P&L) instead of vanishing silently.
  adminDrop(p, reason) {
    const n = this.now();
    const pnl = p.lastValueSol != null ? (p.realizedSol || 0) + p.lastValueSol - p.entrySol - (p.feesSol || 0) : null;
    this.positions = this.positions.filter(x => x.id !== p.id);
    if (pnl != null) this._recordClose(pnl, p.mint, p.entrySol);
    this.ensureClose(p, { id: p.id, mint: p.mint, symbol: p.symbol, setup: p.setup, entrySol: p.entrySol, pnlSol: pnl != null ? +pnl.toFixed(6) : null, estimated: true, pnlSource: 'estimate', heldMin: +((n - p.entryTs) / 60000).toFixed(1), reason, simulated: p.simulated, ts: n });
  }

  dropPosition(idOrMint) {
    const p = this.positions.find(x => x.id === idOrMint || x.mint === idOrMint);
    if (!p) return 0;
    this.adminDrop(p, 'position removed (admin)');
    this.savePositions();
    return 1;
  }

  clearAllPositions() {
    let count = 0;
    for (const p of [...this.positions]) { this.adminDrop(p, 'positions cleared (admin)'); count++; }
    this.savePositions();
    return count;
  }

  // PROTECT switch (user 2026-10-15, "just the stop loss… no ratchet", "no SL until I
  // say"): a one-time, per-position flag set via POST /protect. While set, exits.js
  // skips ONLY that position's stop-loss family, break-even ratchet and kill zone
  // (the redesign's one-rule scope widening); everything else — bleed, probation,
  // stall, trails, the TP ladder, the modest target — judges as normal. The
  // flag lives ON the position record (persisted by savePositions, so it survives
  // restarts), holds for the life of the position with no expiry, and clears only
  // when the position closes (the record goes with it — a rebuy starts unprotected)
  // or when unprotectPosition clears it early. Re-protecting an already-protected
  // position is a no-op that does not double-count the set.
  protectPosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!p.protected) {
      p.protected = this.now();
      this.stats.protect = this.stats.protect || { set: 0, blocked: 0 };
      this.stats.protect.set++;
      console.log(`[protect] ${p.symbol} protected at ${new Date(p.protected).toISOString()} — stop-loss + ratchet off until unprotect or close`);
    }
    this.savePositions();
    return p;
  }

  // Clears the protect flag early (POST /unprotect). Returns the position when a flag
  // was cleared, false when the position exists but is not protected, null when no
  // open position matches — the route maps those to 200 / 404 / 404.
  unprotectPosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!p.protected) return false;
    delete p.protected;
    // Two-path redesign (user 2026-10-15): the kill zone re-arms FRESH on
    // unprotect, like the stop and the ratchet — its record resets here so no
    // window or counted entry can survive from the protected window; arming
    // re-derives from the live post-TP1 peak on the next judged check.
    p.killZone = null;
    this.savePositions();
    console.log(`[protect] ${p.symbol} unprotected — stop-loss + ratchet + kill zone re-armed`);
    return p;
  }

  // TAKEOVER switch (user 2026-10-15, the XZON race: his manual sell and the bot's
  // ratchet sell fired into the same balance): POST /takeover hands the position to
  // the user ENTIRELY — wider than protect, which only silences the stop family +
  // ratchet. While pos.takenOver is set, exits.js returns a hold before any exit
  // section runs (the whole ladder, trails, stops, bleed, leash, time stops and
  // liquidity death included), the bundle watcher cannot sell it, and the no-quote
  // fallback cannot force it out: the bot must never sell a coin the user is
  // driving himself. Marks, peaks and flow history keep updating, and the
  // manual-exit detector + reconciler keep working — when the user sells by hand,
  // the close books exactly as manual sells book today, now race-free. The flag
  // lives ON the position record (persisted, survives restarts, no expiry) and
  // clears only when the position closes (a rebuy starts untaken) or on release.
  // Takeover supersedes protect: both flags may coexist; takeover wins.
  takeoverPosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!p.takenOver) {
      p.takenOver = this.now();
      // any stored exitPending dies HERE, silently — a pending fail-safe sell can
      // never execute into the takeover window (the judge drops them again on
      // every check while the flag is set; this covers the gap before the next).
      if (p.exitPending && typeof p.exitPending === 'object') p.exitPending = {};
      this.stats.takeover = this.stats.takeover || { set: 0, released: 0, sellsSuppressed: 0 };
      this.stats.takeover.set++;
      console.log(`[takeover] ${p.symbol} taken over at ${new Date(p.takenOver).toISOString()} — bot will not sell this position until release or close`);
    }
    this.savePositions();
    return p;
  }

  // Hands the position back (POST /release). Judging resumes FRESH, mirroring the
  // protect switch's re-arm precedent: no pendings survive, the stop is un-armed,
  // probation and the adaptive-TP1 arm are cleared, and the stall/probation clock
  // re-anchors to the release moment (stallBaseTs — exits.js 4b judges from it), so
  // no deadline that matured while the user held the coin can fire. Peaks are NOT
  // reset: they tracked the whole takeover, so the trails judge against the true
  // peak. Returns the position when a flag was cleared, false when the position
  // exists but is not taken over, null when no open position matches.
  releasePosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!p.takenOver) return false;
    delete p.takenOver;
    p.stallBaseTs = this.now();
    p.stopArmedTs = null;
    p.floorChecks = 0;
    p.floorSince = null;
    p.probationSince = null;
    p.tp1Arm = null;
    if (p.exitPending && typeof p.exitPending === 'object') p.exitPending = {};
    this.stats.takeover = this.stats.takeover || { set: 0, released: 0, sellsSuppressed: 0 };
    this.stats.takeover.released++;
    this.savePositions();
    console.log(`[takeover] ${p.symbol} released — exit judging resumed with fresh arming (stall clock re-anchored)`);
    return p;
  }

  // Tokens left the wallet outside the bot. P&L comes from the chain when the user's sell
  // transactions parse (marked pnlSource 'chain'), else an estimate from the last sell
  // quote (marked estimated) — and it counts toward the daily loss cap either way.
  // A reconcile drop IS a manual exit: it also writes a manual-exit record so it lands
  // in the manual feed and on the dashboard, not only in the trade log.
  async closeExternal(p, reason) {
    if (!this.positions.some(x => x.id === p.id)) return false; // already closed — don't log it twice
    const n = this.now();
    const chain = await this.chainPnl(p);
    let pnl = null, source = null;
    if (chain) { pnl = chain.pnl; source = 'chain'; }
    else if (p.lastValueSol != null) { pnl = (p.realizedSol || 0) + p.lastValueSol - p.entrySol - (p.feesSol || 0); source = 'estimate'; }
    this.positions = this.positions.filter(x => x.id !== p.id);
    if (pnl != null) this._recordClose(pnl, p.mint, p.entrySol);
    const heldMin = +((n - p.entryTs) / 60000).toFixed(1);
    const snapshot = await this._manualSnapshot(p, p.lastValueSol ?? null, n, pnl);
    // D1 follow-up: the real fill from the sell tx, when it can be read
    const ff = this._manualFill(p, await this.chainSellFill(p));
    const hasFill = ff.exitFillSol != null;
    this.journal.manualExit({ id: p.id, mint: p.mint, symbol: p.symbol, ts: n, how: 'sold outside bot (reconcile)', entry: p.entry || null, heldMin, peakRatio: p.peakRatio, bundleScore: p.bundleScore || 0, pnlSolEstimate: pnl != null ? +pnl.toFixed(6) : null, pnlSol: source === 'chain' ? +pnl.toFixed(6) : null, pnlSource: source || 'unknown', reason: null, snapshot, exitFillSol: hasFill ? ff.exitFillSol : null, fillSource: hasFill ? ff.fillSource : null });
    this.ensureClose(p, { manual: true, id: p.id, mint: p.mint, symbol: p.symbol, setup: p.setup, entrySol: p.entrySol, pnlSol: pnl != null ? +pnl.toFixed(6) : null, estimated: source !== 'chain', pnlSource: source, heldMin, reason: pnl != null ? `${reason} — P&L ${source === 'chain' ? 'from chain' : 'est. from last quote'}` : `${reason} (P&L unknown — no quote yet)`, simulated: p.simulated, ts: n, ...(hasFill ? { exitFillSol: ff.exitFillSol, exitFillUsd: ff.exitFillUsd, fillSource: ff.fillSource, sellTxFeeSol: ff.sellTxFeeSol, sellSigs: ff.sellSigs, feesSol: ff.feesSol, feesSource: ff.feesSource } : {}) });
    // D1 paired shadow exit: keep judging this position's remainder virtually
    // (its manual side prices off the REAL fill when one was read)
    try { this.paired.watch(this._pairedState(p, n, { pnlSol: pnl != null ? +pnl.toFixed(6) : null, valueSol: hasFill ? ff.manualValueSol : (p.lastValueSol ?? null), fillSource: hasFill ? ff.fillSource : null, fillSol: hasFill ? ff.exitFillSol : null })); } catch { /* observer only */ }
    return true;
  }

  // Periodic reconcile: drop positions whose tokens left the wallet (manual sells)
  async reconcilePositions() {
    if (!this.cfg.realMode || !this.positions.length) return;
    for (const p of [...this.positions]) {
      try {
        const bal = await this.exec.tokenBalance(p.mint);
        if (bal === 0n) {
          if (await this.closeExternal(p, 'reconcile: sold outside bot (manual sell)')) console.log(`[reconcile] dropped ${p.symbol} (not in wallet)`);
        } else if (bal != null) p.tokensRaw = bal.toString();
      } catch (e) { /* RPC flaky — skip, don't drop on error */ }
    }
    this.savePositions();
  }

  // ------------------------------------------------------------ discovery
  // Live-feed intake: add a mint the moment it's seen (e.g. a brand-new
  // launch from the websocket). The feed gets a reserved slice of the
  // watchlist (25%) with its own rotation: a new mint evicts the OLDEST
  // live-feed mint once the slice is full, and may evict the single oldest
  // watch entry overall when the watchlist is at its hard cap. Curated
  // sources keep the rest. Returns true if added.
  // Blacklist eviction (user, 2026-10-12): a user-marked mint leaves the watchlist
  // entirely and can never re-enter — before this, marked coins kept firing signals,
  // eating evaluation slots and spamming the signals feed every cooldown cycle.
  evictBlacklisted() {
    const bl = this.journal.blacklistedMints();
    if (!bl.size) return 0;
    const held = new Set(this.positions.map(p => p.mint));
    let n = 0;
    for (const mint of bl) if (!held.has(mint) && this.watch.delete(mint)) n++;
    return n;
  }

  noteMint(mint, source = 'live-ws') {
    // Callout Shadow Lab (record-only): a graduation feed is a would-call
    // moment. Fires BEFORE the early returns below on purpose — the call is
    // about the graduation itself, not about whether the mint is new to the
    // watchlist (already-watched/held/blacklisted mints still graduated).
    if (mint && source === 'graduated' && this.calloutLab) {
      try {
        const lv = this.latest.get(mint);
        this.calloutLab.record({ trigger: 'graduation', ts: this.now(), mint, symbol: lv ? lv.symbol : null, v: lv || { address: mint }, mc: lv ? lv.mc : null, liquidity: lv ? lv.liq : null, setup: 'graduation', source: 'gradwatch', holding: this.positions.some(p => p.mint === mint), linkId: null }).catch(() => {});
      } catch { /* observer only */ }
    }
    if (!mint || this.watch.has(mint)) return false;
    if (this.journal.blacklistedMints().has(mint)) return false;
    if (this.positions.some(p => p.mint === mint)) return false;
    const n = this.now();
    const sliceCap = Math.max(10, Math.floor(this.cfg.watchMax * 0.25));
    let wsCount = 0, oldestWs = null, oldestWsTs = Infinity, oldestAny = null, oldestAnyTs = Infinity;
    for (const [m, w] of this.watch) {
      if (w.ts < oldestAnyTs) { oldestAnyTs = w.ts; oldestAny = m; }
      if (w.source === source) { wsCount++; if (w.ts < oldestWsTs) { oldestWsTs = w.ts; oldestWs = m; } }
    }
    if (wsCount >= sliceCap && oldestWs) this.watch.delete(oldestWs);
    else if (this.watch.size >= this.cfg.watchMax && oldestAny) this.watch.delete(oldestAny);
    this.watch.set(mint, { ts: n, source });
    this.intakeCounts[source] = (this.intakeCounts[source] || 0) + 1; // scan record (record-only)
    return true;
  }

  /** Mints whose trades the live feed should stream: freshest watch entries + open positions.
   *  Open positions always come first — a held mint keeps its subscription for the life of
   *  the position, ahead of the capped fresh-watch slice. With fast pop off, held mints are
   *  still streamed while the shadow ratchet judge (record-only) is on: it reads their flow.
   *  Open SHADOW positions' mints ride along (after held) while the judge is on — the
   *  stream judge's shadow-book sample (v2) reads the same feed. */
  tradeWatchMints() {
    const held = this.positions.map(p => p.mint);
    const shadow = this.cfg.ratchetShadow && this.shadowTrades ? this.shadowTrades.pendingMints().map(x => x.mint) : [];
    if (!this.cfg.fastPop) return this.cfg.ratchetShadow ? [...new Set([...held, ...shadow])] : [];
    const fresh = [...this.watch.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, this.cfg.fastPopMaxSubs).map(([m]) => m);
    return [...new Set([...held, ...shadow, ...fresh])];
  }

  /**
   * A streamed trade for a watched mint (fast pop detection, user 2026-10-13).
   * Buffers the print and, throttled per mint, judges it with the pure fastPop
   * detector. A fire routes into the exact same onSignal pipeline as a classic
   * pop — name block, gates, risk, round-trip all unchanged. Fail-open throughout:
   * the stream is an accelerator, never a dependency.
   */
  noteTrade(mint, trade) {
    // shadow ratchet judge feed (record-only): held + shadow-book mints' trades, independent of fast pop
    if (this.cfg.ratchetShadow) this.noteShadowTrade(mint, trade);
    if (!this.cfg.fastPop || !trade || !(trade.price > 0)) return;
    let buf = this.streamBuf.get(mint);
    if (!buf) { buf = []; this.streamBuf.set(mint, buf); }
    buf.push(trade);
    const cutoff = trade.ts - (this.cfg.fastPopWindowSec * 1000 + 60000);
    while (buf.length && buf[0].ts < cutoff) buf.shift();
    if (buf.length > 600) buf.splice(0, buf.length - 600);
    const n = this.now();
    if (n - (this.fastEvalAt.get(mint) || 0) < this.cfg.fastPopEvalMs) return;
    this.fastEvalAt.set(mint, n);
    this._evalFastPop(mint, buf, n).catch(e => this.err('fastPop', e));
  }

  /** Buffer a streamed trade for the shadow ratchet judges — held mints and open
   *  shadow positions' mints only, everything else ignored (buffered once when a
   *  mint is both). Each target's stream-trade count is its coverage record.
   *  After buffering, the STREAM judge (v2) evaluates on the trade path itself,
   *  throttled per mint exactly like the fast-pop evaluation above. */
  noteShadowTrade(mint, trade) {
    if (!trade || !(trade.sol > 0)) return;
    const pos = this.positions.find(p => p.mint === mint) || null;
    const virt = this.shadowTrades ? this.shadowTrades.openVirtual(mint) : null;
    if (!pos && !virt) return;
    this.shadowFlow.note(mint, trade);
    if (pos) pos.streamTrades = (pos.streamTrades || 0) + 1;
    let st = null;
    if (virt) { st = this._shadowStreamStateFor(virt.id); st.mint = mint; st.streamTrades = (st.streamTrades || 0) + 1; }
    const n = trade.ts || this.now();
    if (n - (this.streamEvalAt.get(mint) || 0) < this.cfg.ratchetStreamEvalMs) return;
    this.streamEvalAt.set(mint, n);
    try { this._judgeRatchetStream(mint, pos, virt, st, n); } catch { /* observer only — the stream path must never disturb the feed */ }
  }

  /**
   * One stream-judge step against a state holder (a real position, or a shadow
   * virtual's Bot-side state): given the stream VWAP move off the entry price,
   * track the STREAM's own peak, arm off it, and run the unchanged pure fire
   * test. Returns { fire, move, peakMove } on the position's first stream
   * would-fire, else null. A holder with no usable entry price has no opinion.
   */
  _streamJudgeStep(holder, entryPrice, tp1Done, vwPrice, flow) {
    if (!(entryPrice > 0)) return null;
    const move = vwPrice / entryPrice;
    if (holder.streamPeakMove == null || move > holder.streamPeakMove) holder.streamPeakMove = move;
    if (ratchetArmed(holder.streamPeakMove, tp1Done, this.cfg)) holder.streamArmed = true;
    if (holder.streamFired) return null; // at most one stream would-fire per position: the first
    const fire = ratchetShadowFire({ peakMove: holder.streamPeakMove, tp1Done, move, flow, cfg: this.cfg });
    if (!fire) return null;
    holder.streamFired = true;
    return { fire, move, peakMove: holder.streamPeakMove };
  }

  /**
   * STREAM ratchet judge (user 2026-10-15, RECORD-ONLY — this can never sell).
   * The tick judge (judgeRatchetShadow) asks its question on 4s quote polls;
   * this one asks the SAME question as the trades themselves land: is the
   * flow an exit wave while the stream VWAP comes off the stream's own peak?
   * The price basis differs by design (stream prints off the actual entry
   * fill, not the realizable quote), so every record cross-tags the other
   * judge's state (jupArmed, and jupMove sampled fresh at fire time) and the
   * completion records carry both fire timestamps — lead time is only ever
   * read where both judges armed. Runs for held positions (source 'real')
   * and open shadow-book virtuals (source 'shadow', counted separately).
   * A VWAP window holding fewer than 2 prints is no opinion at all: neither
   * a peak update nor a fire evaluation, so one dust print decides nothing.
   */
  _judgeRatchetStream(mint, pos, virt, st, n) {
    const vw = this.shadowFlow.vwap(mint, n, this.cfg.ratchetStreamVwapSec);
    if (!vw || vw.prints < 2) return;
    const flow = this.shadowFlow.window(mint, n, this.cfg.ratchetFlowWindowSec);
    if (pos) {
      const hit = this._streamJudgeStep(pos, pos.entryFillSol, pos.tp1Done, vw.price, flow);
      if (hit) {
        pos.streamFireTs = n;
        this.stats.ratchetShadow = this.stats.ratchetShadow || { wouldFire: 0, completed: 0 };
        this.stats.ratchetShadow.streamWouldFire = (this.stats.ratchetShadow.streamWouldFire || 0) + 1;
        const jupArmed = ratchetArmed(pos.peakMove, pos.tp1Done, this.cfg); // was the QUOTE judge armed at this same moment?
        this._journalStreamFireReal(pos, hit, jupArmed, n).catch(() => { /* observer only */ });
        console.log(`[ratchet-shadow] ${pos.symbol}: STREAM WOULD FIRE — sells ${Math.round(hit.fire.sellShare * 100)}% of last ${this.cfg.ratchetFlowWindowSec}s flow (${hit.fire.sellSol.toFixed(2)} SOL), stream move ${hit.move.toFixed(3)} off stream peak ${hit.peakMove.toFixed(3)} (record only)`);
      }
    }
    if (virt && st) {
      // A virtual restored across a restart never got the open-time SOL basis:
      // resolve it lazily off the current rate (open-time capture is preferred
      // and already set for virtuals opened by this process).
      if (st.entryPriceSol == null && virt.entryPrice > 0 && this.lastSolUsd > 0) st.entryPriceSol = virt.entryPrice / this.lastSolUsd;
      const hit = this._streamJudgeStep(st, st.entryPriceSol, virt.tp1Done, vw.price, flow);
      if (hit) {
        st.streamFireTs = n;
        this.stats.ratchetShadow = this.stats.ratchetShadow || { wouldFire: 0, completed: 0 };
        this.stats.ratchetShadow.streamShadowWouldFire = (this.stats.ratchetShadow.streamShadowWouldFire || 0) + 1;
        const markMove = virt.entrySol > 0 && virt.remainingFrac > 0 ? (virt.lastValueSol / (virt.entrySol * virt.remainingFrac)) / (virt.entryRoundTrip > 0 ? virt.entryRoundTrip : 1) : null;
        this.journal.ratchetShadow({ kind: 'would-fire-stream', source: 'shadow', id: virt.id, ts: n, mint, symbol: virt.symbol, setup: virt.setup, streamMove: +hit.move.toFixed(4), streamPeakMove: +hit.peakMove.toFixed(4), sellShare: +hit.fire.sellShare.toFixed(3), sellSol: +hit.fire.sellSol.toFixed(4), buySol: +hit.fire.buySol.toFixed(4), windowSec: this.cfg.ratchetFlowWindowSec, jupArmed: ratchetArmed(virt.peakMove, virt.tp1Done, this.cfg), jupMove: markMove != null && Number.isFinite(markMove) ? +markMove.toFixed(4) : null });
        console.log(`[ratchet-shadow] ${virt.symbol}: STREAM WOULD FIRE (shadow book) — sells ${Math.round(hit.fire.sellShare * 100)}% of last ${this.cfg.ratchetFlowWindowSec}s flow (${hit.fire.sellSol.toFixed(2)} SOL), stream move ${hit.move.toFixed(3)} off stream peak ${hit.peakMove.toFixed(3)} (record only)`);
      }
    }
  }

  /**
   * Journal a real position's stream would-fire. jupMove is a FRESH Jupiter
   * mark sampled at fire time (fires are rare; one quote is cheap and exact),
   * converted to a move exactly as positionTick computes it — fail-silent to
   * the last tick's move when the quote fails or the exec layer can't quote.
   * Async by necessity; the caller has already latched the fire state.
   */
  async _journalStreamFireReal(pos, hit, jupArmed, n) {
    let jupMove = pos.ratchetShadowMove != null ? pos.ratchetShadowMove : null;
    try {
      if (this.exec && typeof this.exec.markValue === 'function') {
        const valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw);
        const basis = pos.entrySol * pos.remainingFrac;
        const base = pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1;
        if (valueSol != null && basis > 0) jupMove = (valueSol / basis) / base;
      }
    } catch { /* quote failed — the last tick move stands */ }
    this.journal.ratchetShadow({ kind: 'would-fire-stream', source: 'real', id: pos.id, ts: n, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, streamMove: +hit.move.toFixed(4), streamPeakMove: +hit.peakMove.toFixed(4), sellShare: +hit.fire.sellShare.toFixed(3), sellSol: +hit.fire.sellSol.toFixed(4), buySol: +hit.fire.buySol.toFixed(4), windowSec: this.cfg.ratchetFlowWindowSec, jupArmed, jupMove: jupMove != null ? +jupMove.toFixed(4) : null });
  }

  /** Callout Shadow Lab tap for wallet-detector events (record-only): a
   *  dev-launch or confluence event journaled by walletWatch is a would-call
   *  moment. The view for thesis generation is rebuilt from the event plus the
   *  freshest view the bot holds; buildThesis researches the rest itself. */
  noteCalloutEvent(ev) {
    try {
      if (!ev || !this.calloutLab) return;
      const trigger = ev.kind === 'dev' ? 'devlaunch' : ev.kind === 'confluence' ? 'confluence' : null;
      if (!trigger) return;
      const lv = this.latest.get(ev.mint);
      const v = lv || { address: ev.mint, symbol: ev.symbol || null, name: ev.symbol || null, mc: ev.mc ?? null, pairAddress: ev.pool || null };
      this.calloutLab.record({
        trigger, ts: ev.ts || this.now(), mint: ev.mint, symbol: ev.symbol || (lv ? lv.symbol : null), v,
        mc: ev.mc ?? (lv ? lv.mc : null), liquidity: lv ? lv.liq : null, pool: ev.pool || null,
        setup: trigger, source: 'walletwatch', holding: this.positions.some(p => p.mint === ev.mint), linkId: ev.id || null,
      }).catch(() => {});
    } catch { /* observer only */ }
  }

  /** Read-only /callouts payload — the lab's scorecard over the FULL
   *  callout_shadow.jsonl (see calloutLab.js; ~60s cached there). */
  calloutCard() {
    try { return this.calloutLab.scorecard(); } catch { return { enabled: false }; }
  }

  /** Read-only /resignals payload — the Answered Re-signals scorecard over
   *  resignal_shadow.jsonl (see resignalLab.js; ~60s cached in the journal). */
  resignalCard() {
    try { return this.journal.resignalCard(); } catch { return { enabled: false }; }
  }

  /** Read-only /deadentry payload — the Dead-Entry Veto study scorecard
   *  (see deadEntryLab.js; ~30s cached in the journal). */
  deadEntryCard() {
    try { return this.journal.deadEntryCard(); } catch { return { enabled: false }; }
  }

  /** Flow-Exit Watcher feed (record-only): the position's own mark state in
   *  the same measure the exit stack judges — the realizable move of the
   *  remaining position vs its entry round-trip, off the last live sell-quote
   *  mark (pos.lastValueSol, refreshed by every managePosition). Nulls when
   *  the position has never been marked. */
  _flowExitPosState(id) {
    const pos = this.positions.find(p => p.id === id);
    if (!pos) return { open: false };
    const basis = pos.entrySol * (pos.remainingFrac || 0);
    let movePct = null, markSol = null;
    if (pos.lastValueSol != null && basis > 0) {
      const base = pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1;
      movePct = +(((pos.lastValueSol / basis) / base - 1) * 100).toFixed(2);
      markSol = +pos.lastValueSol.toFixed(6);
    }
    return {
      open: true, movePct, markSol,
      peakPct: pos.peakMove != null ? +((pos.peakMove - 1) * 100).toFixed(2) : null,
      bankedSol: pos.realizedSol || 0,
      botRemainingFrac: pos.remainingFrac != null ? pos.remainingFrac : null,
    };
  }

  /** Read-only /flowexits payload — the Flow-Exit Watcher scorecard over the
   *  FULL flow_exits.jsonl (see flowExits.js; ~60s cached there). */
  flowExitsCard() {
    try { return this.flowExits.scorecard(); } catch { return { enabled: false }; }
  }

  /** Read-only /structurewatch payload — the Structure Watch scorecard over
   *  the FULL structure_watch.jsonl (see structureWatch.js; ~60s cached there). */
  structureWatchCard() {
    try { return this.structureWatch.scorecard(); } catch { return { enabled: false }; }
  }

  /**
   * Read-only /ratchetshadow payload (record-only, like the layer itself):
   * counters off stats, aggregates over the journal's in-memory ratchet tail
   * (the last 500 records — months of this journal's traffic). The arm
   * comparison reads REAL completions only: a shadow virtual has no tick
   * judge, so its tickArmed is null and it can never pollute the pairing.
   * bothArmed counts completions where BOTH judges fired (leadSec != null
   * is exactly that set); lead time is never averaged over anything else.
   */
  ratchetShadowView() {
    const cfg = this.cfg || {};
    const st = this.stats.ratchetShadow || {};
    const recs = (this.journal && this.journal.ratchet) || [];
    const byKind = { wouldFire: 0, streamReal: 0, streamShadow: 0, fireQuality: 0, closedReal: 0, closedShadow: 0 };
    const leads = [];
    let closedN = 0, covered = 0, streamOnlyArms = 0, tickOnlyArms = 0;
    for (const r of recs) {
      if (!r) continue;
      if (r.kind === 'would-fire') byKind.wouldFire++;
      else if (r.kind === 'would-fire-stream') { if (r.source === 'shadow') byKind.streamShadow++; else byKind.streamReal++; }
      else if (r.kind === 'fire-quality') byKind.fireQuality++;
      else if (r.kind === 'closed') {
        closedN++;
        if (r.source === 'shadow') byKind.closedShadow++; else byKind.closedReal++;
        if (r.streamCovered) covered++;
        if (r.leadSec != null) leads.push(r.leadSec);
        if (typeof r.tickArmed === 'boolean') {
          if (r.streamArmed && !r.tickArmed) streamOnlyArms++;
          else if (r.tickArmed && !r.streamArmed) tickOnlyArms++;
        }
      }
    }
    leads.sort((a, b) => a - b);
    const medianLeadSec = leads.length ? +(leads.length % 2 ? leads[(leads.length - 1) / 2] : (leads[leads.length / 2 - 1] + leads[leads.length / 2]) / 2).toFixed(2) : null;
    return {
      enabled: !!cfg.ratchetShadow,
      knobs: { evalMs: cfg.ratchetStreamEvalMs, vwapSec: cfg.ratchetStreamVwapSec, flowWindowSec: cfg.ratchetFlowWindowSec, flowSellShare: cfg.ratchetFlowSellShare, flowMinSellSol: cfg.ratchetFlowMinSellSol, beArmPct: cfg.beArmPct, beTriggerPct: cfg.beTriggerPct },
      counters: { wouldFire: st.wouldFire || 0, completed: st.completed || 0, streamWouldFire: st.streamWouldFire || 0, streamShadowWouldFire: st.streamShadowWouldFire || 0 },
      journalRecords: recs.length,
      byKind,
      bothArmed: { n: leads.length, medianLeadSec, streamOnlyArms, tickOnlyArms },
      coverage: { closed: closedN, covered },
      recent: recs.slice(-15).reverse(),
    };
  }

  /**
   * Shadow ratchet flow judge (user 2026-10-14, RECORD-ONLY — this can never sell).
   * Runs on every position check with a live mark, right after evaluateExit has
   * updated the position's peakMove, so it reads the same move/peakMove the live
   * ratchet (§4c) just judged. For an armed position it asks the stream: is the
   * flow over the last ratchetFlowWindowSec an exit wave while the price comes
   * off its high? The first would-fire per position is journaled to
   * ratchet_shadow.jsonl; the completion record lands in ensureClose. Fail-silent:
   * no streamed flow for the mint = no opinion, nothing recorded.
   */
  judgeRatchetShadow(pos, move, n) {
    if (!this.cfg.ratchetShadow) return;
    pos.ratchetShadowMove = move; // the close record's exit move, whichever exit ends it
    // fire-quality probes (record-only, v2): if the STREAM judge already
    // would-fired this position, what did the realizable move do at the first
    // ticks >= 30s / >= 60s after its fire? An early fire is only a good fire
    // if the price kept falling — a probe back at the peak exposes a shakeout.
    try {
      if (pos.streamFired && pos.streamFireTs) {
        for (const atSec of [30, 60]) {
          const key = atSec === 30 ? 'streamProbe30' : 'streamProbe60';
          if (pos[key] || n - pos.streamFireTs < atSec * 1000) continue;
          pos[key] = true;
          this.journal.ratchetShadow({ kind: 'fire-quality', source: 'real', id: pos.id, ts: n, mint: pos.mint, symbol: pos.symbol, atSec, jupMove: +move.toFixed(4) });
        }
      }
    } catch { /* observer only */ }
    if (ratchetArmed(pos.peakMove, pos.tp1Done, this.cfg)) pos.ratchetShadowArmed = true;
    if (pos.ratchetShadowFired) return; // at most one would-fire per position: the first
    const flow = this.shadowFlow.window(pos.mint, n, this.cfg.ratchetFlowWindowSec);
    const fire = ratchetShadowFire({ peakMove: pos.peakMove, tp1Done: pos.tp1Done, move, flow, cfg: this.cfg });
    if (!fire) return;
    pos.ratchetShadowFired = true;
    pos.ratchetShadowFireTs = n; // the completion record pairs this with streamFireTs for lead time
    this.stats.ratchetShadow = this.stats.ratchetShadow || { wouldFire: 0, completed: 0 };
    this.stats.ratchetShadow.wouldFire++;
    this.journal.ratchetShadow({ kind: 'would-fire', id: pos.id, ts: n, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, moveAtFire: +move.toFixed(4), peakMove: +pos.peakMove.toFixed(4), sellShare: +fire.sellShare.toFixed(3), sellSol: +fire.sellSol.toFixed(4), buySol: +fire.buySol.toFixed(4), windowSec: this.cfg.ratchetFlowWindowSec, streamArmed: !!pos.streamArmed, streamFireTs: pos.streamFireTs ?? null });
    console.log(`[ratchet-shadow] ${pos.symbol}: WOULD FIRE — sells ${Math.round(fire.sellShare * 100)}% of last ${this.cfg.ratchetFlowWindowSec}s flow (${fire.sellSol.toFixed(2)} SOL), move ${move.toFixed(3)} off peak ${pos.peakMove.toFixed(3)} (record only)`);
  }

  async _evalFastPop(mint, buf, n) {
    if (this.positions.some(p => p.mint === mint)) return;
    if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) return;
    const sig = fastPop(buf, this.cfg, n);
    if (!sig) return;
    // The pipeline needs a DexScreener view for gates/sizing. Reuse the poll's
    // latest; refresh just this mint if it's missing or stale.
    let v = this.latest.get(mint);
    if (!v || n - (this.latestAt.get(mint) || 0) > 20000) {
      const views = await this.d.fetchViews([mint]).catch(() => null);
      if (views && views.get(mint)) { v = views.get(mint); this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n); }
    }
    if (!v) return;
    if (eligible(v, this.cfg, n).length) return; // same tradability floor the classic detectors apply
    const streamVolSol = sig.metrics.volM5; // fastPop reports window volume in SOL
    sig.metrics.streamVolSol = streamVolSol;
    const solUsd = await this.d.fetchSolUsd().catch(() => null);
    if (solUsd) sig.metrics.volM5 = Math.round(streamVolSol * solUsd); // USD for journal parity with classic pops
    this.lastSignal.set(mint, this.now());
    this.stats.fastPop = this.stats.fastPop || { fires: 0 };
    this.stats.fastPop.fires++;
    console.log(`[fastpop] ${v.symbol} fired from the trade stream: +${sig.metrics.gainPct}% in ${sig.metrics.windowSec}s, ${sig.metrics.trades} trades, buy share ${sig.metrics.buyRatioM5}`);
    // Fast-pop floors (user 2026-10-15): the burst must carry real size on
    // BOTH volume measures or the fire is journaled as a skip with the reason
    // — never silently swallowed, never taken. Fail-closed on missing data:
    // if the SOL/USD conversion failed, the USD figure is unknown (null
    // here) and cannot clear its floor.
    const floors = fastPopFloors({ volM5Usd: solUsd ? sig.metrics.volM5 : null, streamVolSol }, this.cfg);
    if (!floors.pass) {
      this.stats.fastPopFloors = this.stats.fastPopFloors || { blocked: 0, missing: 0 };
      this.stats.fastPopFloors.blocked++;
      if (floors.missing) this.stats.fastPopFloors.missing++;
      console.log(`[fastpop] skip: ${v.symbol} — ${floors.reasons.join('; ')}`);
      return this.skip(v, sig, floors.reasons.map(r => `fastPop: ${r}`), [], { fastPop: { pass: false, reason: floors.reasons.join('; ') } });
    }
    await this.onSignal(v, sig);
  }

  async discoverTick() {
    if (this.busy.discover) return;
    this.busy.discover = true;
    try {
      const found = await this.d.discover(this.cfg);
      const n = this.now();
      const bl = this.journal.blacklistedMints();
      for (const [mint, source] of found) if (!bl.has(mint)) this.watch.set(mint, { ts: n, source });
      // Feed scraped pump.fun lists into the watchlist
      let reallistsAdded = 0;
      try {
        const rl = JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, 'reallists.json'), 'utf8'));
        for (const row of [...(rl.trending || []), ...(rl.movers || []), ...(rl.graduated || []), ...(rl.new || [])]) {
          const mint = row.mint || row.address;
          if (mint && !bl.has(mint) && !this.watch.has(mint)) { this.watch.set(mint, { ts: n, source: 'reallists' }); reallistsAdded++; }
        }
      } catch {}
      this.evictBlacklisted();
      this.stats.sourceCounts = found.counts || {};
      this.stats.discoverTicks++; this.stats.lastDiscoverTs = n;
      // prune: stale entries first; hard cap keeps the freshest, never drops open positions.
      // Churn-pinned mints (dumped coins on the basing watch) are exempt from both prunes
      // until their pin expires — non-pinned mints behave exactly as before.
      const ttl = this.cfg.watchTtlMin * 60000;
      const held = new Set(this.positions.map(p => p.mint));
      for (const [m, w] of this.watch) if (!held.has(m) && !this.churnPinned(m, n) && n - w.ts > ttl) this.watch.delete(m);
      if (this.watch.size > this.cfg.watchMax) {
        const sorted = [...this.watch.entries()].sort((a, b) => b[1].ts - a[1].ts);
        for (const [m] of sorted.slice(this.cfg.watchMax)) if (!held.has(m) && !this.churnPinned(m, n)) this.watch.delete(m);
      }
      this.history.prune(n, new Set([...this.watch.keys(), ...held]));
      // graduation-handoff bookkeeping only tracks mints we still watch or hold
      if (this.curveSeen.size) { const keep = new Set([...this.watch.keys(), ...held]); for (const m of this.curveSeen) if (!keep.has(m)) this.curveSeen.delete(m); }
      // Scan record (record-only, freeze work 1b — user 2026-10-14): persist
      // ONE compact line per discovery cycle — post-prune watchlist size +
      // per-source intake — so "coins scanned per hour" is recoverable later
      // (the funnel analysis found it wasn't: nothing persisted scan counts).
      // Intake = distinct mints each source contributed this cycle: discover()
      // sources by their quota `taken`, reallists by actual adds above, and the
      // async noteMint sources (live-ws / graduated / flow) by the adds counted
      // since the previous cycle. Fail-silent: journaling never breaks discovery.
      try {
        const intake = {};
        for (const [name, c] of Object.entries(found.counts || {})) intake[name] = (c && c.taken) || 0;
        if (reallistsAdded) intake.reallists = reallistsAdded;
        for (const [name, c] of Object.entries(this.intakeCounts)) intake[name] = (intake[name] || 0) + c;
        this.intakeCounts = {};
        this.journal.scan({ ts: n, watchSize: this.watch.size, intake });
      } catch { /* record-only */ }
    } catch (e) { this.err('discover', e); } finally { this.busy.discover = false; this.saveStats(); }
  }

  // ------------------------------------------------------------ outcome observer
  // Outcome observer (2026-10-14, RECORD-ONLY — can never trade, never touches
  // the watchlist, history, or latest-view maps the detectors read). The
  // journal's outcome tracker used to be fed only as a side effect of the
  // trading poll (watchlist ∪ positions), so a signal's r5/r15/r60 depended
  // on its coin KEEPING a watch seat — 20-minute TTL versus a 60-minute last
  // checkpoint. This tick closes that gap: every ~30s it polls prices (the
  // same deps.fetchViews source, same chunking) for exactly the mints with
  // outcome tracking in flight that the trading poll hasn't covered in the
  // last ~25s, oldest signals first, capped per tick, and feeds the views to
  // journal.observe ONLY. A mint whose pair is gone simply returns no view;
  // its outcome finalizes at the horizon flagged partial (see journal.js).
  async outcomeTick(n) {
    if (n - (this.lastOutcomeTickTs || 0) < 30000) return;
    this.lastOutcomeTickTs = n;
    this.stats.outcomeObs = this.stats.outcomeObs || { ticks: 0, fetched: 0, views: 0 };
    try { this.journal.flushPending(); } catch { /* persistence is best-effort */ }
    const pend = this.journal.pendingMints ? this.journal.pendingMints() : [];
    // Trade-grade shadow (record-only): open virtual mints join the fetch
    // set, so a virtual position keeps being marked after its signal's own
    // outcome tracking (and any watchlist seat) ends — marks never depend on
    // watch residence, the same guarantee this observer exists to give.
    if (this.shadowTrades) {
      const have = new Set(pend.map(p => p.mint));
      for (const vm of this.shadowTrades.pendingMints()) if (!have.has(vm.mint)) pend.push(vm);
    }
    const due = pend.filter(p => n - (this.outcomeSeenAt.get(p.mint) || 0) >= 25000).slice(0, 150);
    if (!due.length) return;
    this.stats.outcomeObs.ticks++;
    this.stats.outcomeObs.fetched += due.length;
    const views = await this.d.fetchViews(due.map(p => p.mint)).catch(() => null);
    if (views) {
      for (const [mint, v] of views) {
        if (!v || !(v.price > 0)) continue;
        this.journal.observe(v);
        this.outcomeSeenAt.set(mint, n);
        this.stats.outcomeObs.views++;
      }
    }
    // Finalization must not depend on views existing at all: past-horizon
    // pendings close out flagged-partial even when every pair is gone.
    try { this.journal.expireSweep(n); } catch { /* observer only */ }
    // Trade-grade shadow: the SAME fetched views drive the virtual exit
    // stack (cap expiry included — it runs even when the fetch came back
    // empty). No price fetch exists anywhere for the virtuals but this one
    // and the trading poll's.
    try { if (this.shadowTrades) { this.shadowTrades.tick(mint => (views ? views.get(mint) : null) || null, n, this.cfg, this.lastSolUsd); this._syncShadowStats(); } } catch { /* observer only */ }
  }

  // ------------------------------------------------------------ polling + signals
  async pollTick() {
    if (this.busy.poll) return;
    this.busy.poll = true;
    try {
      this.evictBlacklisted(); // marked coins never even get priced, let alone signal
      const mints = [...new Set([...this.watch.keys(), ...this.positions.map(p => p.mint)])];
      if (!mints.length) { try { await this.outcomeTick(this.now()); } catch { /* observer only */ } try { await this._flowRetryTick(this.now()); } catch { /* record-only retry */ } try { await this.walletWatch.finalizeTick(this.now()); } catch { /* shadow outcomes */ } try { await this.calloutLab.tick(this.now()); } catch { /* shadow callouts */ } try { await this.flowExits.tick(this.now()); } catch { /* shadow flow exits */ } try { await this.structureWatch.tick(this.now()); } catch { /* shadow structure watch */ } return; }
      const views = await this.d.fetchViews(mints);
      const n = this.now();
      // D4 (user 2026-10-13): market breadth — the share of sampled coins green on the hour —
      // feeds the streak pause's resume test. Logged on transitions so the pause/resume
      // decisions are auditable in the journal of record (console + /state fields).
      {
        let green = 0, total = 0;
        for (const v of views.values()) { if (v && v.chgH1 != null) { total++; if (v.chgH1 > 0) green++; } }
        if (total > 0) {
          const wasPaused = this.risk.s.streakPausedAt != null;
          const ev = this.risk.noteBreadth(green / total, total);
          if (ev === 'resumed') console.log(`[streakpause] breadth recovered (${(green / total * 100).toFixed(0)}% of ${total} coins green on the hour, sustained) — entries resumed`);
          else if (!wasPaused && this.risk.s.streakPausedAt != null) console.log(`[streakpause] ${this.risk.s.lossStreak} straight losses — entries paused until market breadth recovers`);
        }
      }
      // Pace keeper: get relaxed cfg once per tick if behind target
      const { cfg: tickCfg } = this.paceCfg(n);
      const candidates = [];
      for (const [mint, v] of views) {
        this.latest.set(mint, v);
        this.latestAt.set(mint, n);
        this.history.record(v, n);
        this._noteGraduation(mint, v, n);
        this.journal.observe(v);
        this.outcomeSeenAt.set(mint, n); // the trading poll just fed the outcome tracker for this mint
        if (this.positions.some(p => p.mint === mint)) continue;
        if (tickCfg.churnEnabled) this._updateChurnPins(mint, n);
        // Pop/trend first, exactly as before; churn is an ADDITIONAL detector judged
        // only when the classic pair passed (user 2026-10-14: "we still keep pop tho,
        // this is just adding more signals"). Liftoff likewise, judged only when
        // pop/trend and churn both passed — it reads the same samples for the START
        // of a move (flat base → stepped climb), the grind shape the burst
        // detectors structurally miss (UNTXED/CODE, user 2026-10-14).
        let sig = detect(v, this.history.get(mint), tickCfg, n);
        if (!sig && tickCfg.churnEnabled) sig = detectChurn(v, this.history.get(mint), tickCfg, n);
        if (!sig && tickCfg.liftoffEnabled) sig = detectLiftoff(v, this.history.get(mint), tickCfg, n);
        if (!sig) continue;
        const last = this.lastSignal.get(mint) || 0;
        if (n - last < this.cfg.signalCooldownMin * 60000) continue;
        candidates.push({ v, sig });
      }
      this.stats.pollTicks++; this.stats.lastPollTs = n;
      // fast-pop hygiene: drop stream buffers for mints no longer watched or held
      if (this.streamBuf.size) {
        const keep = new Set([...this.watch.keys(), ...this.positions.map(p => p.mint)]);
        for (const [m, buf] of this.streamBuf) if (!keep.has(m) && (!buf.length || n - buf[buf.length - 1].ts > 600000)) { this.streamBuf.delete(m); this.fastEvalAt.delete(m); }
      }
      // post-exit observer: feed the tracker the prices this poll already fetched (no extra calls)
      try { this.postExit.tick(mint => { const v = this.latest.get(mint); return v ? v.price : null; }, n); } catch { /* observer only */ }
      // D1 paired shadow exits: run the virtual exit stack for manually-closed
      // positions on the same views (observer only — can never trade)
      try { this.paired.tick(mint => this.latest.get(mint) || null, n, this.cfg, this.lastSolUsd); } catch { /* observer only */ }
      // Trade-grade shadow: the same already-fetched views mark the virtual
      // positions of gate-passing shadow signals (observer only)
      try { this.shadowTrades.tick(mint => this.latest.get(mint) || null, n, this.cfg, this.lastSolUsd); this._syncShadowStats(); } catch { /* observer only */ }
      // Outcome observer (2026-10-14, record-only): price the mints with
      // outcome tracking in flight that the trading poll did NOT just cover,
      // so checkpoints stop depending on watchlist residence.
      try { await this.outcomeTick(n); } catch { /* observer only */ }
      try { await this._flowRetryTick(n); } catch { /* record-only retry */ }
      try { await this.walletWatch.finalizeTick(n); } catch { /* shadow outcomes */ }
      try { await this.calloutLab.tick(n); } catch { /* shadow callouts */ }
      try { await this.flowExits.tick(n); } catch { /* shadow flow exits */ }
      try { await this.structureWatch.tick(n); } catch { /* shadow structure watch */ }
      candidates.sort((a, b) => b.sig.strength - a.sig.strength);
      for (const c of candidates.slice(0, this.cfg.maxSignalsPerTick)) {
        this.lastSignal.set(c.v.address, this.now());
        if (c.sig.setup === 'churn') { this.stats.churn = this.stats.churn || { fires: 0 }; this.stats.churn.fires++; }
        if (c.sig.setup === 'liftoff') { this.stats.liftoff = this.stats.liftoff || { fires: 0 }; this.stats.liftoff.fires++; }
        await this.onSignal(c.v, c.sig).catch(e => this.err('onSignal', e));
      }
    } catch (e) { this.err('poll', e); } finally { this.busy.poll = false; this.saveStats(); }
  }

  // Signal fields (record-only, 2026-10-14): sampled-history context for the
  // signal record — holder growth, curve fill speed, buy velocity — computed
  // by src/signalFields.js from the coin's own samples + this process's
  // RugCheck holder reads. Fail-silent: an error yields null and the record
  // simply omits the block; nothing anywhere branches on these values.
  _signalFields(v, metrics = null) {
    let f = null;
    // Dead-entry study stamp: the signal's own 5m volume USD as detection
    // judged it rides in the signal metrics (classic pop: the view figure;
    // fast pop: the stream figure converted to USD at fire time). One
    // fast-pop wart to guard: when that SOL/USD conversion failed, metrics
    // still carries the raw stream SOL number — a SOL figure must never be
    // stamped as USD volume, so it reads as unknown and the view's figure
    // (or null) stands instead. Record-only either way.
    let mVol = null;
    if (metrics && Number.isFinite(metrics.volM5)) {
      mVol = metrics.volM5;
      if (metrics.fastStream && Number.isFinite(metrics.streamVolSol) && mVol === metrics.streamVolSol) mVol = null;
    }
    try { f = computeSignalFields({ samples: this.history.get(v.address), view: v, holders: holderSamples(v.address), now: this.now(), veto: { distPct: this.cfg.peakVetoDistPct, ageSec: this.cfg.peakVetoAgeSec }, volM5: mVol }); }
    catch { f = null; }
    // Peak-veto shadow counters (record-only): one count per journaled signal —
    // stamped when the samples supported the peak stamps, unstamped when they
    // didn't, wouldBlock when the shadow verdict would have vetoed. The verdict
    // is never read back for any decision; /state just exposes the tallies.
    this.stats.peakVeto = this.stats.peakVeto || { stamped: 0, wouldBlock: 0, unstamped: 0 };
    if (f && f.distFromPeakPct != null) {
      this.stats.peakVeto.stamped++;
      if (f.peakVeto && f.peakVeto.wouldBlock) this.stats.peakVeto.wouldBlock++;
    } else this.stats.peakVeto.unstamped++;
    return f;
  }

  // Holder-count sampling, second source (record-only, 2026-10-14): a Helius
  // DAS token-account count (gate.js fetchHolderCount, wired as a dep) rides
  // alongside every RugCheck fetch that feeds the holder series — gate eval,
  // shadow gate record, manual-exit snapshot — so mints RugCheck has no
  // report for still accumulate holder samples and holderGrowth can fill.
  // The result is NEVER read: no gate, skip, or buy branches on it, and the
  // helper resolves null on knob-off, missing dep, or any DAS failure, so a
  // dark DAS leaves behavior byte-identical to the RugCheck-only path.
  async _dasHolderSample(mint) {
    try {
      if (!this.cfg.holderDas || !this.d.fetchHolderCount) return null;
      return await this.d.fetchHolderCount(mint);
    } catch { return null; }
  }

  skip(v, sig, reasons, warnings = [], gates = null, gatePass = null, shadowGates = null, shadowGatePass = null) {
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'skipped', reasons, price: v.price, mc: v.mc, metrics: sig.metrics, warnings, label: sig.label || null, gates, gatePass, fields: this._signalFields(v, sig.metrics), shadowGates, shadowGatePass });
  }

  // Setups currently in shadow-only mode (user 2026-10-14, forward plan step 1b):
  // the detector still fires and the signal is journaled + outcome-tracked, but it
  // never reaches the gate/risk/buy machinery and never touches the position slot.
  shadowedSetup(setup) {
    return (setup === 'trend' && !!this.cfg.trendShadow) || (setup === 'liftoff' && !!this.cfg.liftoffShadow);
  }

  shadow(v, sig, gates = null, gatePass = null) {
    this.stats.shadowSignals = this.stats.shadowSignals || {};
    this.stats.shadowSignals[sig.setup] = (this.stats.shadowSignals[sig.setup] || 0) + 1;
    const sigId = this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'shadow', reasons: [sig.shadowReason || `shadow: ${sig.setup} is shadow-only — logged + outcome-tracked, no buy`], price: v.price, mc: v.mc, metrics: sig.metrics, warnings: [], label: sig.label || null, gates, gatePass, fields: this._signalFields(v, sig.metrics) });
    // Trade-grade shadow (record-only, user 2026-10-14): a shadow signal that
    // PASSED its gate evaluation opens a VIRTUAL position at the signal
    // price, managed by the real exit stack (src/shadowTrades.js) — the
    // signal record and flow above stay byte-identical; this only registers
    // the tracker. Gate-failed shadow signals open nothing.
    if (gatePass === true) {
      try {
        if (this.shadowTrades.open({ id: sigId, mint: v.address, symbol: v.symbol, setup: sig.setup, price: v.price, mc: v.mc, ts: this.now(), sizeSol: this.cfg.tradeSol, volH1: v.volH1 || 0 })) {
          this._syncShadowStats();
          // stream judge (record-only): the virtual's entry price in SOL/token,
          // captured at open from the same SOL/USD the bot just saw — the stream
          // judge measures its move off this, never off a later rate.
          const st = this._shadowStreamStateFor(sigId);
          st.mint = v.address;
          st.entryPriceSol = this.lastSolUsd > 0 ? v.price / this.lastSolUsd : null;
        }
      } catch { /* observer only — never disturb the signal path */ }
    }
  }

  // Ran-rebuy verdict (user 2026-10-15): the already-ran rebuy check from
  // gate.js, reached through the optional ranRebuyCheck dep (wired in
  // index.js; absent in unit rigs → no verdict and the gate simply doesn't
  // run). Only mints with a prior closed trade are judged at all — a mint the
  // bot never traded returns null here (no stamp, no candle lookup spent).
  // Never throws: a dep error reads as a failed lookup, which the check
  // treats as fail-open. Returns the verdict object or null.
  async _ranRebuyVerdict(v, n) {
    if (!this.cfg.ranRebuy || !this.d.ranRebuyCheck) return null;
    const prior = this.lastTrades ? this.lastTrades.get(v.address) : null;
    if (!prior) return null;
    try {
      return await this.d.ranRebuyCheck(prior, { mult: this.cfg.ranRebuyMult, hours: this.cfg.ranRebuyHours, now: n });
    } catch {
      return { pass: true, lookupFailed: true, peakRatio: null, blockedUntil: null, priorCloseTs: prior.closeTs, reason: 'ran-peak lookup failed — passed open (fail-open)' };
    }
  }

  // D1 (record-only): for a shadow signal, evaluate the same pre-checks and gate
  // stack a live signal would face — purely so the shadow RECORD carries the
  // per-gate results. The outcome is never branched on: the caller journals
  // decision 'shadow' regardless, and no risk/round-trip/buy step runs here.
  // Fail-silent: any error yields a null gate record, never a behavior change.
  async shadowGateRecord(v, sig, n) {
    try {
      const checks = {};
      if (!(sig.metrics && sig.metrics.fastStream)) {
        const ex = extensionCheck(this.history.get(v.address), v.price, n, { maxExt: this.cfg.extMaxFromBase });
        checks.extension = { pass: !!ex.pass, reason: ex.reason || null };
        const fc = freshHistoryCheck(this.history.get(v.address), v, n, { maxChgM5: this.cfg.freshMaxChgM5, smallMc: this.cfg.freshSmallMc, m5ShareH1: this.cfg.freshM5ShareH1, bypassMinVolM5: this.cfg.freshBypassMinVolM5, bypassMinBuyRatio: this.cfg.freshBypassMinBuyRatio, bypassMaxBuyRatio: this.cfg.maxBuyRatioM5 > 0 ? this.cfg.maxBuyRatioM5 : 0.85 });
        checks.fresh = { pass: !!fc.pass, reason: fc.reason || null };
        if (fc.bypass) checks.fresh.bypassed = true;
        if (sig.setup === 'pop' || sig.setup === 'trend' || sig.setup === 'liftoff') {
          const sd = shallowDipCheck(this.history.get(v.address), v.price, n, { maxPct: this.cfg.shallowDipMaxPct, windowMin: this.cfg.shallowDipWindowMin });
          checks.shallowDip = { pass: !!sd.pass, reason: sd.reason || null };
        }
      }
      // Flow snapshot verdict for the record (user 2026-10-15): the same
      // collapse check the live flow path runs — journaled here so records
      // written before the live check is reached (shadow, risk-preempted)
      // carry it too. Record-only in this path, never branched on.
      if (sig.setup === 'flow') {
        const fs = flowSnapshotCheck(v, { minChgM5: this.cfg.flowSnapshotMinChgM5 });
        checks.flowSnapshot = { pass: !!fs.pass, reason: `flow snapshot: ${fs.reason}` };
      }
      // Ran-rebuy verdict for the record (user 2026-10-15): the same
      // already-ran check the gate path runs — journaled here so shadow
      // records and the scans.jsonl verdicts (walletWatch's shadowGates dep
      // lands here) carry it too. Record-only, never branched on; the peak
      // measurement is cached 5 min per mint, so a mint the live path just
      // judged costs no second lookup.
      const rrRec = await this._ranRebuyVerdict(v, n);
      if (rrRec) checks.ranRebuy = { pass: !!rrRec.pass, reason: rrRec.reason || null, peakRatio: rrRec.peakRatio ?? null, blockedUntil: rrRec.blockedUntil ?? null };
      const [rug, curve] = await Promise.all([
        this.d.fetchRug(v.address).catch(() => null),
        this.d.fetchCurve ? this.d.fetchCurve(v.address).catch(() => null) : null,
        this._dasHolderSample(v.address),
      ]);
      const { cfg: gateCfg } = this.paceCfg(n);
      const g = runGates({ view: v, rug, curve, cfg: gateCfg, now: n });
      Object.assign(checks, summarizeGateChecks(g.checks) || {});
      return { gates: checks, gatePass: g.pass };
    } catch { return { gates: null, gatePass: null }; }
  }

  // ------------------------------------------------------------ churn basing watch
  // A coin that dumped ≥ churnMinDropPct from its sampled peak gets pinned in the
  // watchlist for churnWatchH hours past the normal TTL, so its basing phase stays
  // sampled (a dumped coin otherwise falls off discovery within ~20 minutes and the
  // churn detector never sees the base form). Capped, oldest pin evicted first.
  _updateChurnPins(mint, n) {
    const a = this.history.get(mint);
    if (a.length >= 2) {
      let peak = 0, low = Infinity;
      for (const s of a) { if (s.price > peak) peak = s.price; if (s.price < low) low = s.price; }
      if (peak > 0 && low > 0 && (peak - low) / peak * 100 >= this.cfg.churnMinDropPct) {
        const existing = this.churnPins.get(mint);
        this.churnPins.set(mint, { at: existing ? existing.at : n, until: n + this.cfg.churnWatchH * 3600000 });
      }
    }
    if (this.churnPins.size > this.cfg.churnWatchMax) {
      const sorted = [...this.churnPins.entries()].sort((x, y) => x[1].at - y[1].at);
      for (const [m] of sorted.slice(0, this.churnPins.size - this.cfg.churnWatchMax)) this.churnPins.delete(m);
    }
  }

  churnPinned(mint, n) {
    const p = this.churnPins.get(mint);
    if (!p) return false;
    if (n > p.until) { this.churnPins.delete(mint); return false; }
    return true;
  }

  // ------------------------------------------------------------ graduation handoff
  // A coin already on the watchlist that GRADUATES mid-watch gets a fresh full TTL
  // from the graduation moment (user 2026-10-14). Without this, a coin that sat
  // quiet on the curve for most of WATCH_TTL_MIN flips to PumpSwap just as its
  // watch entry expires — the post-graduation run (Plois: +41% in the 5m right
  // after the flip) happens with the bot no longer sampling it. The flip signal is
  // the view's dex: 'pumpfun' (bonding curve) on one poll, any AMM dex on a later
  // poll. selectView's live-AMM preference makes the flip visible as soon as the
  // PumpSwap pair prints trades. One-shot per mint: once flipped, the mint leaves
  // curveSeen and normal TTL/discovery rules govern it from the refreshed entry.
  _noteGraduation(mint, v, n) {
    if (!v || !v.dex) return;
    if (v.dex === 'pumpfun') { this.curveSeen.add(mint); return; }
    if (!this.curveSeen.delete(mint)) return; // only a mint previously seen on the curve can flip
    const w = this.watch.get(mint);
    if (!w) return;
    this.watch.set(mint, { ...w, ts: n });
    this.stats.gradHandoffs = (this.stats.gradHandoffs || 0) + 1;
    console.log(`[gradwatch] ${v.symbol} graduated (curve → ${v.dex}) — watch TTL refreshed`);
  }

  // ------------------------------------------------------------ smart-wallet flow
  /**
   * Flow live eligibility (user 2026-10-15): with FLOW_LIVE_WALLETS set, only a
   * SOLO trigger fired by one of those wallets may reach the live pipeline —
   * through exactly the same gates/checks as any flow trigger today. Every
   * other trigger (the other solos, size triggers, confluence — even a
   * confluence a live wallet took part in) is journaled as a shadow signal:
   * detected, labelled, outcome-tracked, never bought. Knob unset (null) =
   * legacy: every trigger is live-eligible.
   */
  flowLiveTrigger(agg) {
    const live = this.cfg.flowLiveWallets;
    if (!live) return true;
    return !!(agg && agg.kind === 'solo' && agg.wallet && live.includes(agg.wallet));
  }

  /**
   * A 'flow' trigger from the FlowWatch poller (tracked smart-wallet buys).
   * Mirrors _evalFastPop: position + per-mint signal-cooldown guards, the shared
   * eligible() tradability floor, then the exact same onSignal pipeline — gates,
   * risk, exits all unchanged. The wallet nominates; it never bypasses.
   */
  async _evalFlow(mint, agg) {
    const n = this.now();
    const views = await this.d.fetchViews([mint]).catch(() => null);
    const v = views && views.get(mint);
    if (!v) { this._queueFlowRetry(mint, agg, n); return; }
    if (this.flowPending) this.flowPending.delete(mint);
    this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n);
    this.noteMint(mint, 'flow'); // keep sampling it so classic/churn detectors can judge it too
    const metrics = { wallets: agg.wallets || [], maxSol: agg.maxSol || 0, count: agg.count || 0, kind: agg.kind || null, wallet: agg.wallet || null, walletSol: agg.walletSol != null ? agg.walletSol : null, buyTs: agg.buyTs || null }; // wallet/walletSol/buyTs: the firing wallet's attribution (flow-exit watcher, record-only)
    // User (2026-10-15): a tracked wallet's buy must LAND on the signals feed
    // whether or not the coin passes parameters — the guards below used to
    // swallow triggers whole (no record at all, so the buy was invisible and
    // its impact unmeasurable). Now a blocked trigger still journals a
    // record-only signal (decision 'skipped', the blocker as its reason, the
    // wallet label intact) so it shows on the feed and gets outcome-tracked.
    // What proceeds still faces the exact same pipeline; nothing about buying
    // changes — the gates judge, the record just always exists.
    const blocked = [];
    if (this.positions.some(p => p.mint === mint)) blocked.push('already holding this coin — buy recorded, not re-evaluated');
    else if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) blocked.push(`this coin was already signaled in the last ${this.cfg.signalCooldownMin}m — buy recorded, not re-evaluated`);
    if (!blocked.length) { const el = eligible(v, this.cfg, n); if (el.length) blocked.push(...el); }
    if (blocked.length) { this._recordFlowOnly(v, agg, metrics, blocked, n); return; }
    this.lastSignal.set(mint, n);
    this.stats.flow = this.stats.flow || { fires: 0 };
    // Flow shadow-only split (user 2026-10-15): a non-live trigger proceeds to
    // the same onSignal pipeline carrying flowShadowOnly — it journals there
    // as decision 'shadow' (the trend/liftoff treatment) and never buys. The
    // guards above already ran identically for both paths, so a live wallet's
    // trigger faces exactly the checks it always did, cooldown included.
    const live = this.flowLiveTrigger(agg);
    if (live) {
      this.stats.flow.fires++;
      console.log(`[flow] ${v.symbol} fired from wallet flow: ${agg.label}`);
    } else {
      this.stats.flow.shadow = (this.stats.flow.shadow || 0) + 1;
      console.log(`[flow] ${v.symbol} flow trigger is shadow-only (not a live-flow wallet) — logged + outcome-tracked, no buy: ${agg.label}`);
    }
    await this.onSignal(v, { setup: 'flow', strength: agg.maxSol || 0, metrics, label: agg.label || null, flowShadowOnly: !live, shadowReason: live ? null : 'shadow: flow is shadow-only for this wallet — logged + outcome-tracked, no buy' });
  }

  /** Journal a flow buy that a pipeline guard kept out of evaluation (record-only). */
  _recordFlowOnly(v, agg, metrics, reasons, n) {
    this.stats.flow = this.stats.flow || { fires: 0 };
    // One record-only entry per mint per cooldown window — a wallet dribbling
    // buys into the same coin must not spam the feed.
    this.flowOnlyAt = this.flowOnlyAt || new Map();
    if (n - (this.flowOnlyAt.get(v.address) || 0) < this.cfg.signalCooldownMin * 60000) return;
    this.flowOnlyAt.set(v.address, n);
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: 'flow', decision: 'skipped', reasons, price: v.price, mc: v.mc, metrics, label: agg.label || null, fields: this._signalFields(v, metrics) });
    this.stats.flow.recordOnly = (this.stats.flow.recordOnly || 0) + 1;
    console.log(`[flow] ${v.symbol} recorded (not evaluated: ${reasons[0]}) — ${agg.label}`);
  }

  /** A flow trigger whose mint has no DexScreener view yet (a just-launched coin
   *  often isn't indexed for the first seconds): queue it and retry for up to
   *  5 minutes instead of dropping it silently. If no view ever appears the
   *  mint can't be priced or outcome-tracked, so it is counted and dropped. */
  _queueFlowRetry(mint, agg, n) {
    this.flowPending = this.flowPending || new Map();
    const cur = this.flowPending.get(mint);
    if (cur) { cur.agg = agg; return; }
    this.flowPending.set(mint, { agg, firstTs: n, nextAt: n + 20000 });
  }

  async _flowRetryTick(n) {
    if (!this.flowPending || !this.flowPending.size) return;
    for (const [mint, p] of [...this.flowPending]) {
      if (n - p.firstTs > 5 * 60000) {
        this.flowPending.delete(mint);
        this.stats.flow = this.stats.flow || { fires: 0 };
        this.stats.flow.noViewDropped = (this.stats.flow.noViewDropped || 0) + 1;
        console.log(`[flow] ${String(mint).slice(0, 4)}… dropped — no market view within 5m of the wallet buy`);
        continue;
      }
      if (n < p.nextAt) continue;
      p.nextAt = n + 20000;
      await this._evalFlow(mint, p.agg); // re-queues itself (same entry) if the view is still missing
    }
  }

  async onSignal(v, sig) {
    this.stats.signals++;
    const n = this.now();
    // D1 (record-only): per-check results accumulate here as the pipeline runs,
    // so the signal record (skip / shadow / taken) shows EVERY check's verdict,
    // not just the one that stopped it. Never read for any decision.
    const checks = {};
    // User blacklist (per-token): if they've marked this specific mint as bad, skip it
    const blacklistedMints = this.journal.blacklistedMints();
    if (blacklistedMints.has(v.address)) {
      console.log(`[learn] skip: user blacklisted token ${v.symbol} — skipping`);
      checks.userBlacklist = { pass: false, reason: `token "${v.symbol}" marked bad by user` };
      return this.skip(v, sig, [`user-blacklist: token "${v.symbol}" marked bad`], [], checks);
    }
    // User blacklist (setup): configurable via SETUP_BLACKLIST_MIN (0 = off, per-token only)
    const blacklisted = this.cfg.setupBlacklistMin > 0 ? this.journal.blacklistedSetups(this.cfg.setupBlacklistMin) : new Set();
    if (blacklisted.has(sig.setup)) {
      console.log(`[learn] skip: user blacklisted setup "${sig.setup}" — skipping ${v.symbol}`);
      checks.setupBlacklist = { pass: false, reason: `setup "${sig.setup}" marked bad ${10}+ times` };
      return this.skip(v, sig, [`user-blacklist: setup "${sig.setup}" marked bad ${10}+ times`], [], checks);
    }
    // User name block (2026-10-13): any coin whose name contains a blocked word (default "inu")
    // is hard-skipped. Sits before runGates, so no pace boost, mandatory-ape forcing or
    // contested-gate override can let one through.
    const blockedWord = blockedNameWord(v.name, this.cfg.nameBlockWords);
    if (blockedWord) {
      console.log(`[nameblock] skip: "${v.name}" contains blocked word "${blockedWord}"`);
      checks.nameblock = { pass: false, reason: `name "${v.name || v.symbol}" contains blocked word "${blockedWord}"` };
      return this.skip(v, sig, [`nameblock: name "${v.name || v.symbol}" contains blocked word "${blockedWord}"`], [], checks);
    }
    // Ran-rebuy block (user 2026-10-15, "for tonight" — RAN_REBUY lifts it):
    // a mint the bot already traded whose coin already printed >= RAN_REBUY_MULT x
    // that trade's entry price (at any point since the entry, the exit
    // included — BOOT was ridden 2026-10-14 and re-bought the next night after
    // its run was over) cannot be re-bought until RAN_REBUY_HOURS after that
    // trade's close. Mint-exact, anchored on the most recent prior close,
    // judged on GeckoTerminal minute candles vs the journaled entry fill.
    // Sits with the other user-ruling vetoes before runGates, so no pace
    // boost, mandatory-ape forcing or contested-gate override can push a
    // re-run through; the wait's expiry re-allows the rebuy regardless of the
    // run. Fail-open: an unmeasurable peak passes the candidate (counted in
    // stats.ranRebuy).
    {
      const rr = await this._ranRebuyVerdict(v, n);
      if (rr) {
        this.stats.ranRebuy = this.stats.ranRebuy || { blocked: 0, lookupFailed: 0 };
        if (rr.lookupFailed) this.stats.ranRebuy.lookupFailed++;
        checks.ranRebuy = { pass: !!rr.pass, reason: rr.reason || null, peakRatio: rr.peakRatio ?? null, blockedUntil: rr.blockedUntil ?? null };
        if (!rr.pass) {
          this.stats.ranRebuy.blocked++;
          sig.metrics = sig.metrics || {};
          sig.metrics.ranRebuy = { peakRatio: rr.peakRatio ?? null, priorCloseTs: rr.priorCloseTs ?? null, blockedUntil: rr.blockedUntil ?? null };
          console.log(`[ranrebuy] skip: ${v.symbol} — ${rr.reason}`);
          return this.skip(v, sig, [`ranRebuy: ${rr.reason}`], [], checks);
        }
      }
    }
    // Shadow-only setups (user 2026-10-14, forward plan step 1b): a shadowed setup's
    // signal is journaled with decision 'shadow' — journal.signal registers it for the
    // same r5/r15/r60 outcome tracking every taken/skipped signal gets — and the
    // pipeline stops here as a TRADING matter: no risk check, no buy, no position,
    // stats.entries untouched. User vetoes above (blacklists, name block) still journal
    // as ordinary skips, exactly as before. D1 adds one record-only step: the
    // extension/fresh/shallow-dip checks and the gate stack are evaluated into the
    // record (shadowGateRecord) — their results change nothing.
    if (this.shadowedSetup(sig.setup) || sig.flowShadowOnly) {
      console.log(`[shadow] ${v.symbol} (${sig.setup}) — shadow-only: logged + outcome-tracked, no buy`);
      // D1: the gates are still EVALUATED for the record (shadowGateRecord) —
      // the decision stays 'shadow' whatever they say.
      const sg = await this.shadowGateRecord(v, sig, n);
      return this.shadow(v, sig, sg.gates, sg.gatePass);
    }
    // Extension cap (user 2026-10-13): how far above the trailing-hour sampled low — the base
    // the move broke out from — an entry may sit. OTTO was bought at the ceiling of a long
    // range after a +162%/5m print and stopped 23s later by the range's own chop; at extreme
    // extension, an ordinary retracement toward the base is a full stop-out. Classic entries
    // only (pop + trend), judged on the bot's own samples, fail-open on thin history.
    // Fast-stream pops are EXEMPT: their 90s window IS the breakout measurement — they enter
    // near the launch by construction.
    if (!(sig.metrics && sig.metrics.fastStream)) {
      const ex = extensionCheck(this.history.get(v.address), v.price, n, { maxExt: this.cfg.extMaxFromBase });
      checks.extension = { pass: !!ex.pass, reason: ex.reason || null };
      if (!ex.pass) {
        console.log(`[extension] skip: ${v.symbol} — ${ex.reason}`);
        return this.skip(v, sig, [`extension: ${ex.reason}`], [], checks);
      }
    }
    // Fresh-history fail-closed (user 2026-10-13, entry-fixes A3): a coin discovered mid-run
    // (trending/movers lists) with too little sampled history for the guards above to judge
    // gets judged on DexScreener's aggregates instead of waved through — BORING arrived with
    // no samples at +41.6% in 5m on a $14.5k cap and the sample guard passed it by default.
    // Fast-stream pops exempt (the stream IS the history).
    if (!(sig.metrics && sig.metrics.fastStream)) {
      const fc = freshHistoryCheck(this.history.get(v.address), v, n, { maxChgM5: this.cfg.freshMaxChgM5, smallMc: this.cfg.freshSmallMc, m5ShareH1: this.cfg.freshM5ShareH1, bypassMinVolM5: this.cfg.freshBypassMinVolM5, bypassMinBuyRatio: this.cfg.freshBypassMinBuyRatio, bypassMaxBuyRatio: this.cfg.maxBuyRatioM5 > 0 ? this.cfg.maxBuyRatioM5 : 0.85 });
      checks.fresh = { pass: !!fc.pass, reason: fc.reason || null };
      if (fc.bypass) checks.fresh.bypassed = true;
      if (!fc.pass) {
        console.log(`[fresh] skip: ${v.symbol} — ${fc.reason}`);
        return this.skip(v, sig, [`fresh: ${fc.reason}`], [], checks);
      }
      if (fc.bypass) {
        // the flow bypass lifted the fresh move cap (user 2026-10-14) — leave the mark on the
        // signal's journaled metrics so the entry's record shows why it was let in
        sig.metrics = sig.metrics || {};
        sig.metrics.freshBypass = fc.bypass;
        console.log(`[fresh] bypass: ${v.symbol} — ${fc.reason}`);
      }
    }
    // Flow-entry snapshot collapse check (user 2026-10-15, from the DACITY forensic):
    // a flow entry fires on a tracked wallet's buy and carries NO detector price-shape
    // of its own — pop/trend/liftoff/fast-pop signals can only exist while their
    // shape legs hold, so a mid-collapse coin never produces them, but DACITY's flow
    // entry was taken with chgM5 -41.8% printed in its own snapshot (~62% under the
    // peak) because nothing in the shared stack reads the downside of that print:
    // the fresh check above caps only the upside and only on thin history. Judge the
    // flow entry on its own snapshot here (gate.js flowSnapshotCheck); flow only —
    // every other setup's pipeline is byte-identical.
    if (sig.setup === 'flow') {
      const fs = flowSnapshotCheck(v, { minChgM5: this.cfg.flowSnapshotMinChgM5 });
      checks.flowSnapshot = { pass: !!fs.pass, reason: `flow snapshot: ${fs.reason}` };
      if (!fs.pass) {
        console.log(`[flow] skip: ${v.symbol} — flow snapshot: ${fs.reason}`);
        return this.skip(v, sig, [`flow snapshot: ${fs.reason}`], [], checks);
      }
    }
    // Shallow-dip veto (user 2026-10-14): classic entries (pop + trend + liftoff) may be
    // taken at the trailing-hour sampled top, breaking above it, or on a real dip
    // (SHALLOW_DIP_MAX_PCT or more under the top, deep dips included) — but not a few
    // percent under the top, which is the rollover spot (his example: -5% under).
    // Judged on the bot's own samples, fail-open on thin history. This replaces the
    // stale-pop veto (removed earlier today for CODE): a signal 10%+ under its sampled
    // high is NOT distance-vetoed by anything anymore — each setup's own volume /
    // buy-inflow legs judge deep dips. Fast-stream pops are EXEMPT: they judge their
    // own 90s window, and their max-drop rule already pins entries near the stream peak.
    if (!(sig.metrics && sig.metrics.fastStream) && (sig.setup === 'pop' || sig.setup === 'trend' || sig.setup === 'liftoff')) {
      const sd = shallowDipCheck(this.history.get(v.address), v.price, n, { maxPct: this.cfg.shallowDipMaxPct, windowMin: this.cfg.shallowDipWindowMin });
      checks.shallowDip = { pass: !!sd.pass, reason: sd.reason || null };
      if (!sd.pass) {
        console.log(`[shallowdip] skip: ${v.symbol} — ${sd.reason}`);
        return this.skip(v, sig, [`shallow dip: ${sd.reason}`], [], checks);
      }
    }
    // Re-entry quality: same coin signaled again — only re-enter on a dip, never the top of a green candle.
    // Require price at least 20% below the recent 15-min high (unless it's a fresh pop breakout).
    if (this.enteredMints.has(v.address) && sig.setup !== 'pop') {
      const samples = this.history.get(v.address) || [];
      const recent = samples.filter(s => this.now() - s.ts <= 15 * 60 * 1000);
      const high = recent.length ? Math.max(...recent.map(s => s.price)) : v.price;
      if (v.price >= high * 0.8) {
        console.log(`[reentry] skip: ${v.symbol} at top (price within 20% of 15m high) — waiting for dip`);
        checks.reentry = { pass: false, reason: 'no dip (price within 20% of recent high)' };
        return this.skip(v, sig, [`reentry: no dip (price within 20% of recent high)`], [], checks);
      }
    }
    const [solUsd, walletSol] = await Promise.all([this.d.fetchSolUsd(), this.exec.solBalance()]);
    const open = this.positions.reduce((a, p) => a + p.entrySol * p.remainingFrac, 0);
    this.risk.checkKill(walletSol, open);
    this.risk.checkBalanceHalt(walletSol, open);

    const size = this.risk.sizeFor(v.liq, solUsd);
    const gate0 = this.risk.canEnter({ mint: v.address, walletSol, openCount: this.positions.length, sizeSol: size, halted: this.halted() });
    if (!gate0.ok) {
      checks.risk = { pass: false, reason: gate0.reason || null };
      // Freeze work 1b (record-only, user 2026-10-14): a risk-layer preemption
      // used to end the pipeline here, so the record never showed whether the
      // GATE STACK would have passed the coin — the gate-pricing question was
      // unanswerable for exactly the halted/streak-paused stretches. Evaluate
      // the same checks + gate stack in shadow (the D1 shadowGateRecord
      // mechanism) and journal the would-be verdict as shadowGates /
      // shadowGatePass. The live outcome is byte-identical: same decision,
      // same `risk: ...` reason, no buy path entered, no slot touched — the
      // shadow result is never branched on. (The later gate1 re-check needs
      // no shadow verdict: the real gates already ran by then and their
      // results are on that record.)
      const sg = await this.shadowGateRecord(v, sig, n);
      return this.skip(v, sig, [`risk: ${gate0.reason}`], [], checks, null, sg.gates, sg.gatePass);
    }

    // one-trade temporary rules (user-set via POST /temprules; cleared on the next executed entry)
    if (this.stats.tempRules) {
      const violation = tempRuleViolation(v, sig.metrics, this.stats.tempRules);
      if (violation) { checks.tempRule = { pass: false, reason: violation }; return this.skip(v, sig, [violation], [], checks); }
    }

    // gates: RugCheck + curve history in parallel (the DAS holder sample rides
    // along record-only; its result is deliberately not destructured or read)
    const [rug, curve] = await Promise.all([
      this.d.fetchRug(v.address).catch(() => null),
      this.d.fetchCurve ? this.d.fetchCurve(v.address).catch(() => null) : null,
      this._dasHolderSample(v.address),
    ]);
    // Pace keeper: if behind the hourly target, use relaxed gate thresholds
    const { cfg: gateCfg, boosted, pace } = this.paceCfg(n);
    const g = runGates({ view: v, rug, curve, cfg: gateCfg, now: n });
    // D1: the full per-gate map joins the pipeline checks for the record
    Object.assign(checks, summarizeGateChecks(g.checks) || {});
    if (!g.pass) {
      // Mandatory ape mode: if under N entries/hour, force through soft gate fails only.
      // Structural (HARD_GATES) fails are never forced — that bypass is what let rigged launches in.
      const hourEntries = this.entryTimes.filter(t => t > n - 3600000).length;
      const unsurvivable = hasHardFail(g.fails) || (g.fails || []).some(f => /^(rugged|mintAuthority|freezeAuthority)/.test(String(f).split(':')[0]));
      const mandatoryTarget = this.cfg.mandatoryApesPerHour || 0;
      if (mandatoryTarget > 0 && hourEntries < mandatoryTarget && !unsurvivable) {
        console.log(`[mandatory] forcing ${v.symbol} through gates (${hourEntries}/${mandatoryTarget} this hour) — skipped: ${g.fails.join('; ').slice(0, 120)}`);
        // Don't skip, continue to round-trip check below
      } else {
        // User override: if ALL failing gates are contested by the user (they marked
        // 3+ similar skips as "good"), don't skip — let it through with a warning.
        const contested = this.journal.contestedGates();
        const failReasons = g.fails.map(f => String(f).split(':')[0]);
        const allContested = failReasons.length > 0 && failReasons.every(r => contested.has(r));
        // Structural gates (insiders, farm, SOL-side depth, ladder, mint/freeze, ...) can NEVER be overridden
        if (allContested && !hasHardFail(g.fails)) {
          console.log(`[learn] override: user contested gates ${failReasons.join(',')} — letting ${v.symbol} through`);
          // Don't skip, continue to round-trip check below
        } else {
          return this.skip(v, sig, g.fails, g.warnings, checks, g.pass);
        }
      }
    }

    // exit-value check: price a buy AND the immediate sell-back before spending anything
    let rt;
    try { rt = await this.exec.roundTrip(v.address, size); }
    catch (e) { checks.roundtrip = { pass: false, reason: `no sellable route (${e.message})` }; return this.skip(v, sig, [`roundtrip: no sellable route (${e.message})`], g.warnings, checks, g.pass); }
    checks.roundtrip = { pass: rt.ratio >= this.cfg.minRoundTrip, reason: `sell-back worth ${(rt.ratio * 100).toFixed(0)}% of spend` };
    if (rt.ratio < this.cfg.minRoundTrip) return this.skip(v, sig, [`roundtrip: sell-back worth ${(rt.ratio * 100).toFixed(0)}% of spend < ${(this.cfg.minRoundTrip * 100).toFixed(0)}% (impact ${rt.impactPct.toFixed(1)}%)`], g.warnings, checks, g.pass);

    // Price-move vetoes REMOVED 2026-10-12 (user order): both the quote-level freshness
    // guard (±10% vs decision price) and the older DexScreener re-pull check (-30%/+100%)
    // rejected any coin that moved while the gates were running — the user wants the buy
    // to go through at whatever the live price is. Entries are instant from here.

    // re-check limits right before spending (state may have changed during the awaits above)
    const gate1 = this.risk.canEnter({ mint: v.address, walletSol: await this.exec.solBalance(), openCount: this.positions.length, sizeSol: size, halted: this.halted() });
    if (!gate1.ok) { checks.risk = { pass: false, reason: gate1.reason || null }; return this.skip(v, sig, [`risk: ${gate1.reason}`], g.warnings, checks, g.pass); }

    let fill;
    try { fill = await this.exec.buy(v.address, size, rt.buyQuote); }
    catch (e) { this.err('buy', e); checks.exec = { pass: false, reason: `buy failed (${e.message})` }; return this.skip(v, sig, [`exec: buy failed (${e.message})`], g.warnings, checks, g.pass); }

    // D1 (record-only): entry-time facts the close record will need — token
    // decimals + the real buy fill (SOL per whole token, from the executed
    // quote) + SOL/USD at entry, the full per-check map, and this build's
    // config stamp. None of these are read by any trading decision.
    const dec = rug && rug.token && rug.token.decimals != null ? Number(rug.token.decimals) : null;
    const tokensWhole = dec != null && Number(fill.tokensRaw) > 0 ? Number(fill.tokensRaw) / 10 ** dec : null;
    const pos = {
      id: `${v.address.slice(0, 6)}-${n}`, mint: v.address, symbol: v.symbol, setup: sig.setup,
      entryTs: n, entrySol: fill.solSpent, tokensRaw: fill.tokensRaw, entryTokensRaw: fill.tokensRaw, remainingFrac: 1, peakRatio: 1, tp1Done: false, tp2Done: false, tp1Arm: null, flowHist: [], suspectUnbookedSell: false,
      entryPrice: v.price, entryMc: v.mc, realizedSol: 0, simulated: fill.simulated, sigBuy: fill.sig, markFails: 0,
      stamp: this.cfgStamp, gates: checks, gatePass: g.pass, decimals: dec,
      entryFillSol: tokensWhole > 0 ? fill.solSpent / tokensWhole : null, solUsdEntry: solUsd || null, ticks: [],
      entryVolH1: v.volH1 || 0,
      entryRoundTrip: rt.ratio, peakMove: 1, stopArmedTs: null, floorChecks: 0, floorSince: null, probationSince: null, moveHist: [], exitPending: {}, feesSol: this.cfg.txFeeSol || 0, // buy tx fee // entry stall: price is at entry (move 1.0) by definition; the 60s clock runs from entryTs
      bw: { tracked: null, supply: rug && rug.token ? Number(rug.token.supply) || 0 : 0, creator: rug && rug.creator ? String(rug.creator) : null, weights: linkedWeights(rug), snaps: [], vals: [], lastTs: 0, trimmed: false },
      entry: snapshotFeatures({ v, sig, rug, g, now: n }), lastTickTs: 0, lastChainTs: 0, chainDropStrikes: 0,
    };
    this.positions.push(pos); this.savePositions();
    this.enteredMints.add(v.address); this.saveEnteredMints();
    this.risk.recordEntry(v.address);
    this.stats.entries++;
    this.entryTimes.push(n);
    // Callout Shadow Lab (record-only): the would-call for this entry is
    // journaled whether or not live callouts are on — the lab scores what a
    // follower would have made. Fire-and-forget; it can never post or trade.
    this.calloutLab.record({ trigger: 'entry', ts: n, mint: v.address, symbol: v.symbol, v, sig, setup: sig.setup, source: 'entry', holding: true, linkId: pos.id }).catch(() => {});
    // Fire a pump.fun callout for this entry (non-blocking; rewards accrue to the user).
    // The thesis is generated from the signal that triggered the entry.
    // GATED (user 2026-10-15): live callouts OFF unless CALLOUTS_ENABLED=1 —
    // postCallout is gated internally too, so a disabled bot makes no attempt.
    if (this.cfg.calloutsEnabled) {
      postCallout(v, sig, { enabled: true }).then(r => {
        console.log('[callout] posted for', v.symbol);
        this.lastCallout = { ok: true, symbol: v.symbol, ts: Date.now() };
      }).catch(e => {
        console.log('[callout] failed:', e.message);
        this.lastCallout = { ok: false, error: e.message, symbol: v.symbol, ts: Date.now() };
      });
    }
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'taken', reasons: [], price: v.price, mc: v.mc, metrics: { ...sig.metrics, roundTrip: +rt.ratio.toFixed(3), sizeSol: size }, warnings: g.warnings, label: sig.label || null, gates: checks, gatePass: g.pass, fields: this._signalFields(v, sig.metrics) });
    this.journal.trade({ type: 'open', id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, sig: fill.sig, simulated: fill.simulated, ts: n, stamp: pos.stamp, tokensRaw: fill.tokensRaw, entryFillSol: pos.entryFillSol, entryFillUsd: pos.entryFillSol != null && solUsd > 0 ? +(pos.entryFillSol * solUsd).toFixed(10) : null });
    // Flow-Exit Watcher (record-only): a flow-triggered entry starts a watch
    // on the wallet whose buy nominated it — its trim/exit get journaled and
    // scored against this position's own close in ensureClose. No-op for
    // every other setup and whenever the trigger wallet is unresolvable.
    try { if (this.flowExits) this.flowExits.start(pos, sig); } catch { /* observer only — never disturb trading */ }
    // one-trade rules are spent the moment an entry executes
    if (this.stats.tempRules) { console.log(`[temp] one-trade rules spent on ${pos.symbol} — cleared`); this.stats.tempRules = null; this.saveStats(); }
  }

  // Arm (or clear, with an empty body) the one-trade temporary entry rules.
  // Persisted in stats so a restart can't quietly drop or resurrect them.
  setTempRules(rules) {
    if (!rules || (!(rules.maxMc > 0) && !(rules.maxDropPct > 0))) this.stats.tempRules = null;
    else this.stats.tempRules = { maxMc: rules.maxMc > 0 ? Number(rules.maxMc) : 0, maxDropPct: rules.maxDropPct > 0 ? Number(rules.maxDropPct) : 0, armedTs: this.now() };
    this.saveStats();
    return this.stats.tempRules;
  }

  // ------------------------------------------------------------ position management
  async positionTick() {
    if (this.busy.pos || !this.positions.length) return;
    this.busy.pos = true;
    try {
      const solUsd = await this.d.fetchSolUsd();
      this.lastSolUsd = solUsd || this.lastSolUsd;
      for (const pos of [...this.positions]) {
        try { await this.managePosition(pos, solUsd); } catch (e) { this.err(`position ${pos.symbol}`, e); }
      }
      const walletSol = await this.exec.solBalance().catch(() => null);
      if (walletSol != null) { const oc = this.positions.reduce((a, p) => a + p.entrySol * p.remainingFrac, 0); this.risk.checkKill(walletSol, oc); this.risk.checkBalanceHalt(walletSol, oc); }
      this.stats.positionTicks++;
    } finally { this.busy.pos = false; this.saveStats(); }
  }

  async bundleCheck(pos, valueSol, n) {
    const bw = pos.bw; if (!bw || n - (bw.lastTs || 0) < this.cfg.bundleCheckSec * 1000) return null;
    bw.lastTs = n;
    const amts = await this.exec.largestAccounts(pos.mint);
    if (!bw.tracked) bw.tracked = Object.entries(amts).sort((a, b) => b[1] - a[1]).slice(1, 21).map(e => e[0]);
    if (bw.creator) { const cb = await this.exec.ownerBalance(bw.creator, pos.mint).catch(() => null); if (cb != null) { amts[CREATOR_KEY] = cb; if (!bw.tracked.includes(CREATOR_KEY)) bw.tracked.push(CREATOR_KEY); } }
    bw.snaps.push({ ts: n, amts }); if (bw.snaps.length > 24) bw.snaps.shift();
    const basis = pos.entrySol * pos.remainingFrac;
    bw.vals.push({ ts: n, r: basis > 0 ? valueSol / basis : 0 }); if (bw.vals.length > 24) bw.vals.shift();
    const win = bw.vals.filter(x => x.ts >= n - this.cfg.bundleWindowSec * 1000);
    const hi = Math.max(...win.map(x => x.r)), now = bw.vals[bw.vals.length - 1].r;
    const priceDropPct = hi > 0 ? Math.max(0, (1 - now / hi) * 100) : 0;
    const r = bundleRisk({ snapshots: bw.snaps, tracked: bw.tracked, weights: bw.weights, supply: bw.supply, priceDropPct, windowSec: this.cfg.bundleWindowSec, dumpFrac: this.cfg.bundleDumpFrac, now: n });
    pos.bundleScore = r.score;
    return bundleDecision(r, this.cfg, bw.trimmed);
  }

  async managePosition(pos, solUsd) {
    const n = this.now();
    const v = this.latest.get(pos.mint) || {};
    let valueSol = null;
    try { valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw); pos.markFails = 0; pos.lastValueSol = valueSol; }
    catch { pos.markFails = (pos.markFails || 0) + 1; }

    // Books-vs-chain reconciliation (fix zero): if one of OUR sells reported failure
    // after its swap was sent (suspectUnbookedSell), the tokens may be gone while the
    // books still count them — every later ratio, stop and report would be computed
    // on tokens we no longer hold (DOGCART 2026-10-13: an unbooked TP1 left the
    // remainder reading -56% and the hard floor dumped it at a real +33%). Resync to
    // chain truth before judging exits. Only runs on the suspect flag, so genuine
    // manual exits still flow to the manual-exit detector below, untouched.
    if (this.cfg.realMode && !pos.simulated && pos.suspectUnbookedSell && valueSol != null) {
      const chain = await this.exec.tokenBalance(pos.mint).catch(() => null);
      if (chain != null) {
        if (!pos.entryTokensRaw) pos.entryTokensRaw = String(Math.max(1, Math.round(Number(pos.tokensRaw) / Math.max(1e-9, pos.remainingFrac))));
        const books = BigInt(pos.tokensRaw);
        if (chain < books && books > 0n && (books - chain) * 50n >= books) {
          const missing = books - chain;
          const estSol = valueSol * (Number(missing) / Number(books)); // mark-priced estimate of the unbooked proceeds
          pos.realizedSol += estSol;
          this.journal.trade({ type: 'sell', id: pos.id, mint: pos.mint, symbol: pos.symbol, fraction: +(Number(missing) / Number(pos.entryTokensRaw)).toFixed(4), solOut: +estSol.toFixed(6), reason: 'reconciled unbooked sell (chain resync)', sig: null, simulated: false, ts: n });
          console.log(`[reconcile] ${pos.symbol}: books ${books} vs chain ${chain} — booked the missing sell (~${estSol.toFixed(4)} SOL)`);
          pos.tokensRaw = chain.toString();
          pos.remainingFrac = Number(chain) / Number(pos.entryTokensRaw);
          if (!pos.tp1Done && Number(missing) / Number(pos.entryTokensRaw) >= (this.cfg.tp1Frac || 0.4) * 0.75) pos.tp1Done = true;
          pos.suspectUnbookedSell = false;
          if (chain <= 0n) {
            const pnl = pos.realizedSol - pos.entrySol - (pos.feesSol || 0);
            this.positions = this.positions.filter(p => p.id !== pos.id);
            this._recordClose(pnl, pos.mint, pos.entrySol);
            this.ensureClose(pos, { id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, exitSol: pos.realizedSol, pnlSol: +pnl.toFixed(6), heldMin: +((n - pos.entryTs) / 60000).toFixed(1), reason: 'reconciled unbooked sell (chain resync)', simulated: pos.simulated, ts: n });
            this.savePositions();
            return;
          }
          try { valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw); pos.lastValueSol = valueSol; } catch { /* keep the pre-resync mark */ }
        } else if (chain >= books) {
          pos.suspectUnbookedSell = false; // the suspect sell truly never landed; books are right
        }
      }
    }

    let decision;
    if (valueSol == null) {
      // TAKEOVER: a position the user is driving himself is never force-exited —
      // not even by the no-quote fallback below; the pass is a hold like any other.
      if (pos.takenOver) decision = { fraction: 0, reason: null, newPeak: pos.peakRatio, takenOver: true };
      // no sell quote at all: after repeated failures, try to exit anyway — a coin we can't price is a coin we can't leave
      else if (pos.markFails >= 4) decision = { fraction: 1, reason: `no sell quote for ${pos.markFails} ticks`, newPeak: pos.peakRatio };
      else return;
    } else {
      const markNow = { valueSol, liqUsd: v.liq != null ? v.liq : null, buysM5: v.buysM5 != null ? v.buysM5 : null, sellsM5: v.sellsM5 || 0, solUsd, volH1: v.volH1 || 0 };
      // flow history for the adaptive TP1's strength test: this position's own marks, every check
      pos.flowHist = pos.flowHist || [];
      pos.flowHist.push({ ts: n, buys: markNow.buysM5, sells: markNow.sellsM5, tx: (markNow.buysM5 != null || markNow.sellsM5 != null) ? (markNow.buysM5 || 0) + (markNow.sellsM5 || 0) : null });
      if (pos.flowHist.length > 45) pos.flowHist.splice(0, pos.flowHist.length - 45);
      decision = evaluateExit(pos, markNow, this.cfg, n);
    }
    pos.peakRatio = decision.newPeak || pos.peakRatio;
    if (decision.newPeakMove != null) pos.peakMove = decision.newPeakMove;
    if ('stallSince' in decision) pos.stallSince = decision.stallSince;
    if ('stopArmedTs' in decision) pos.stopArmedTs = decision.stopArmedTs;
    if ('floorChecks' in decision) pos.floorChecks = decision.floorChecks;
    if ('floorSince' in decision) pos.floorSince = decision.floorSince;
    if ('probationSince' in decision) pos.probationSince = decision.probationSince;
    if ('moveHist' in decision) pos.moveHist = decision.moveHist;
    if ('exitPending' in decision) pos.exitPending = decision.exitPending;
    if ('killZone' in decision) pos.killZone = decision.killZone;
    if ('postTp1PeakMove' in decision) pos.postTp1PeakMove = decision.postTp1PeakMove;
    if ('deadflowArmed' in decision) pos.deadflowArmed = decision.deadflowArmed;
    // fail-safe confirmation outcomes (user 2026-10-14): count the windows that held to a
    // sell vs the triggers that recovered and were cancelled — the layer's report card.
    if (decision.exitConfirmEvents && decision.exitConfirmEvents.length) {
      this.stats.exitConfirm = this.stats.exitConfirm || { confirmed: 0, cancelled: 0 };
      for (const ev of decision.exitConfirmEvents) {
        if (ev.type === 'confirmed') { this.stats.exitConfirm.confirmed++; console.log(`[exit-confirm] ${pos.symbol}: ${ev.kind} breakdown held through the ${this.cfg.exitConfirmSec}s window — selling`); }
        else if (ev.type === 'cancelled') { this.stats.exitConfirm.cancelled++; console.log(`[exit-confirm] ${pos.symbol}: ${ev.kind} trigger recovered inside the window — pending sell cancelled`); }
      }
    }
    // Two-path redesign (user 2026-10-15): kill-zone lifecycle counts — arming,
    // lapse fires, recovery cancels and instant re-entry kills, across modest
    // remainders and overlay ladder remainders alike (the class rides the
    // journal records, so the two stay separable in the sample).
    if (decision.killzoneEvents && decision.killzoneEvents.length) {
      this.stats.killzone = this.stats.killzone || { armed: 0, fired: 0, cancelled: 0, reentryKills: 0 };
      for (const ev of decision.killzoneEvents) {
        if (ev.type === 'armed') { this.stats.killzone.armed++; console.log(`[killzone] ${pos.symbol}: zone armed (post-TP1 peak reached ${this.cfg.killZoneArmMult}x)`); }
        else if (ev.type === 'fired') this.stats.killzone.fired++;
        else if (ev.type === 'cancelled') this.stats.killzone.cancelled++;
        else if (ev.type === 'reentry') this.stats.killzone.reentryKills++;
      }
    }
    // Dead-flow exit at altitude (user 2026-10-15): count armings (a pre-TP1
    // position's peak move reached the arm line — counted once per position,
    // exits.js emits the event only on the transition) and fires.
    if (decision.deadflowEvents && decision.deadflowEvents.length) {
      this.stats.deadflow = this.stats.deadflow || { armed: 0, fired: 0 };
      for (const ev of decision.deadflowEvents) {
        if (ev.type === 'armed') { this.stats.deadflow.armed++; console.log(`[deadflow] ${pos.symbol}: armed (peak move reached +${Math.round(this.cfg.deadflowArmPct * 100)}% pre-TP1)`); }
        else if (ev.type === 'fired') this.stats.deadflow.fired++;
      }
    }
    // PROTECT switch (user 2026-10-15): count the checks where protection suppressed
    // a stop-loss/ratchet exit on this position (first suppressed kind per check,
    // as reported by exits.js on the decision).
    if (decision.protectedBlock) {
      this.stats.protect = this.stats.protect || { set: 0, blocked: 0 };
      this.stats.protect.blocked++;
      console.log(`[protect] ${pos.symbol}: ${decision.protectedBlock} suppressed by protection`);
    }
    // TAKEOVER switch (user 2026-10-15): count the position checks whose exit
    // judging was suppressed by a takeover — one per check while the flag is set.
    // This counts suppressed JUDGING PASSES, not individual would-be exits: the
    // judges never ran, so which exits would have fired is unknowable without
    // running them — and running them is exactly what takeover forbids.
    if (decision.takenOver) {
      this.stats.takeover = this.stats.takeover || { set: 0, released: 0, sellsSuppressed: 0 };
      this.stats.takeover.sellsSuppressed++;
    }
    if ('tp1Arm' in decision) pos.tp1Arm = decision.tp1Arm;
    // shadow ratchet judge (record-only): judged on the same check, off the same
    // realizable move evaluateExit just used — it only ever writes journal records.
    if (valueSol != null) {
      const basis = pos.entrySol * pos.remainingFrac;
      const base = pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1;
      if (basis > 0) this.judgeRatchetShadow(pos, (valueSol / basis) / base, n);
    }
    // +20% progress callout: let the timeline know it's climbing (once per position)
    if (valueSol != null && !pos.climbCalloutDone) {
      const ratio = valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac);
      if (ratio >= 1.2) {
        pos.climbCalloutDone = true; this.savePositions();
        // GATED with the entry callout (CALLOUTS_ENABLED): the moment is still
        // consumed either way; only the live post is skipped while disabled.
        if (this.cfg.calloutsEnabled) {
          postCallout({ address: pos.mint, symbol: pos.symbol, mc: v.mc }, { setup: pos.setup, metrics: {}, progress: true, gainPct: Math.round((ratio - 1) * 100) }, { enabled: true })
            .then(() => console.log('[callout] climbing update posted for', pos.symbol))
            .catch(e => console.log('[callout] climbing update failed:', e.message));
        }
      }
    }
    // learning log: trajectory sample every ~10s, and detection of a sell the human made in their own wallet
    if (valueSol != null && n - (pos.lastTickTs || 0) >= 10000) {
      pos.lastTickTs = n;
      this.journal.tick({ id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, heldMin: +((n - pos.entryTs) / 60000).toFixed(2), valueSol: +valueSol.toFixed(6), ratio: +(valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac)).toFixed(3), peak: +(pos.peakRatio || 1).toFixed(3), mc: v.mc ?? null, liq: v.liq ?? null, buysM5: v.buysM5 ?? null, sellsM5: v.sellsM5 ?? null, bundle: pos.bundleScore || 0 });
      // D1 (record-only): the position's own recent path rides on the position
      // itself (≤24 samples ≈ last 4 min) so a manual exit can attach its
      // last-120s price path without re-reading the tick journal.
      pos.ticks = pos.ticks || [];
      pos.ticks.push({ ts: n, price: v.price ?? null, ratio: +(valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac)).toFixed(4) });
      if (pos.ticks.length > 24) pos.ticks.splice(0, pos.ticks.length - 24);
      // manual exit detection: on-chain balance far below what the bot holds, 2 checks in a row
      if (this.cfg.realMode && n - pos.entryTs > 60000 && n - (pos.lastChainTs || 0) >= 15000) {
        pos.lastChainTs = n;
        const walletAddr = await this.exec.address().catch(() => null);
        const onchain = walletAddr ? await this.exec.ownerBalance(walletAddr, pos.mint).catch(() => null) : null;
        if (onchain != null && externalExit(pos.tokensRaw, onchain)) {
          pos.chainDropStrikes = (pos.chainDropStrikes || 0) + 1;
          if (pos.chainDropStrikes >= 2) {
            console.log(`[learn] manual exit detected for ${pos.symbol} — recording`);
            await this.recordManualExit(pos, valueSol, n, 'sold in own wallet');
            return;
          }
        } else {
          pos.chainDropStrikes = 0;
        }
      }
    }
    // bundle exit risk: watch the big wallets while we hold; fail-open (any error = no signal).
    // TAKEOVER: the bundle watcher is an exit judge too — it never runs on a taken-over position.
    if (valueSol != null && this.cfg.bundleWatch && !pos.takenOver && !(decision.fraction >= 1)) {
      const bd = await this.bundleCheck(pos, valueSol, n).catch(() => null);
      if (bd && bd.fraction > (decision.fraction || 0)) decision = { ...bd, newPeak: pos.peakRatio };
    }
    // Full-exit corroboration (remainder protection): one bad quote print must never
    // be able to dump a whole position. Before a full exit fires, re-quote NOW — a
    // real crash still reads crashed half a second later, while a glitch (DOGCART:
    // Jupiter quoted through the coin's dead bonding-curve pair, printing -56%
    // while the live pool sat at +33%) flips back. Disagreement beyond
    // STOP_XCHECK_PCT vetoes the exit for this tick only; the next tick re-judges,
    // so a real crash is delayed by seconds, not denied.
    if (decision.fraction >= 1 && this.cfg.stopXcheck && valueSol != null) {
      const basis = Math.max(1e-9, pos.entrySol * pos.remainingFrac);
      const ratioNow = valueSol / basis;
      const reValue = await this.exec.markValue(pos.mint, pos.tokensRaw).catch(() => null);
      if (reValue != null) {
        const reRatio = reValue / basis;
        if (reRatio > ratioNow * (1 + this.cfg.stopXcheckPct) || reRatio < ratioNow * (1 - this.cfg.stopXcheckPct)) {
          console.log(`[xcheck] ${pos.symbol}: vetoed full exit '${decision.reason}' — mark ${ratioNow.toFixed(3)} vs instant re-quote ${reRatio.toFixed(3)} disagree`);
          pos.xcheckVetoes = (pos.xcheckVetoes || 0) + 1;
          this.savePositions();
          return;
        }
      }
    }
    if (!(decision.fraction > 0)) { this.savePositions(); return; }

    const sellRaw = decision.fraction >= 1 ? BigInt(pos.tokensRaw) : (BigInt(pos.tokensRaw) * BigInt(Math.round(decision.fraction * 1000))) / 1000n;
    let res;
    try { res = await this.exec.sell(pos.mint, sellRaw.toString()); }
    catch (e) { pos.suspectUnbookedSell = true; this.savePositions(); throw e; } // the swap may have landed anyway — reconcile next tick
    const sold = BigInt(res.tokensSold || '0');
    if (sold <= 0n) { pos.suspectUnbookedSell = true; pos.markFails = (pos.markFails || 0) + 1; this.savePositions(); return; }
    pos.suspectUnbookedSell = false;
    pos.tokensRaw = (BigInt(pos.tokensRaw) - sold).toString();
    pos.realizedSol += res.solOut;
    pos.feesSol = (pos.feesSol || 0) + (this.cfg.txFeeSol || 0);
    this.stats.exits++;
    if (decision.tp1) {
      pos.tp1Done = true; pos.remainingFrac *= (1 - decision.fraction);
      // Two-path classification (user 2026-10-15): exits.js stamped the class from
      // the TP1 fire's realized gain — persist it on the position (the journal
      // records below pick it up via pos.pathClass) and count modest classifications.
      if (decision.pathClass) {
        pos.pathClass = decision.pathClass;
        pos.killZoneOverlay = !!decision.killZoneOverlay;
        if (decision.pathClass === 'modest') {
          this.stats.modestPath = this.stats.modestPath || { classified: 0, targetHits: 0, splits: 0 };
          this.stats.modestPath.classified++;
        }
        console.log(`[paths] ${pos.symbol}: TP1 classified ${decision.pathClass}${pos.killZoneOverlay ? ' + kill-zone overlay' : ''}`);
      }
    }
    if (decision.modestSplit) {
      // The modest target banked modestSplitBankFrac of the remainder; the
      // surviving slice converts to the ladder path from this moment — TP2, the
      // trails and the moonbag judge it as a ladder remainder from here on.
      pos.pathClass = 'ladder';
      pos.splitDone = true;
      pos.remainingFrac *= (1 - decision.fraction);
      this.stats.modestPath = this.stats.modestPath || { classified: 0, targetHits: 0, splits: 0 };
      this.stats.modestPath.targetHits++;
      this.stats.modestPath.splits++;
      console.log(`[paths] ${pos.symbol}: modest target hit — remainder split banked, slice converted to ladder`);
    }
    if (decision.tp2) { pos.tp2Done = true; pos.remainingFrac *= (1 - decision.fraction); }
    this.journal.trade({ type: 'sell', id: pos.id, mint: pos.mint, symbol: pos.symbol, fraction: decision.fraction, solOut: res.solOut, reason: decision.reason, sig: res.sig, simulated: res.simulated, ts: n, path: pos.pathClass || undefined });
    // Callout Shadow Lab (record-only): a banked TP is a would-call moment —
    // journaled off the EXECUTED sell above, never off a decision alone.
    if (decision.tp1) this.calloutLab.record({ trigger: 'tp1', ts: n, mint: pos.mint, symbol: pos.symbol, v, mc: v.mc ?? null, setup: pos.setup, source: 'position', holding: true, linkId: pos.id }).catch(() => {});
    if (decision.tp2) this.calloutLab.record({ trigger: 'tp2', ts: n, mint: pos.mint, symbol: pos.symbol, v, mc: v.mc ?? null, setup: pos.setup, source: 'position', holding: true, linkId: pos.id }).catch(() => {});

    if (decision.fraction >= 1 || BigInt(pos.tokensRaw) <= 0n) {
      const pnl = pos.realizedSol - pos.entrySol - (pos.feesSol || 0); // net of SOL network fees
      if (this.cfg.closeEmptyAccounts && this.exec.closeEmptyAccounts) this.exec.closeEmptyAccounts(pos.mint).catch(e => this.err('close account', e));
      this.positions = this.positions.filter(p => p.id !== pos.id);
      this._recordClose(pnl, pos.mint, pos.entrySol);
      // D1: the final sell's real fill (SOL per whole token, from the executed
      // quote's solOut ÷ tokens actually sold) rides on the close record.
      const soldWhole = pos.decimals != null && sold > 0n ? Number(sold) / 10 ** pos.decimals : null;
      const exitFillSol = soldWhole > 0 ? res.solOut / soldWhole : null;
      this.ensureClose(pos, { id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, exitSol: pos.realizedSol, pnlSol: +pnl.toFixed(6), heldMin: +((n - pos.entryTs) / 60000).toFixed(1), reason: decision.reason, simulated: pos.simulated, ts: n, exitFillSol, exitFillUsd: exitFillSol != null && solUsd > 0 ? +(exitFillSol * solUsd).toFixed(10) : null });
    }
    this.savePositions();
  }

  // D1 (record-only): the exit snapshot attached to every live-detected manual
  // sell, on the SAME manual_exits record the /exittag reason lands on. Built
  // from data the bot already holds: the position's own tick ring (last 120s
  // price path), its peak, the streamed-flow windows for held mints, and a
  // fresh RugCheck holder count vs the entry snapshot's. Anything with no
  // source at record time is null — largeHolderSells is always null today:
  // no holder-delta feed exists at exit time (named in the D1 report).
  async _manualSnapshot(pos, valueSol, n, pnlSol) {
    try {
      const basis = Math.max(1e-9, pos.entrySol * pos.remainingFrac);
      const ratioNow = valueSol != null ? valueSol / basis : null;
      const path = (pos.ticks || []).filter(t => n - t.ts <= 120000).map(t => ({ ts: t.ts, price: t.price ?? null, ratio: t.ratio ?? null }));
      const win = (a, b) => { const r = this.shadowFlow.windowRange(pos.mint, a, b); return r ? { buys: r.buys, sells: r.sells, buySol: +r.buySol.toFixed(4), sellSol: +r.sellSol.toFixed(4) } : null; };
      const f30 = win(n - 30000, n), f60 = win(n - 60000, n), fPrior = win(n - 120000, n - 60000);
      let holdersNow = null;
      try { const rug = await this.d.fetchRug(pos.mint); holdersNow = rug && rug.totalHolders != null ? rug.totalHolders : null; } catch { /* holder count is best-effort */ }
      await this._dasHolderSample(pos.mint); // record-only: the snapshot read also leaves a DAS holder sample in the series
      const holdersEntry = pos.entry && pos.entry.holders != null ? pos.entry.holders : null;
      return {
        path, pathSec: 120,
        ratioNow: ratioNow != null ? +ratioNow.toFixed(4) : null,
        peakRatio: pos.peakRatio ?? null,
        distFromPeakPct: ratioNow != null && pos.peakRatio > 0 ? +(((ratioNow / pos.peakRatio) - 1) * 100).toFixed(2) : null,
        flow: { last30s: f30, last60s: f60, prior60s: fPrior, source: (f30 || f60 || fPrior) ? 'stream' : null },
        holdersEntry, holdersNow, holdersChange: holdersEntry != null && holdersNow != null ? holdersNow - holdersEntry : null,
        largeHolderSells: null,
        heldMin: +((n - pos.entryTs) / 60000).toFixed(1),
        pnlSol: pnlSol != null ? +pnlSol.toFixed(6) : null,
        pnlPct: pnlSol != null && pos.entrySol > 0 ? +(pnlSol / pos.entrySol * 100).toFixed(2) : null,
      };
    } catch { return null; }
  }

  // D1 (record-only): the virtual-position state the paired shadow-exit
  // tracker runs the real exit stack against after a manual close — a copy of
  // exactly the fields evaluateExit reads, frozen at the manual exit.
  _pairedState(pos, n, manual) {
    return {
      id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup,
      entryTs: pos.entryTs, entrySol: pos.entrySol, entryPrice: pos.entryPrice,
      entryRoundTrip: pos.entryRoundTrip, entryVolH1: pos.entryVolH1 || 0,
      remainingFrac: pos.remainingFrac, peakRatio: pos.peakRatio || 1, peakMove: pos.peakMove || 1,
      tp1Done: !!pos.tp1Done, tp2Done: !!pos.tp2Done, tp1Arm: pos.tp1Arm || null,
      stallSince: pos.stallSince ?? null, stopArmedTs: pos.stopArmedTs ?? null,
      floorChecks: pos.floorChecks || 0, floorSince: pos.floorSince ?? null,
      probationSince: pos.probationSince ?? null, moveHist: pos.moveHist || [], exitPending: {},
      flowHist: (pos.flowHist || []).slice(-45),
      manualTs: n, manualPnlSol: manual.pnlSol, manualMarkSol: manual.valueSol ?? null,
      // D1 follow-up: when the manual side was priced from the real sell tx,
      // the paired record says so (and carries the per-token fill)
      manualFillSource: manual.fillSource || null, manualFillSol: manual.fillSol ?? null,
      basisSol: pos.entrySol * pos.remainingFrac,
    };
  }

  // the human closed this one outside the bot: record entry snapshot + estimated result, drop the position, await a reason tag
  async recordManualExit(pos, valueSol, n, how) {
    if (!this.positions.some(p => p.id === pos.id)) return null; // already closed (e.g. by reconcile) — don't log it twice
    const est = valueSol != null ? valueSol : 0;
    const estPnl = pos.realizedSol + est - pos.entrySol - (pos.feesSol || 0);
    const chain = await this.chainPnl(pos);
    const pnl = chain ? chain.pnl : estPnl;
    // D1 follow-up: the real fill from the detected sell tx, when readable —
    // async gravy on the recorded close; unreadable keeps today's nulls.
    const ff = this._manualFill(pos, await this.chainSellFill(pos));
    const hasFill = ff.exitFillSol != null;
    const snapshot = await this._manualSnapshot(pos, valueSol, n, pnl);
    const rec = this.journal.manualExit({ id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, how, entry: pos.entry || null, heldMin: +((n - pos.entryTs) / 60000).toFixed(1), peakRatio: pos.peakRatio, bundleScore: pos.bundleScore || 0, pnlSolEstimate: +estPnl.toFixed(6), pnlSol: chain ? +pnl.toFixed(6) : null, pnlSource: chain ? 'chain' : 'estimate', reason: null, snapshot, exitFillSol: hasFill ? ff.exitFillSol : null, fillSource: hasFill ? ff.fillSource : null });
    this.positions = this.positions.filter(p => p.id !== pos.id);
    this._recordClose(pnl, pos.mint, pos.entrySol);
    this.ensureClose(pos, { manual: true, id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, pnlSol: +pnl.toFixed(6), estimated: !chain, pnlSource: chain ? 'chain' : 'estimate', heldMin: rec.heldMin, reason: `manual exit (${how})`, simulated: pos.simulated, entry: pos.entry, ts: n, ...(hasFill ? { exitFillSol: ff.exitFillSol, exitFillUsd: ff.exitFillUsd, fillSource: ff.fillSource, sellTxFeeSol: ff.sellTxFeeSol, sellSigs: ff.sellSigs, feesSol: ff.feesSol, feesSource: ff.feesSource } : {}) });
    // D1 paired shadow exit: keep judging this position's remainder virtually
    // (its manual side prices off the REAL fill when one was read)
    try { this.paired.watch(this._pairedState(pos, n, { pnlSol: +pnl.toFixed(6), valueSol: hasFill ? ff.manualValueSol : valueSol, fillSource: hasFill ? ff.fillSource : null, fillSol: hasFill ? ff.exitFillSol : null })); } catch { /* observer only */ }
    this.savePositions();
    return rec;
  }
  async markManualExit(id) {
    const pos = this.positions.find(p => p.id === id); if (!pos) return null;
    const valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw).catch(() => null);
    return this.recordManualExit(pos, valueSol, this.now(), 'marked in dashboard');
  }

  // ------------------------------------------------------------ introspection
  state() {
    return {
      mode: this.cfg.realMode ? 'REAL' : 'SHADOW',
      modeWarning: this.cfg.modeWarning,
      halted: this.halted(),
      risk: this.risk.snapshot(),
      limits: { tradeSol: this.risk.effectiveTradeSol(), maxPositions: this.cfg.maxPositions, dailyLossSol: this.cfg.dailyLossSol, maxTradesPerHour: this.cfg.maxTradesPerHour, tp1Pct: this.cfg.tp1Pct, tp1Frac: this.cfg.tp1Frac },
      watchlist: this.watch.size,
      pairedShadow: this.paired ? { pending: this.paired.pending.size, done: this.paired.done.length } : { pending: 0, done: 0 },
      positions: this.positions.map(p => ({ id: p.id, symbol: p.symbol, mint: p.mint, setup: p.setup, entrySol: p.entrySol, remainingFrac: p.remainingFrac, peakRatio: +(p.peakRatio || 1).toFixed(2), heldMin: +((this.now() - p.entryTs) / 60000).toFixed(1), simulated: p.simulated, noTp: !!p.noTp, protected: p.protected || null, takenOver: p.takenOver || null, path: p.pathClass || null })),
      // stats.shadowTrades is read from the tracker at read time so /state can
      // never show a stale report card between the maintained sync points
      stats: this.shadowTrades ? { ...this.stats, shadowTrades: this.shadowTrades.totalsView() } : this.stats,
    };
  }
}
