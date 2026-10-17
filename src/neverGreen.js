// neverGreen.js — the NEVER-GREEN CUT SHADOW (owner order 2026-10-17,
// RECORD-ONLY — this module can never sell, block, gate, or feed any
// decision).
//
// The question it exists to answer: the live stack only cuts a position
// whose base breaks (structural stop), whose flow dies (stall exit), or
// which the ladder banks. A position that NEVER goes green and bleeds
// slowly answers to none of them until the base low finally gives way —
// SEXCOIN (2026-10-17, bottom door) was underwater from its first tick
// (best realizable print 0.991x), decayed 0.99 -> 0.92 (5m) -> 0.84 (10m)
// -> 0.69 (20m), and the structural stop fired at 0.425x for -59%. The
// tick replay priced the fix: had a cut sold at the first sustained
// -10% print past 5 minutes, it exits at 7.9 min / 0.0823 SOL (-18%).
//
// THE RULE (dials pinned by the owner off that replay — do not retune):
// a would-fire triggers when ALL of these hold on a position check:
//   - the position has NEVER peaked above NG_CUT_PEAK_MAX (1.02) — the
//     running peakRatio at this check is at/below the line. peakRatio
//     never decreases, so crossing it disarms the rule for the position
//     permanently (pos.ngCutDisarmed stamps the crossing);
//   - the position is at least NG_CUT_ARM_SEC (300s) old — the arm is
//     load-bearing: MAKERS dipped to 0.719 at 1.3 min, sat under 0.90
//     into minute 4, and ran to 16x. Any arm under 5 min, or any
//     confirm counted before the arm, fires on MAKERS and forfeits the
//     runner the bottom door exists to catch;
//   - the realizable ratio (this check's sell quote over the position's
//     remaining basis, exactly as the position-tick journal computes it)
//     is <= NG_CUT_RATIO (0.90);
//   - for NG_CUT_CONFIRM_CHECKS (2) CONSECUTIVE checks — a check back
//     above the line resets the count (pos.ngCutChecks, threaded on the
//     position and persisted like bagTrailSince/bagFloorSince).
// Fire ONCE per position (pos.ngCutFired stamp, persisted; the judge
// also rebuilds its fired set from the journal at boot, so a restart
// can never re-fire a position whose stamp was lost).
//
// Pairing rides the Shadow Seller's seam and math: at the position's
// close (Bot.ensureClose -> noteClose) the fire pairs against what the
// same remainder actually realized from fire time to close — pairDelta
// from shadowSeller.js, unmodified, so the two shadows' deltas are
// directly comparable. Positive delta = the cut would have saved SOL.
// GET /nevergreen serves the scorecard; ready at 30 paired. Promotion
// is the owner's call, on that sample.
//
// Kill switch: NEVERGREEN_SHADOW=0 — no records, no stamps touched,
// card off.
import { round } from './util.js';
import { pairDelta } from './shadowSeller.js';

export const NEVERGREEN_READY_N = 30;   // paired samples before the card reads READY

/** Read-only /nevergreen payload over the journaled fire/paired records.
 *  Pure — tested directly. */
export function buildNeverGreenCard(records, now = Date.now()) {
  const all = (records || []).filter(r => r && (r.kind === 'fire' || r.kind === 'paired'));
  const fires = all.filter(r => r.kind === 'fire');
  const pairedRecs = all.filter(r => r.kind === 'paired' && r.deltaSol != null);
  const pairedIds = new Set(pairedRecs.map(r => r.id));
  const totalDeltaSol = pairedRecs.reduce((a, r) => a + r.deltaSol, 0);
  const recent = [...all].sort((a, b) => b.ts - a.ts).slice(0, 8);
  return {
    generatedTs: now,
    fires: fires.length,
    paired: pairedRecs.length,
    pending: fires.filter(r => !pairedIds.has(r.id)).length,
    totalDeltaSol: round(totalDeltaSol, 6),
    wins: pairedRecs.filter(r => r.deltaSol > 0).length,
    ready: pairedRecs.length >= NEVERGREEN_READY_N,
    recent,
  };
}

export class NeverGreenCut {
  /**
   * deps: { cfg, journal, now, log }
   * cfg carries the NEVERGREEN_* / NG_CUT_* knobs (see config.js).
   * journal.neverGreenRecs is the boot tail the fire-once and pairing
   * state rebuild from (the Shadow Seller's journal discipline).
   */
  constructor({ cfg = {}, journal = null, now = () => Date.now(), log = () => {} } = {}) {
    this.cfg = cfg;
    this.journal = journal;
    this.now = now;
    this.log = log;
    this.firedIds = new Set();     // every position ever would-fired on (fire-once survives restarts via the journal tail)
    this.openFires = new Map();    // id -> fire record awaiting its close
    if (this.journal && Array.isArray(this.journal.neverGreenRecs)) {
      const paired = new Set(this.journal.neverGreenRecs.filter(r => r && r.kind === 'paired').map(r => r.id));
      for (const r of this.journal.neverGreenRecs) {
        if (!r || r.kind !== 'fire') continue;
        this.firedIds.add(r.id);
        if (!paired.has(r.id)) this.openFires.set(r.id, r);
      }
    }
  }

  get enabled() { return !!this.cfg.neverGreenShadow; }
  get armSec() { return this.cfg.ngCutArmSec ?? 300; }
  get peakMax() { return this.cfg.ngCutPeakMax ?? 1.02; }
  get cutRatio() { return this.cfg.ngCutRatio ?? 0.90; }
  get confirmChecks() { return this.cfg.ngCutConfirmChecks ?? 2; }

