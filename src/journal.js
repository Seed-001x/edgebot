// journal.js — the part that tells you whether any of this actually works.
//
// EVERY signal is logged — taken AND skipped — with the price at signal time. Then each signal is
// followed forward and its return is recorded at +5 / +15 / +60 minutes (plus best/worst seen).
// /report aggregates by setup and decision, and for skipped signals by skip reason, so you can see:
//   • does each detector have any edge at all?  (taken vs. nothing)
//   • are the gates SAVING you (skipped coins do badly) or COSTING you (skipped coins do great)?
// Files are append-only JSONL under DATA_DIR. Use a persistent disk or they vanish on redeploy.

import fs from 'node:fs';
import path from 'node:path';
import { mean, median, round } from './util.js';

const CPS = [5, 15, 60];          // minutes
const EXPIRE_MIN = 90;
const KEEP = 5000;

function readTail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export class Journal {
  constructor(dir, { now = Date.now } = {}) {
    this.now = now;
    this.dir = dir;
    this.f = { sig: path.join(dir, 'signals.jsonl'), out: path.join(dir, 'outcomes.jsonl'), trades: path.join(dir, 'trades.jsonl'), fb: path.join(dir, 'feedback.jsonl'), ticks: path.join(dir, 'ticks.jsonl'), manual: path.join(dir, 'manual_exits.jsonl'), reports: path.join(dir, 'trade_reports.jsonl'), rshadow: path.join(dir, 'ratchet_shadow.jsonl') };
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    this.signals = [];        // { id, ts, mint, symbol, setup, decision, reasons, price, mc, out:{} }
    this.byId = new Map();
    this.pending = new Map(); // id -> tracking state
    this.trades = [];
    this.feedback = [];       // human feedback on skipped signals
    this.manual = [];         // positions the HUMAN closed (with entry snapshot + optional reason tag)
    this.tradeReports = [];   // full report after every N closes (see reports.js)
    this.seq = 0;
    this.boot();
  }

  boot() {
    for (const s of readTail(this.f.sig, KEEP)) { s.out = {}; this.signals.push(s); this.byId.set(s.id, s); this.seq = Math.max(this.seq, Number(String(s.id).split('-').pop()) || 0); }
    for (const o of readTail(this.f.out, KEEP * 2)) { const s = this.byId.get(o.id); if (s) s.out = o; }
    this.trades = readTail(this.f.trades, KEEP);
    this.tradeReports = readTail(this.f.reports, 100);
    this.feedback = readTail(this.f.fb, KEEP);
    for (const r of readTail(this.f.manual, KEEP)) {
      if (r.type === 'tag') { const m = this.manual.find(x => x.id === r.id); if (m) m.reason = r.reason; }
      else this.manual.push(r);
    }
    const n = this.now();
    for (const s of this.signals) {
      if (!s.out || s.out.done) continue;
      if (n - s.ts < EXPIRE_MIN * 60000 && s.price > 0) this.pending.set(s.id, { max: s.price, min: s.price, got: {} });
    }
  }

  append(file, obj) { try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch { /* disk full etc. — never crash the bot */ } }

  /** Wipe all human feedback. Returns count cleared. */
  clearFeedback() {
    const n = this.feedback.length;
    this.feedback = [];
    try { require('fs').writeFileSync(this.f.fb, ''); } catch {}
    this._blacklistCache = null;
    return n;
  }

  /** per-position trajectory sample (for replaying exit rules later) */
  tick(t) { this.append(this.f.ticks, t); }
  /** a position the human closed outside the bot */
  manualExit(rec) { this.manual.push(rec); if (this.manual.length > KEEP) this.manual.shift(); this.append(this.f.manual, rec); return rec; }
  /** shadow ratchet flow judge record (would-fire / close completion) — observer only, append-only */
  ratchetShadow(rec) { this.append(this.f.rshadow, rec); return rec; }
  /** attach the reason the human gave (see learn.js EXIT_REASONS) */
  tagExit(id, reason, note) {
    let m = this.manual.find(x => x.id === id);
    if (!m) {
      // also allow tagging regular closed trades (e.g. user closed it but bot recorded the close)
      const t = this.trades.find(x => x.type === 'close' && (x.id === id || x.mint === id));
      if (!t) return null;
      t.userTag = reason; if (note) t.userNote = note;
      this.saveTrades();
      return { id: t.id, symbol: t.symbol, userTag: reason };
    }
    m.reason = reason; if (note) m.note = note;
    this.append(this.f.manual, { type: 'tag', id, reason, note: note || undefined, ts: this.now() }); return m;
  }

  /** Human feedback: user marks a skipped signal as good (shouldn't have been skipped) or bad (correctly skipped). */
  recordFeedback({ mint, symbol, good, signalId = null }) {
    const rec = { ts: this.now(), mint, symbol, good: !!good, signalId };
    this.feedback.push(rec);
    if (this.feedback.length > KEEP) this.feedback.shift();
    this.append(this.f.fb, rec);
    return rec;
  }

  /** Returns Set of setup names the user has marked as bad on TAKEN trades (minBad+ times). 0 disables. */
  blacklistedSetups(minBad = 10) {
    const now = this.now();
    if (this._blacklistCache && now - this._blacklistCache.ts < 60000) {
      return this._blacklistCache.setups;
    }
    // Find feedback on taken trades (good=false)
    // We need to match feedback to trades by mint
    const badBySetup = {};
    for (const fb of this.feedback) {
      if (fb.good) continue; // only bad feedback
      // Find the trade or signal for this mint to get setup
      const trade = this.trades.find(t => t.mint === fb.mint);
      const sig = trade ? null : [...this.signals].reverse().find(s => s.mint === fb.mint && s.decision === 'taken');
      const setup = trade?.setup || sig?.setup;
      if (!setup) continue;
      if (!badBySetup[setup]) badBySetup[setup] = 0;
      badBySetup[setup]++;
    }
    const setups = new Set(
      Object.entries(badBySetup)
        .filter(([_, n]) => n >= minBad)
        .map(([k, _]) => k)
    );
    this._blacklistCache = { ts: now, setups };
    return setups;
  }

  /** Returns Set of specific mints the user has marked as bad. Per-token blocking. */
  blacklistedMints() {
    const mints = new Set();
    for (const fb of this.feedback) {
      if (!fb.good && fb.mint) mints.add(fb.mint);
    }
    return mints;
  }
  contestedGates() {
    const now = this.now();
    // Cache for 60s to avoid recomputing on every signal
    if (this._contestedCache && now - this._contestedCache.ts < 60000) {
      return this._contestedCache.gates;
    }
    const byReason = {};
    for (const fb of this.feedback) {
      let reasons = ['unknown'];
      if (fb.signalId) {
        const s = this.byId.get(fb.signalId);
        if (s && s.reasons) reasons = s.reasons;
      } else {
        const sig = [...this.signals].reverse().find(s => s.mint === fb.mint);
        if (sig && sig.reasons) reasons = sig.reasons;
      }
      const r = String(reasons[0] || 'unknown').split(':')[0];
      if (!byReason[r]) byReason[r] = { good: 0, bad: 0 };
      if (fb.good) byReason[r].good++;
      else byReason[r].bad++;
    }
    const gates = new Set(
      Object.entries(byReason)
        .filter(([_, v]) => (v.good + v.bad) >= 3 && v.good > v.bad)
        .map(([k, _]) => k)
    );
    this._contestedCache = { ts: now, gates };
    return gates;
  }

  signal({ mint, symbol, setup, decision, reasons = [], price, mc, metrics = null, warnings = [], label = null }) {
    const ts = this.now();
    const id = `${ts}-${++this.seq}`;
    const rec = { id, ts, mint, symbol, setup, decision, reasons, price, mc, metrics, warnings, label };
    this.signals.push(rec); this.byId.set(id, rec); rec.out = {};
    if (this.signals.length > KEEP) { const old = this.signals.shift(); this.byId.delete(old.id); }
    this.append(this.f.sig, rec);
    if (price > 0) this.pending.set(id, { max: price, min: price, got: {} });
    return id;
  }

  /** Feed every fresh view in; advances outcome checkpoints for pending signals on that mint. */
  observe(view) {
    if (!view || !(view.price > 0)) return;
    const n = this.now();
    for (const [id, st] of this.pending) {
      const s = this.byId.get(id);
      if (!s) { this.pending.delete(id); continue; }
      if (s.mint !== view.address) continue;
      st.max = Math.max(st.max, view.price); st.min = Math.min(st.min, view.price);
      const ageMin = (n - s.ts) / 60000;
      for (const cp of CPS) {
        if (ageMin >= cp && st.got[cp] == null) st.got[cp] = view.price / s.price - 1;
      }
      if (st.got[60] != null) this.finish(id, s, st, false);
    }
    // expire signals we stopped seeing
    for (const [id, st] of this.pending) {
      const s = this.byId.get(id);
      if (s && (n - s.ts) / 60000 > EXPIRE_MIN) this.finish(id, s, st, true);
    }
  }

  finish(id, s, st, expired) {
    const o = {
      id, mint: s.mint, symbol: s.symbol, setup: s.setup, decision: s.decision,
      r5: round(st.got[5]), r15: round(st.got[15]), r60: round(st.got[60]),
      maxRet: round(st.max / s.price - 1), minRet: round(st.min / s.price - 1), done: true, expired,
    };
    s.out = o; this.pending.delete(id); this.append(this.f.out, o);
  }

  trade(t) { this.trades.push(t); if (this.trades.length > KEEP) this.trades.shift(); this.append(this.f.trades, t); }
  addTradeReport(rec) { this.tradeReports.push(rec); if (this.tradeReports.length > 100) this.tradeReports.shift(); this.append(this.f.reports, rec); return rec; }

  recent(limit = 50) { return this.signals.slice(-limit).reverse(); }

  report() {
    const live = (s) => {  // outcomes may be partial while pending
      const st = this.pending.get(s.id);
      return st ? { r5: st.got[5], r15: st.got[15], r60: st.got[60], maxRet: st.max / s.price - 1 } : s.out || {};
    };
    const agg = (arr) => {
      const o = arr.map(live);
      const col = (k) => o.map(x => x[k]).filter(Number.isFinite);
      const r15 = col('r15');
      return {
        n: arr.length, withR15: r15.length,
        avgR5: round(mean(col('r5'))), avgR15: round(mean(r15)), medR15: round(median(r15)), avgR60: round(mean(col('r60'))),
        winRate15: r15.length ? round(r15.filter(x => x > 0).length / r15.length, 3) : null,
        avgMaxRet: round(mean(col('maxRet'))),
      };
    };
    const groups = {};
    for (const s of this.signals) (groups[`${s.setup}/${s.decision}`] ||= []).push(s);
    const bySetup = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, agg(v)]));

    const skipped = this.signals.filter(s => s.decision === 'skipped');
    const cats = {};
    for (const s of skipped) {
      const r = (s.reasons && s.reasons[0]) || 'unknown';
      (cats[String(r).split(':')[0]] ||= []).push(s);
    }
    const bySkipReason = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, agg(v)]));

    const closed = this.trades.filter(t => t.type === 'close');
    const withPnl = closed.filter(t => t.pnlSol != null);
    const pnl = withPnl.map(t => t.pnlSol);
    const tradeStats = {
      closed: closed.length, closedWithPnl: withPnl.length, wins: withPnl.filter(t => t.pnlSol > 0).length,
      totalPnlSol: round(pnl.reduce((a, b) => a + b, 0), 5), avgPnlSol: withPnl.length ? round(mean(pnl), 5) : 0,
      byExitReason: Object.fromEntries(Object.entries(closed.reduce((m, t) => { const k = String(t.reason || '').split(' (')[0].split(' ')[0] || 'unknown'; (m[k] ||= []).push(t.pnlSol); return m; }, {})).map(([k, v]) => { const known = v.filter(x => x != null); return [k, { n: v.length, nWithPnl: known.length, pnlSol: round(known.reduce((a, b) => a + b, 0), 5) }]; })),
    };
    // Human feedback aggregated by skip reason: shows which gates the user disagrees with
    const fbByReason = {};
    for (const fb of this.feedback) {
      // Find the signal to get its skip reasons
      let reasons = ['unknown'];
      if (fb.signalId) {
        const s = this.byId.get(fb.signalId);
        if (s && s.reasons) reasons = s.reasons;
      } else {
        // Fallback: find most recent signal for this mint
        const sig = [...this.signals].reverse().find(s => s.mint === fb.mint);
        if (sig && sig.reasons) reasons = sig.reasons;
      }
      const r = String(reasons[0] || 'unknown').split(':')[0];
      if (!fbByReason[r]) fbByReason[r] = { good: 0, bad: 0, total: 0 };
      if (fb.good) fbByReason[r].good++;
      else fbByReason[r].bad++;
      fbByReason[r].total++;
    }
    // Flag reasons where user consistently disagrees (good > bad and total >= 3)
    const contested = Object.fromEntries(
      Object.entries(fbByReason)
        .filter(([_, v]) => v.total >= 3 && v.good > v.bad)
        .map(([k, v]) => [k, { ...v, contested: true, recommendation: `User marked ${v.good}/${v.total} as good — consider loosening this gate` }])
    );
    return {
      note: 'avgR* are mean returns of price vs. price at signal time. Skipped-signal returns that are strongly negative mean the gate is saving you; strongly positive means it is costing you.',
      signals: this.signals.length, bySetup, bySkipReason, trades: tradeStats,
      feedback: { byReason: fbByReason, contested, total: this.feedback.length },
    };
  }
}
