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
import { detect, detectChurn, detectLiftoff, eligible, fastPop } from './detect.js';
import { runGates, hasHardFail, tempRuleViolation, blockedNameWord, extensionCheck, freshHistoryCheck, shallowDipCheck } from './gate.js';
import { evaluateExit } from './exits.js';
import { bundleRisk, bundleDecision, pickTracked, linkedWeights, CREATOR_KEY } from './bundleWatch.js';
import { Journal } from './journal.js';
import { Risk } from './risk.js';
import { postCallout } from './callout.js';
import { snapshotFeatures, externalExit } from './learn.js';

import { PostExitTracker } from './postExit.js';
import { buildTradeReport } from './reports.js';

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
    this.risk = new Risk(cfg, { dir: cfg.dataDir, now: this.now });
    this.closedIds = new Set(this.journal.trades.filter(t => t.type === 'close').map(t => t.id)); // journaling guarantee (ensureClose)
    for (const t of this.journal.trades) if (t.type === 'close' && t.mint) this.risk.seedClosed(t.mint, t.ts); // re-entry block survives restarts/deploys
    this.postExit = new PostExitTracker(cfg.dataDir, this.now); // 5-min post-exit price tracker (observer only)
    this.watch = new Map();      // mint -> { ts, source }
    this.latest = new Map();     // mint -> latest view
    this.lastSignal = new Map(); // mint -> ts
    this.latestAt = new Map();   // mint -> ts of the latest view fetch
    this.streamBuf = new Map();  // mint -> recent stream trades (fast pop detection)
    this.fastEvalAt = new Map(); // mint -> ts of last fast-pop evaluation
    this.churnPins = new Map(); // mint -> { at, until } basing watch: dumped coins stay watchlist-pinned past the normal TTL (churn detector)
    this.curveSeen = new Set(); // mints whose latest view was the pump.fun bonding-curve pair — graduation handoff watches for the flip to an AMM pair
    this.posFile = path.join(cfg.dataDir, 'positions.json');
    this.positions = this.loadPositions();
    this.busy = { discover: false, poll: false, pos: false };
    this.stats = { discoverTicks: 0, pollTicks: 0, positionTicks: 0, signals: 0, entries: 0, exits: 0, errors: 0, lastError: null, sourceCounts: {}, lastDiscoverTs: 0, lastPollTs: 0, closesSinceReport: 0, lastReportTs: 0, reportIndex: 0, tempRules: null, fastPop: { fires: 0 }, liveFeed: { connected: false, events: 0, added: 0, reconnects: 0, lastEventTs: 0, lastError: null } };
    this.statsFile = path.join(cfg.dataDir, 'stats.json');
    this.entryTimes = []; // timestamps of entries (for pace keeper)
    this.PACE_TARGET = 120; // target trades per hour (2 per min)
    this.mintsFile = path.join(cfg.dataDir, 'entered-mints.json');
    this.enteredMints = this.loadEnteredMints();
    this.loadStats();
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
    this.journal.trade(full);
    try {
      const v = this.latest.get(pos.mint);
      this.postExit.watch({ id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, exitTs: full.ts || this.now(), exitPriceUsd: v && v.price > 0 ? v.price : (pos.entryPrice || null), reason: full.reason || null, manual: !!full.manual, pnlSol: full.pnlSol ?? null });
    } catch { /* observer only — never disturb trading */ }
    try {
      this.stats.closesSinceReport = (this.stats.closesSinceReport || 0) + 1;
      if (this.stats.closesSinceReport >= (this.cfg.reportEveryTrades || 10)) this.makeTradeReport();
    } catch { /* reporting must never disturb trading */ }
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

  // Admin removals go THROUGH the funnel too — a removed position gets its close record
  // (estimated P&L) instead of vanishing silently.
  adminDrop(p, reason) {
    const n = this.now();
    const pnl = p.lastValueSol != null ? (p.realizedSol || 0) + p.lastValueSol - p.entrySol - (p.feesSol || 0) : null;
    this.positions = this.positions.filter(x => x.id !== p.id);
    if (pnl != null) this.risk.recordClose(pnl, p.mint);
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
    if (pnl != null) this.risk.recordClose(pnl, p.mint);
    const heldMin = +((n - p.entryTs) / 60000).toFixed(1);
    this.journal.manualExit({ id: p.id, mint: p.mint, symbol: p.symbol, ts: n, how: 'sold outside bot (reconcile)', entry: p.entry || null, heldMin, peakRatio: p.peakRatio, bundleScore: p.bundleScore || 0, pnlSolEstimate: pnl != null ? +pnl.toFixed(6) : null, pnlSol: source === 'chain' ? +pnl.toFixed(6) : null, pnlSource: source || 'unknown', reason: null });
    this.ensureClose(p, { manual: true, id: p.id, mint: p.mint, symbol: p.symbol, setup: p.setup, entrySol: p.entrySol, pnlSol: pnl != null ? +pnl.toFixed(6) : null, estimated: source !== 'chain', pnlSource: source, heldMin, reason: pnl != null ? `${reason} — P&L ${source === 'chain' ? 'from chain' : 'est. from last quote'}` : `${reason} (P&L unknown — no quote yet)`, simulated: p.simulated, ts: n });
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
    return true;
  }

  /** Mints whose trades the live feed should stream: freshest watch entries + open positions. */
  tradeWatchMints() {
    if (!this.cfg.fastPop) return [];
    const fresh = [...this.watch.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, this.cfg.fastPopMaxSubs).map(([m]) => m);
    const held = this.positions.map(p => p.mint);
    return [...new Set([...held, ...fresh])];
  }

  /**
   * A streamed trade for a watched mint (fast pop detection, user 2026-10-13).
   * Buffers the print and, throttled per mint, judges it with the pure fastPop
   * detector. A fire routes into the exact same onSignal pipeline as a classic
   * pop — name block, gates, risk, round-trip all unchanged. Fail-open throughout:
   * the stream is an accelerator, never a dependency.
   */
  noteTrade(mint, trade) {
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
      try {
        const rl = JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, 'reallists.json'), 'utf8'));
        for (const row of [...(rl.trending || []), ...(rl.movers || []), ...(rl.graduated || []), ...(rl.new || [])]) {
          const mint = row.mint || row.address;
          if (mint && !bl.has(mint) && !this.watch.has(mint)) this.watch.set(mint, { ts: n, source: 'reallists' });
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
    } catch (e) { this.err('discover', e); } finally { this.busy.discover = false; this.saveStats(); }
  }

  // ------------------------------------------------------------ polling + signals
  async pollTick() {
    if (this.busy.poll) return;
    this.busy.poll = true;
    try {
      this.evictBlacklisted(); // marked coins never even get priced, let alone signal
      const mints = [...new Set([...this.watch.keys(), ...this.positions.map(p => p.mint)])];
      if (!mints.length) return;
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
      candidates.sort((a, b) => b.sig.strength - a.sig.strength);
      for (const c of candidates.slice(0, this.cfg.maxSignalsPerTick)) {
        this.lastSignal.set(c.v.address, this.now());
        if (c.sig.setup === 'churn') { this.stats.churn = this.stats.churn || { fires: 0 }; this.stats.churn.fires++; }
        if (c.sig.setup === 'liftoff') { this.stats.liftoff = this.stats.liftoff || { fires: 0 }; this.stats.liftoff.fires++; }
        await this.onSignal(c.v, c.sig).catch(e => this.err('onSignal', e));
      }
    } catch (e) { this.err('poll', e); } finally { this.busy.poll = false; this.saveStats(); }
  }

  skip(v, sig, reasons, warnings = []) {
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'skipped', reasons, price: v.price, mc: v.mc, metrics: sig.metrics, warnings, label: sig.label || null });
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
   * A 'flow' trigger from the FlowWatch poller (tracked smart-wallet buys).
   * Mirrors _evalFastPop: position + per-mint signal-cooldown guards, the shared
   * eligible() tradability floor, then the exact same onSignal pipeline — gates,
   * risk, exits all unchanged. The wallet nominates; it never bypasses.
   */
  async _evalFlow(mint, agg) {
    const n = this.now();
    if (this.positions.some(p => p.mint === mint)) return;
    if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) return;
    const views = await this.d.fetchViews([mint]).catch(() => null);
    const v = views && views.get(mint);
    if (!v) return;
    this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n);
    this.noteMint(mint, 'flow'); // keep sampling it so classic/churn detectors can judge it too
    if (eligible(v, this.cfg, n).length) return; // same tradability floor the classic detectors apply
    this.lastSignal.set(mint, n);
    this.stats.flow = this.stats.flow || { fires: 0 };
    this.stats.flow.fires++;
    console.log(`[flow] ${v.symbol} fired from wallet flow: ${agg.label}`);
    await this.onSignal(v, { setup: 'flow', strength: agg.maxSol || 0, metrics: { wallets: agg.wallets || [], maxSol: agg.maxSol || 0, count: agg.count || 0, kind: agg.kind || null }, label: agg.label || null });
  }

  async onSignal(v, sig) {
    this.stats.signals++;
    const n = this.now();
    // User blacklist (per-token): if they've marked this specific mint as bad, skip it
    const blacklistedMints = this.journal.blacklistedMints();
    if (blacklistedMints.has(v.address)) {
      console.log(`[learn] skip: user blacklisted token ${v.symbol} — skipping`);
      return this.skip(v, sig, [`user-blacklist: token "${v.symbol}" marked bad`]);
    }
    // User blacklist (setup): configurable via SETUP_BLACKLIST_MIN (0 = off, per-token only)
    const blacklisted = this.cfg.setupBlacklistMin > 0 ? this.journal.blacklistedSetups(this.cfg.setupBlacklistMin) : new Set();
    if (blacklisted.has(sig.setup)) {
      console.log(`[learn] skip: user blacklisted setup "${sig.setup}" — skipping ${v.symbol}`);
      return this.skip(v, sig, [`user-blacklist: setup "${sig.setup}" marked bad ${10}+ times`]);
    }
    // User name block (2026-10-13): any coin whose name contains a blocked word (default "inu")
    // is hard-skipped. Sits before runGates, so no pace boost, mandatory-ape forcing or
    // contested-gate override can let one through.
    const blockedWord = blockedNameWord(v.name, this.cfg.nameBlockWords);
    if (blockedWord) {
      console.log(`[nameblock] skip: "${v.name}" contains blocked word "${blockedWord}"`);
      return this.skip(v, sig, [`nameblock: name "${v.name || v.symbol}" contains blocked word "${blockedWord}"`]);
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
      if (!ex.pass) {
        console.log(`[extension] skip: ${v.symbol} — ${ex.reason}`);
        return this.skip(v, sig, [`extension: ${ex.reason}`]);
      }
    }
    // Fresh-history fail-closed (user 2026-10-13, entry-fixes A3): a coin discovered mid-run
    // (trending/movers lists) with too little sampled history for the guards above to judge
    // gets judged on DexScreener's aggregates instead of waved through — BORING arrived with
    // no samples at +41.6% in 5m on a $14.5k cap and the sample guard passed it by default.
    // Fast-stream pops exempt (the stream IS the history).
    if (!(sig.metrics && sig.metrics.fastStream)) {
      const fc = freshHistoryCheck(this.history.get(v.address), v, n, { maxChgM5: this.cfg.freshMaxChgM5, smallMc: this.cfg.freshSmallMc, m5ShareH1: this.cfg.freshM5ShareH1 });
      if (!fc.pass) {
        console.log(`[fresh] skip: ${v.symbol} — ${fc.reason}`);
        return this.skip(v, sig, [`fresh: ${fc.reason}`]);
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
      if (!sd.pass) {
        console.log(`[shallowdip] skip: ${v.symbol} — ${sd.reason}`);
        return this.skip(v, sig, [`shallow dip: ${sd.reason}`]);
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
        return this.skip(v, sig, [`reentry: no dip (price within 20% of recent high)`]);
      }
    }
    const [solUsd, walletSol] = await Promise.all([this.d.fetchSolUsd(), this.exec.solBalance()]);
    const open = this.positions.reduce((a, p) => a + p.entrySol * p.remainingFrac, 0);
    this.risk.checkKill(walletSol, open);
    this.risk.checkBalanceHalt(walletSol, open);

    const size = this.risk.sizeFor(v.liq, solUsd);
    const gate0 = this.risk.canEnter({ mint: v.address, walletSol, openCount: this.positions.length, sizeSol: size, halted: this.halted() });
    if (!gate0.ok) return this.skip(v, sig, [`risk: ${gate0.reason}`]);

    // one-trade temporary rules (user-set via POST /temprules; cleared on the next executed entry)
    if (this.stats.tempRules) {
      const violation = tempRuleViolation(v, sig.metrics, this.stats.tempRules);
      if (violation) return this.skip(v, sig, [violation]);
    }

    // gates: RugCheck + curve history in parallel
    const [rug, curve] = await Promise.all([
      this.d.fetchRug(v.address).catch(() => null),
      this.d.fetchCurve ? this.d.fetchCurve(v.address).catch(() => null) : null,
    ]);
    // Pace keeper: if behind the hourly target, use relaxed gate thresholds
    const { cfg: gateCfg, boosted, pace } = this.paceCfg(n);
    const g = runGates({ view: v, rug, curve, cfg: gateCfg, now: n });
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
          return this.skip(v, sig, g.fails, g.warnings);
        }
      }
    }

    // exit-value check: price a buy AND the immediate sell-back before spending anything
    let rt;
    try { rt = await this.exec.roundTrip(v.address, size); }
    catch (e) { return this.skip(v, sig, [`roundtrip: no sellable route (${e.message})`], g.warnings); }
    if (rt.ratio < this.cfg.minRoundTrip) return this.skip(v, sig, [`roundtrip: sell-back worth ${(rt.ratio * 100).toFixed(0)}% of spend < ${(this.cfg.minRoundTrip * 100).toFixed(0)}% (impact ${rt.impactPct.toFixed(1)}%)`], g.warnings);

    // Price-move vetoes REMOVED 2026-10-12 (user order): both the quote-level freshness
    // guard (±10% vs decision price) and the older DexScreener re-pull check (-30%/+100%)
    // rejected any coin that moved while the gates were running — the user wants the buy
    // to go through at whatever the live price is. Entries are instant from here.

    // re-check limits right before spending (state may have changed during the awaits above)
    const gate1 = this.risk.canEnter({ mint: v.address, walletSol: await this.exec.solBalance(), openCount: this.positions.length, sizeSol: size, halted: this.halted() });
    if (!gate1.ok) return this.skip(v, sig, [`risk: ${gate1.reason}`], g.warnings);

    let fill;
    try { fill = await this.exec.buy(v.address, size, rt.buyQuote); }
    catch (e) { this.err('buy', e); return this.skip(v, sig, [`exec: buy failed (${e.message})`], g.warnings); }

    const pos = {
      id: `${v.address.slice(0, 6)}-${n}`, mint: v.address, symbol: v.symbol, setup: sig.setup,
      entryTs: n, entrySol: fill.solSpent, tokensRaw: fill.tokensRaw, entryTokensRaw: fill.tokensRaw, remainingFrac: 1, peakRatio: 1, tp1Done: false, tp2Done: false, tp1Arm: null, flowHist: [], suspectUnbookedSell: false,
      entryPrice: v.price, entryMc: v.mc, realizedSol: 0, simulated: fill.simulated, sigBuy: fill.sig, markFails: 0,
      entryVolH1: v.volH1 || 0,
      entryRoundTrip: rt.ratio, peakMove: 1, stopArmedTs: null, floorChecks: 0, floorSince: null, probationSince: null, feesSol: this.cfg.txFeeSol || 0, // buy tx fee // entry stall: price is at entry (move 1.0) by definition; the 60s clock runs from entryTs
      bw: { tracked: null, supply: rug && rug.token ? Number(rug.token.supply) || 0 : 0, creator: rug && rug.creator ? String(rug.creator) : null, weights: linkedWeights(rug), snaps: [], vals: [], lastTs: 0, trimmed: false },
      entry: snapshotFeatures({ v, sig, rug, g, now: n }), lastTickTs: 0, lastChainTs: 0, chainDropStrikes: 0,
    };
    this.positions.push(pos); this.savePositions();
    this.enteredMints.add(v.address); this.saveEnteredMints();
    this.risk.recordEntry(v.address);
    this.stats.entries++;
    this.entryTimes.push(n);
    // Fire a pump.fun callout for this entry (non-blocking; rewards accrue to the user).
    // The thesis is generated from the signal that triggered the entry.
    postCallout(v, sig).then(r => {
      console.log('[callout] posted for', v.symbol);
      this.lastCallout = { ok: true, symbol: v.symbol, ts: Date.now() };
    }).catch(e => {
      console.log('[callout] failed:', e.message);
      this.lastCallout = { ok: false, error: e.message, symbol: v.symbol, ts: Date.now() };
    });
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'taken', reasons: [], price: v.price, mc: v.mc, metrics: { ...sig.metrics, roundTrip: +rt.ratio.toFixed(3), sizeSol: size }, warnings: g.warnings, label: sig.label || null });
    this.journal.trade({ type: 'open', id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, sig: fill.sig, simulated: fill.simulated, ts: n });
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
            this.risk.recordClose(pnl, pos.mint);
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
      // no sell quote at all: after repeated failures, try to exit anyway — a coin we can't price is a coin we can't leave
      if (pos.markFails >= 4) decision = { fraction: 1, reason: `no sell quote for ${pos.markFails} ticks`, newPeak: pos.peakRatio };
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
    if ('tp1Arm' in decision) pos.tp1Arm = decision.tp1Arm;
    // +20% progress callout: let the timeline know it's climbing (once per position)
    if (valueSol != null && !pos.climbCalloutDone) {
      const ratio = valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac);
      if (ratio >= 1.2) {
        pos.climbCalloutDone = true; this.savePositions();
        postCallout({ address: pos.mint, symbol: pos.symbol, mc: v.mc }, { setup: pos.setup, metrics: {}, progress: true, gainPct: Math.round((ratio - 1) * 100) })
          .then(() => console.log('[callout] climbing update posted for', pos.symbol))
          .catch(e => console.log('[callout] climbing update failed:', e.message));
      }
    }
    // learning log: trajectory sample every ~10s, and detection of a sell the human made in their own wallet
    if (valueSol != null && n - (pos.lastTickTs || 0) >= 10000) {
      pos.lastTickTs = n;
      this.journal.tick({ id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, heldMin: +((n - pos.entryTs) / 60000).toFixed(2), valueSol: +valueSol.toFixed(6), ratio: +(valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac)).toFixed(3), peak: +(pos.peakRatio || 1).toFixed(3), mc: v.mc ?? null, liq: v.liq ?? null, buysM5: v.buysM5 ?? null, sellsM5: v.sellsM5 ?? null, bundle: pos.bundleScore || 0 });
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
    // bundle exit risk: watch the big wallets while we hold; fail-open (any error = no signal)
    if (valueSol != null && this.cfg.bundleWatch && !(decision.fraction >= 1)) {
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
    if (decision.tp1) { pos.tp1Done = true; pos.remainingFrac *= (1 - decision.fraction); }
    if (decision.tp2) { pos.tp2Done = true; pos.remainingFrac *= (1 - decision.fraction); }
    this.journal.trade({ type: 'sell', id: pos.id, mint: pos.mint, symbol: pos.symbol, fraction: decision.fraction, solOut: res.solOut, reason: decision.reason, sig: res.sig, simulated: res.simulated, ts: n });

    if (decision.fraction >= 1 || BigInt(pos.tokensRaw) <= 0n) {
      const pnl = pos.realizedSol - pos.entrySol - (pos.feesSol || 0); // net of SOL network fees
      if (this.cfg.closeEmptyAccounts && this.exec.closeEmptyAccounts) this.exec.closeEmptyAccounts(pos.mint).catch(e => this.err('close account', e));
      this.positions = this.positions.filter(p => p.id !== pos.id);
      this.risk.recordClose(pnl, pos.mint);
      this.ensureClose(pos, { id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, exitSol: pos.realizedSol, pnlSol: +pnl.toFixed(6), heldMin: +((n - pos.entryTs) / 60000).toFixed(1), reason: decision.reason, simulated: pos.simulated, ts: n });
    }
    this.savePositions();
  }

  // the human closed this one outside the bot: record entry snapshot + estimated result, drop the position, await a reason tag
  async recordManualExit(pos, valueSol, n, how) {
    if (!this.positions.some(p => p.id === pos.id)) return null; // already closed (e.g. by reconcile) — don't log it twice
    const est = valueSol != null ? valueSol : 0;
    const estPnl = pos.realizedSol + est - pos.entrySol - (pos.feesSol || 0);
    const chain = await this.chainPnl(pos);
    const pnl = chain ? chain.pnl : estPnl;
    const rec = this.journal.manualExit({ id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, how, entry: pos.entry || null, heldMin: +((n - pos.entryTs) / 60000).toFixed(1), peakRatio: pos.peakRatio, bundleScore: pos.bundleScore || 0, pnlSolEstimate: +estPnl.toFixed(6), pnlSol: chain ? +pnl.toFixed(6) : null, pnlSource: chain ? 'chain' : 'estimate', reason: null });
    this.positions = this.positions.filter(p => p.id !== pos.id);
    this.risk.recordClose(pnl, pos.mint);
    this.ensureClose(pos, { manual: true, id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, pnlSol: +pnl.toFixed(6), estimated: !chain, pnlSource: chain ? 'chain' : 'estimate', heldMin: rec.heldMin, reason: `manual exit (${how})`, simulated: pos.simulated, entry: pos.entry, ts: n });
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
      limits: { tradeSol: this.cfg.tradeSol, maxPositions: this.cfg.maxPositions, dailyLossSol: this.cfg.dailyLossSol, maxTradesPerHour: this.cfg.maxTradesPerHour, tp1Pct: this.cfg.tp1Pct, tp1Frac: this.cfg.tp1Frac },
      watchlist: this.watch.size,
      positions: this.positions.map(p => ({ id: p.id, symbol: p.symbol, mint: p.mint, setup: p.setup, entrySol: p.entrySol, remainingFrac: p.remainingFrac, peakRatio: +(p.peakRatio || 1).toFixed(2), heldMin: +((this.now() - p.entryTs) / 60000).toFixed(1), simulated: p.simulated, noTp: !!p.noTp })),
      stats: this.stats,
    };
  }
}
