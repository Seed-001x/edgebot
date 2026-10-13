// bot.js — orchestrator. All I/O comes in through `deps` so the whole loop is testable offline.
//
//   discoverTick : refresh the watchlist from every source (quota-based)
//   pollTick     : re-poll watchlist + open positions (10s), update history, run detectors, handle signals
//   positionTick : mark open positions by live SELL quote and apply exit rules
//
// Entry order (cheap → expensive, every skip is journaled with its reason):
//   detector → risk limits → gates (RugCheck + clone search) → round-trip quote → buy

import fs from 'node:fs';
import path from 'node:path';
import { History } from './history.js';
import { detect, eligible } from './detect.js';
import { runGates, hasHardFail, tempRuleViolation, blockedNameWord } from './gate.js';
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
   * deps: { discover(cfg), fetchViews(mints), fetchSolUsd(), fetchRug(mint), searchByName(q), exec, now }
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
    this.posFile = path.join(cfg.dataDir, 'positions.json');
    this.positions = this.loadPositions();
    this.busy = { discover: false, poll: false, pos: false };
    this.stats = { discoverTicks: 0, pollTicks: 0, positionTicks: 0, signals: 0, entries: 0, exits: 0, errors: 0, lastError: null, sourceCounts: {}, lastDiscoverTs: 0, lastPollTs: 0, closesSinceReport: 0, lastReportTs: 0, reportIndex: 0, tempRules: null, liveFeed: { connected: false, events: 0, added: 0, reconnects: 0, lastEventTs: 0, lastError: null } };
    this.statsFile = path.join(cfg.dataDir, 'stats.json');
    this.entryTimes = []; // timestamps of entries (for pace keeper)
    this.PACE_TARGET = 120; // target trades per hour (2 per min)
    this.namesFile = path.join(cfg.dataDir, 'entered-names.json');
    this.enteredNames = this.loadEnteredNames();
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
  loadEnteredNames() { try { return new Set(JSON.parse(fs.readFileSync(this.namesFile, 'utf8'))); } catch { return new Set(); } }
  saveEnteredNames() { try { fs.writeFileSync(this.namesFile, JSON.stringify([...this.enteredNames])); } catch { /* best effort */ } }
  loadEnteredMints() { try { return new Set(JSON.parse(fs.readFileSync(this.mintsFile, 'utf8'))); } catch { return new Set(); } }
  saveEnteredMints() { try { fs.writeFileSync(this.mintsFile, JSON.stringify([...this.enteredMints])); } catch { /* best effort */ } }
  normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // Pace keeper: returns a relaxed cfg if we're behind the hourly target.
  // Never overrides user blacklists, RugCheck safety, or risk limits.
  paceCfg(n) {
    const hourAgo = n - 3600000;
    this.entryTimes = this.entryTimes.filter(t => t > hourAgo);
    const pace = this.entryTimes.length;
    // Gates stay loosened permanently per user (2026-10-10) — bot's been entering good ones
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
      // prune: stale entries first; hard cap keeps the freshest, never drops open positions
      const ttl = this.cfg.watchTtlMin * 60000;
      const held = new Set(this.positions.map(p => p.mint));
      for (const [m, w] of this.watch) if (!held.has(m) && n - w.ts > ttl) this.watch.delete(m);
      if (this.watch.size > this.cfg.watchMax) {
        const sorted = [...this.watch.entries()].sort((a, b) => b[1].ts - a[1].ts);
        for (const [m] of sorted.slice(this.cfg.watchMax)) if (!held.has(m)) this.watch.delete(m);
      }
      this.history.prune(n, new Set([...this.watch.keys(), ...held]));
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
      // Pace keeper: get relaxed cfg once per tick if behind target
      const { cfg: tickCfg } = this.paceCfg(n);
      const candidates = [];
      for (const [mint, v] of views) {
        this.latest.set(mint, v);
        this.history.record(v, n);
        this.journal.observe(v);
        if (this.positions.some(p => p.mint === mint)) continue;
        const sig = detect(v, this.history.get(mint), tickCfg, n);
        if (!sig) continue;
        const last = this.lastSignal.get(mint) || 0;
        if (n - last < this.cfg.signalCooldownMin * 60000) continue;
        candidates.push({ v, sig });
      }
      this.stats.pollTicks++; this.stats.lastPollTs = n;
      // post-exit observer: feed the tracker the prices this poll already fetched (no extra calls)
      try { this.postExit.tick(mint => { const v = this.latest.get(mint); return v ? v.price : null; }, n); } catch { /* observer only */ }
      candidates.sort((a, b) => b.sig.strength - a.sig.strength);
      for (const c of candidates.slice(0, this.cfg.maxSignalsPerTick)) {
        this.lastSignal.set(c.v.address, this.now());
        await this.onSignal(c.v, c.sig).catch(e => this.err('onSignal', e));
      }
    } catch (e) { this.err('poll', e); } finally { this.busy.poll = false; this.saveStats(); }
  }

  skip(v, sig, reasons, warnings = []) {
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'skipped', reasons, price: v.price, mc: v.mc, metrics: sig.metrics, warnings });
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
    // Copycat dedup: if we already entered a DIFFERENT coin with this name, skip same-name coins
    // (same mint re-signaled is fine — that's the original, not a copycat)
    const nn = this.normName(v.name) || this.normName(v.symbol);
    if (nn && this.enteredNames.has(nn) && !this.enteredMints.has(v.address)) {
      console.log(`[dedup] skip: already entered a coin named "${v.name || v.symbol}" — skipping copycat`);
      return this.skip(v, sig, [`copycat: already entered "${v.name || v.symbol}"`]);
    }
    // User name block (2026-10-13): any coin whose name contains a blocked word (default "inu")
    // is hard-skipped. Sits before runGates, so no pace boost, mandatory-ape forcing or
    // contested-gate override can let one through.
    const blockedWord = blockedNameWord(v.name, this.cfg.nameBlockWords);
    if (blockedWord) {
      console.log(`[nameblock] skip: "${v.name}" contains blocked word "${blockedWord}"`);
      return this.skip(v, sig, [`nameblock: name "${v.name || v.symbol}" contains blocked word "${blockedWord}"`]);
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

    // gates: RugCheck + same-name search in parallel
    const [rug, byName, bySym, curve] = await Promise.all([
      this.d.fetchRug(v.address).catch(() => null),
      this.d.searchByName(v.name).catch(() => []),
      this.d.searchByName(v.symbol).catch(() => []),
      this.d.fetchCurve ? this.d.fetchCurve(v.address).catch(() => null) : null,
    ]);
    const others = [...byName, ...bySym];
    // Pace keeper: if behind the hourly target, use relaxed gate thresholds
    const { cfg: gateCfg, boosted, pace } = this.paceCfg(n);
    const g = runGates({ view: v, rug, others, curve, cfg: gateCfg, now: n });
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
      entryTs: n, entrySol: fill.solSpent, tokensRaw: fill.tokensRaw, remainingFrac: 1, peakRatio: 1, tp1Done: false,
      entryPrice: v.price, entryMc: v.mc, realizedSol: 0, simulated: fill.simulated, sigBuy: fill.sig, markFails: 0,
      entryVolH1: v.volH1 || 0,
      entryRoundTrip: rt.ratio, peakMove: 1, stopArmedTs: null, floorChecks: 0, feesSol: this.cfg.txFeeSol || 0, // buy tx fee // entry stall: price is at entry (move 1.0) by definition; the 60s clock runs from entryTs
      bw: { tracked: null, supply: rug && rug.token ? Number(rug.token.supply) || 0 : 0, creator: rug && rug.creator ? String(rug.creator) : null, weights: linkedWeights(rug), snaps: [], vals: [], lastTs: 0, trimmed: false },
      entry: snapshotFeatures({ v, sig, rug, g, now: n }), lastTickTs: 0, lastChainTs: 0, chainDropStrikes: 0,
    };
    this.positions.push(pos); this.savePositions();
    const en = this.normName(v.name) || this.normName(v.symbol);
    if (en) { this.enteredNames.add(en); this.saveEnteredNames(); }
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
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'taken', reasons: [], price: v.price, mc: v.mc, metrics: { ...sig.metrics, roundTrip: +rt.ratio.toFixed(3), sizeSol: size }, warnings: g.warnings });
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

    let decision;
    if (valueSol == null) {
      // no sell quote at all: after repeated failures, try to exit anyway — a coin we can't price is a coin we can't leave
      if (pos.markFails >= 4) decision = { fraction: 1, reason: `no sell quote for ${pos.markFails} ticks`, newPeak: pos.peakRatio };
      else return;
    } else {
      decision = evaluateExit(pos, { valueSol, liqUsd: v.liq != null ? v.liq : null, buysM5: v.buysM5 != null ? v.buysM5 : null, sellsM5: v.sellsM5 || 0, solUsd, volH1: v.volH1 || 0 }, this.cfg, n);
    }
    pos.peakRatio = decision.newPeak || pos.peakRatio;
    if (decision.newPeakMove != null) pos.peakMove = decision.newPeakMove;
    if ('stallSince' in decision) pos.stallSince = decision.stallSince;
    if ('stopArmedTs' in decision) pos.stopArmedTs = decision.stopArmedTs;
    if ('floorChecks' in decision) pos.floorChecks = decision.floorChecks;
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
    if (!(decision.fraction > 0)) { this.savePositions(); return; }

    const sellRaw = decision.fraction >= 1 ? BigInt(pos.tokensRaw) : (BigInt(pos.tokensRaw) * BigInt(Math.round(decision.fraction * 1000))) / 1000n;
    const res = await this.exec.sell(pos.mint, sellRaw.toString());
    const sold = BigInt(res.tokensSold || '0');
    if (sold <= 0n) { pos.markFails = (pos.markFails || 0) + 1; return; }
    pos.tokensRaw = (BigInt(pos.tokensRaw) - sold).toString();
    pos.realizedSol += res.solOut;
    pos.feesSol = (pos.feesSol || 0) + (this.cfg.txFeeSol || 0);
    this.stats.exits++;
    if (decision.tp1) { pos.tp1Done = true; pos.remainingFrac *= (1 - decision.fraction); }
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
