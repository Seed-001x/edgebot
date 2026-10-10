// risk.js — hard limits, enforced in code. State persists to DATA_DIR/risk.json so a restart
// cannot reset the daily loss counter or un-trip the kill switch.

import fs from 'node:fs';
import path from 'node:path';

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

export class Risk {
  constructor(cfg, { dir, now = Date.now } = {}) {
    this.cfg = cfg; this.now = now;
    this.file = dir ? path.join(dir, 'risk.json') : null;
    this.s = { day: dayKey(now()), dayPnlSol: 0, tradeTs: [], cooldown: {}, startEquitySol: null, killed: false, killReason: null };
    this.load();
  }

  load() {
    if (!this.file) return;
    try { Object.assign(this.s, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
  }
  save() {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.s)); } catch { /* best effort */ }
  }

  rollDay() {
    const k = dayKey(this.now());
    if (k !== this.s.day) { this.s.day = k; this.s.dayPnlSol = 0; this.save(); }
  }

  /** Call once at boot with current wallet SOL; sets the kill-switch baseline the first time ever. */
  initEquity(sol) {
    if (this.s.startEquitySol == null) { this.s.startEquitySol = sol; this.save(); }
  }

  /** Kill switch: wallet SOL (+ open position cost basis) below fraction of starting equity → permanent halt. */
  checkKill(walletSol, openCostSol = 0) {
    if (this.s.killed || this.s.startEquitySol == null) return;
    const eq = walletSol + openCostSol;
    if (eq < this.s.startEquitySol * this.cfg.killEquityFrac) {
      this.s.killed = true;
      this.s.killReason = `equity ${eq.toFixed(4)} SOL < ${(this.cfg.killEquityFrac * 100).toFixed(0)}% of start ${this.s.startEquitySol.toFixed(4)}`;
      this.save();
    }
  }

  /** Manual reset requires editing/deleting risk.json on purpose. */
  canEnter({ mint, walletSol, openCount, sizeSol, halted = false }) {
    this.rollDay();
    const n = this.now();
    if (halted) return { ok: false, reason: 'HALT file present' };
    if (this.s.killed) return { ok: false, reason: `kill switch: ${this.s.killReason}` };
    if (this.s.dayPnlSol <= -this.cfg.dailyLossSol) return { ok: false, reason: `daily loss cap hit (${this.s.dayPnlSol.toFixed(4)} SOL)` };
    if (openCount >= this.cfg.maxPositions) return { ok: false, reason: `max ${this.cfg.maxPositions} positions open` };
    const cd = this.s.cooldown[mint];
    if (cd && n - cd < this.cfg.mintCooldownMin * 60000) return { ok: false, reason: 'mint cooldown' };
    this.s.tradeTs = this.s.tradeTs.filter(t => n - t < 3600000);
    if (this.s.tradeTs.length >= this.cfg.maxTradesPerHour) return { ok: false, reason: `hourly trade cap (${this.cfg.maxTradesPerHour})` };
    if (walletSol - sizeSol < this.cfg.minReserveSol) return { ok: false, reason: `would leave < ${this.cfg.minReserveSol} SOL reserve` };
    if (!(sizeSol > 0)) return { ok: false, reason: 'size is zero' };
    return { ok: true };
  }

  /** Position size: configured size, capped at maxPoolFraction of pool liquidity. */
  sizeFor(liqUsd, solUsd) {
    const poolCapSol = (liqUsd * this.cfg.maxPoolFraction) / (solUsd || 150);
    return Math.max(0, Math.min(this.cfg.tradeSol, poolCapSol));
  }

  recordEntry(mint) {
    const n = this.now();
    this.s.tradeTs.push(n);
    this.s.cooldown[mint] = n;
    for (const [k, t] of Object.entries(this.s.cooldown)) if (n - t > 6 * 3600000) delete this.s.cooldown[k];
    this.save();
  }

  recordClose(pnlSol) {
    this.rollDay();
    this.s.dayPnlSol += pnlSol;
    this.save();
  }

  snapshot() {
    this.rollDay();
    return { day: this.s.day, dayPnlSol: +this.s.dayPnlSol.toFixed(5), dailyLossSol: this.cfg.dailyLossSol, tradesLastHour: this.s.tradeTs.filter(t => this.now() - t < 3600000).length, startEquitySol: this.s.startEquitySol, killed: this.s.killed, killReason: this.s.killReason };
  }
}
