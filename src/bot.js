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
import { runGates } from './gate.js';
import { evaluateExit } from './exits.js';
import { Journal } from './journal.js';
import { Risk } from './risk.js';

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
    this.watch = new Map();      // mint -> { ts, source }
    this.latest = new Map();     // mint -> latest view
    this.lastSignal = new Map(); // mint -> ts
    this.posFile = path.join(cfg.dataDir, 'positions.json');
    this.positions = this.loadPositions();
    this.busy = { discover: false, poll: false, pos: false };
    this.stats = { discoverTicks: 0, pollTicks: 0, positionTicks: 0, signals: 0, entries: 0, exits: 0, errors: 0, lastError: null, sourceCounts: {}, lastDiscoverTs: 0, lastPollTs: 0 };
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
          if (bal === 0n) { this.positions = this.positions.filter(x => x.id !== p.id); this.journal.trade({ type: 'close', id: p.id, mint: p.mint, symbol: p.symbol, reason: 'reconcile: tokens no longer in wallet', pnlSol: 0, ts: this.now() }); }
          else if (bal != null) p.tokensRaw = bal.toString();
        } catch (e) { this.err('reconcile', e); }
      }
      this.savePositions();
    }
    return { solBalance: sol, openPositions: this.positions.length };
  }

  // ------------------------------------------------------------ discovery
  async discoverTick() {
    if (this.busy.discover) return;
    this.busy.discover = true;
    try {
      const found = await this.d.discover(this.cfg);
      const n = this.now();
      for (const [mint, source] of found) this.watch.set(mint, { ts: n, source });
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
    } catch (e) { this.err('discover', e); } finally { this.busy.discover = false; }
  }

  // ------------------------------------------------------------ polling + signals
  async pollTick() {
    if (this.busy.poll) return;
    this.busy.poll = true;
    try {
      const mints = [...new Set([...this.watch.keys(), ...this.positions.map(p => p.mint)])];
      if (!mints.length) return;
      const views = await this.d.fetchViews(mints);
      const n = this.now();
      const candidates = [];
      for (const [mint, v] of views) {
        this.latest.set(mint, v);
        this.history.record(v, n);
        this.journal.observe(v);
        if (this.positions.some(p => p.mint === mint)) continue;
        const sig = detect(v, this.history.get(mint), this.cfg, n);
        if (!sig) continue;
        const last = this.lastSignal.get(mint) || 0;
        if (n - last < this.cfg.signalCooldownMin * 60000) continue;
        candidates.push({ v, sig });
      }
      this.stats.pollTicks++; this.stats.lastPollTs = n;
      candidates.sort((a, b) => b.sig.strength - a.sig.strength);
      for (const c of candidates.slice(0, this.cfg.maxSignalsPerTick)) {
        this.lastSignal.set(c.v.address, this.now());
        await this.onSignal(c.v, c.sig).catch(e => this.err('onSignal', e));
      }
    } catch (e) { this.err('poll', e); } finally { this.busy.poll = false; }
  }

  skip(v, sig, reasons, warnings = []) {
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'skipped', reasons, price: v.price, mc: v.mc, metrics: sig.metrics, warnings });
  }

  async onSignal(v, sig) {
    this.stats.signals++;
    const n = this.now();
    const [solUsd, walletSol] = await Promise.all([this.d.fetchSolUsd(), this.exec.solBalance()]);
    const open = this.positions.reduce((a, p) => a + p.entrySol * p.remainingFrac, 0);
    this.risk.checkKill(walletSol, open);

    const size = this.risk.sizeFor(v.liq, solUsd);
    const gate0 = this.risk.canEnter({ mint: v.address, walletSol, openCount: this.positions.length, sizeSol: size, halted: this.halted() });
    if (!gate0.ok) return this.skip(v, sig, [`risk: ${gate0.reason}`]);

    // gates: RugCheck + same-name search in parallel
    const [rug, byName, bySym] = await Promise.all([
      this.d.fetchRug(v.address).catch(() => null),
      this.d.searchByName(v.name).catch(() => []),
      this.d.searchByName(v.symbol).catch(() => []),
    ]);
    const others = [...byName, ...bySym];
    const g = runGates({ view: v, rug, others, cfg: this.cfg, now: n });
    if (!g.pass) return this.skip(v, sig, g.fails, g.warnings);

    // exit-value check: price a buy AND the immediate sell-back before spending anything
    let rt;
    try { rt = await this.exec.roundTrip(v.address, size); }
    catch (e) { return this.skip(v, sig, [`roundtrip: no sellable route (${e.message})`], g.warnings); }
    if (rt.ratio < this.cfg.minRoundTrip) return this.skip(v, sig, [`roundtrip: sell-back worth ${(rt.ratio * 100).toFixed(0)}% of spend < ${(this.cfg.minRoundTrip * 100).toFixed(0)}% (impact ${rt.impactPct.toFixed(1)}%)`], g.warnings);

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
    };
    this.positions.push(pos); this.savePositions();
    this.risk.recordEntry(v.address);
    this.stats.entries++;
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'taken', reasons: [], price: v.price, mc: v.mc, metrics: { ...sig.metrics, roundTrip: +rt.ratio.toFixed(3), sizeSol: size }, warnings: g.warnings });
    this.journal.trade({ type: 'open', id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, sig: fill.sig, simulated: fill.simulated, ts: n });
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
      if (walletSol != null) this.risk.checkKill(walletSol, this.positions.reduce((a, p) => a + p.entrySol * p.remainingFrac, 0));
      this.stats.positionTicks++;
    } finally { this.busy.pos = false; }
  }

  async managePosition(pos, solUsd) {
    const n = this.now();
    const v = this.latest.get(pos.mint) || {};
    let valueSol = null;
    try { valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw); pos.markFails = 0; }
    catch { pos.markFails = (pos.markFails || 0) + 1; }

    let decision;
    if (valueSol == null) {
      // no sell quote at all: after repeated failures, try to exit anyway — a coin we can't price is a coin we can't leave
      if (pos.markFails >= 4) decision = { fraction: 1, reason: `no sell quote for ${pos.markFails} ticks`, newPeak: pos.peakRatio };
      else return;
    } else {
      decision = evaluateExit(pos, { valueSol, liqUsd: v.liq != null ? v.liq : null, buysM5: v.buysM5 != null ? v.buysM5 : null, sellsM5: v.sellsM5 || 0, solUsd }, this.cfg, n);
    }
    pos.peakRatio = decision.newPeak || pos.peakRatio;
    if (!(decision.fraction > 0)) { this.savePositions(); return; }

    const sellRaw = decision.fraction >= 1 ? BigInt(pos.tokensRaw) : (BigInt(pos.tokensRaw) * BigInt(Math.round(decision.fraction * 1000))) / 1000n;
    const res = await this.exec.sell(pos.mint, sellRaw.toString());
    const sold = BigInt(res.tokensSold || '0');
    if (sold <= 0n) { pos.markFails = (pos.markFails || 0) + 1; return; }
    pos.tokensRaw = (BigInt(pos.tokensRaw) - sold).toString();
    pos.realizedSol += res.solOut;
    this.stats.exits++;
    if (decision.tp1) { pos.tp1Done = true; pos.remainingFrac *= (1 - decision.fraction); }
    this.journal.trade({ type: 'sell', id: pos.id, mint: pos.mint, symbol: pos.symbol, fraction: decision.fraction, solOut: res.solOut, reason: decision.reason, sig: res.sig, simulated: res.simulated, ts: n });

    if (decision.fraction >= 1 || BigInt(pos.tokensRaw) <= 0n) {
      const pnl = pos.realizedSol - pos.entrySol;
      this.positions = this.positions.filter(p => p.id !== pos.id);
      this.risk.recordClose(pnl);
      this.journal.trade({ type: 'close', id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, exitSol: pos.realizedSol, pnlSol: +pnl.toFixed(6), heldMin: +((n - pos.entryTs) / 60000).toFixed(1), reason: decision.reason, simulated: pos.simulated, ts: n });
    }
    this.savePositions();
  }

  // ------------------------------------------------------------ introspection
  state() {
    return {
      mode: this.cfg.realMode ? 'REAL' : 'SHADOW',
      modeWarning: this.cfg.modeWarning,
      halted: this.halted(),
      risk: this.risk.snapshot(),
      limits: { tradeSol: this.cfg.tradeSol, maxPositions: this.cfg.maxPositions, dailyLossSol: this.cfg.dailyLossSol, maxTradesPerHour: this.cfg.maxTradesPerHour },
      watchlist: this.watch.size,
      positions: this.positions.map(p => ({ id: p.id, symbol: p.symbol, mint: p.mint, setup: p.setup, entrySol: p.entrySol, remainingFrac: p.remainingFrac, peakRatio: +(p.peakRatio || 1).toFixed(2), heldMin: +((this.now() - p.entryTs) / 60000).toFixed(1), simulated: p.simulated })),
      stats: this.stats,
    };
  }
}