  /**
   * Judge one position check (called from Bot.managePosition beside the
   * other record-only observers, off the same realizable mark the check
   * already pulled). Mutates ONLY the position's ngCut* stamps — the
   * caller persists them with the tick's savePositions, exactly like the
   * bagTrailSince stamps. Returns the fire record when the cut would
   * first sell this position, else null. NEVER trades.
   */
  noteCheck(pos, { ratio = null, peakRatio = null, valueSol = null, now = null } = {}) {
    if (!this.enabled || !pos) return null;
    try {
      const n = now != null ? now : this.now();
      if (pos.ngCutFired || this.firedIds.has(pos.id)) return null;
      if (ratio == null || !(valueSol > 0)) return null;
      // permanent disarm: the position once went green past the line.
      // peakRatio is a running max (never decreases), so this check alone
      // settles it forever; the stamp makes the state explicit/persisted.
      if (peakRatio != null && peakRatio > this.peakMax) { pos.ngCutDisarmed = true; pos.ngCutChecks = 0; return null; }
      if (pos.ngCutDisarmed) { pos.ngCutChecks = 0; return null; }
      // arm gate: confirm checks count only at/after the arm — a deep
      // early dip (MAKERS, 0.719 at 1.3 min) must bank no credit.
      const heldSec = pos.entryTs ? (n - pos.entryTs) / 1000 : null;
      if (heldSec == null || heldSec < this.armSec) { pos.ngCutChecks = 0; return null; }
      if (ratio <= this.cutRatio) pos.ngCutChecks = (pos.ngCutChecks || 0) + 1;
      else pos.ngCutChecks = 0;
      if (pos.ngCutChecks < this.confirmChecks) return null;
      const rec = {
        kind: 'fire', type: 'nevergreen_fire', reason: 'never-green cut (shadow)',
        ts: n, id: pos.id, mint: pos.mint, symbol: pos.symbol || null,
        setup: pos.setup || null, slot: pos.slot ?? null,
        heldMin: heldSec != null ? round(heldSec / 60, 2) : null,
        ratio: round(ratio, 4), valueSol: round(valueSol, 6), peakRatio: round(peakRatio, 4),
        entrySol: pos.entrySol ?? null, remainingFrac: pos.remainingFrac ?? null,
        protected: !!pos.protected, takenOver: !!pos.takenOver,
        realizedSolAtFire: round(pos.realizedSol || 0, 6), feesSolAtFire: round(pos.feesSol || 0, 6),
      };
      pos.ngCutFired = n;
      pos.ngCutChecks = 0;
      this.firedIds.add(pos.id);
      this.openFires.set(pos.id, rec);
      if (this.journal) this.journal.neverGreen(rec);
      this.log(`[nevergreen] ${pos.symbol}: WOULD CUT — never green (peak ${rec.peakRatio}x), ratio ${rec.ratio} at ${rec.heldMin} min, remainder worth ${rec.valueSol} SOL (record only)`);
      return rec;
    } catch { return null; } // observer only — never disturb the position loop
  }

  /** Pair a fire with the position's close (called from Bot.ensureClose —
   *  the funnel every close passes through exactly once). Mirrors the
   *  Shadow Seller's pairing: what the remainder realized from fire time
   *  to this close (net of the fees burned after the fire) vs selling it
   *  at the fire check's quote (net of one tx fee). */
  noteClose(pos, full) {
    if (!this.enabled || !pos) return null;
    const fire = this.openFires.get(pos.id);
    if (!fire) return null;
    this.openFires.delete(pos.id);
    try {
      const exitSolTotal = full.exitSol != null ? full.exitSol
        : (full.pnlSol != null && full.entrySol != null ? full.pnlSol + full.entrySol + (full.feesSol || 0) : null);
      const d = pairDelta({
        fire: { remainderSol: fire.valueSol, realizedSolAtFire: fire.realizedSolAtFire, feesSolAtFire: fire.feesSolAtFire },
        close: { exitSolTotal, feesSol: full.feesSol },
        txFeeSol: this.cfg.txFeeSol || 0,
      });
      const rec = {
        kind: 'paired', type: 'nevergreen_paired', reason: 'never-green cut (shadow)',
        ts: full.ts || this.now(), id: pos.id, mint: pos.mint, symbol: pos.symbol || null, setup: pos.setup || null,
        fireTs: fire.ts, heldMinAtFire: fire.heldMin ?? null,
        ratioAtFire: fire.ratio, peakRatioAtFire: fire.peakRatio, valueSol: fire.valueSol,
        exitReason: full.reason || null, heldMin: full.heldMin ?? null,
        paired: !!d,
        shadowNet: d ? round(d.shadowNet, 6) : null, holdNet: d ? round(d.holdNet, 6) : null,
        deltaSol: d ? round(d.deltaSol, 6) : null, shadowWin: d ? d.shadowWin : null,
      };
      if (this.journal) this.journal.neverGreen(rec);
      return rec;
    } catch { return null; } // observer only — never disturb the close
  }

  /** GET /nevergreen payload: journaled fires paired at read time from
   *  the journal's own records (pairings journaled at close). */
  card() {
    if (!this.enabled) return { enabled: false };
    return { enabled: true, ...buildNeverGreenCard(this.journal ? this.journal.neverGreenRecs : [], this.now()) };
  }
}
