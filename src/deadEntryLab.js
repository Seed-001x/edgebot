// deadEntryLab.js — Dead-Entry Veto study scorecard (user GO 2026-10-15,
// RECORD-ONLY). Job 2d's separator analysis found that of ten entry-time
// features, only immediate activity intensity — the signal's own 5m volume
// (volM5) and buy velocity (buyVel) — separated pop entries that never
// peaked from movers at all, and only at ~0.6 AUC. The user ordered the
// candidate veto shadowed, not built: every pop signal record now carries
// the raw values plus would-block verdicts at FOUR volM5 lines ($15k /
// $17.5k / $20k / $25k — the whole curve, because in-sample $15k lost money
// while $17.5k made it, a sign flip over $2.5k that marks the $17.5k line
// as fit to the data) and at a 30/min buy-velocity line (see
// signalFields.js). This module folds those stamps against the signals'
// forward outcome tracking (r5/r15/r60/maxRet, the journal's own fields)
// into the /deadentry scorecard: per rule, the vetoed set vs the passed
// set, each split into first/second halves by signal time (the both-halves
// check — a real separator must hold in both, not just on average).
//
// HARD BOUNDARIES: nothing here gates, buys, sells, or feeds any decision.
// The verdicts on the records are never read back by detection, gates,
// sizing, or exits; this read-time aggregation is their only consumer.
// Judging bar (the Job 2d design): >= 300 vetoed signals on a threshold
// AND >= 14 days of collecting — the status block reports progress toward
// it and never claims READY before both legs hold.
import { median, round } from './util.js';
import { DEAD_ENTRY_THRESHOLDS_USD, BUY_VEL_BLOCK_PER_MIN } from './signalFields.js';

export const DEAD_ENTRY_BAR = { vetoedSignals: 300, days: 14 };

/** Fold raw signal records + outcome records into stamped pop rows.
 *  A row survives only if it is a pop signal carrying the dead-entry stamp
 *  (fields.deadEntryVeto) — pre-stamp history simply isn't in the study.
 *  Outcomes join by signal id (latest outcome record wins); a row whose
 *  outcome never finalized carries out:null and counts as pending, never
 *  as a scored zero. */
export function foldStampedPopSignals(signalRecords, outcomeRecords) {
  const outs = new Map();
  for (const o of outcomeRecords || []) if (o && o.id) outs.set(o.id, o);
  const rows = [];
  for (const s of signalRecords || []) {
    if (!s || s.setup !== 'pop') continue;
    const f = s.fields;
    if (!f || !f.deadEntryVeto) continue;
    rows.push({
      id: s.id, ts: s.ts, mint: s.mint, symbol: s.symbol, decision: s.decision || null,
      fast: !!(s.metrics && s.metrics.fastStream),
      volM5: f.volM5 != null ? f.volM5 : null,
      buyVel: f.buyVel != null ? f.buyVel : null,
      veto: f.deadEntryVeto,
      buyVelBlock30: f.buyVelBlock30 != null ? f.buyVelBlock30 : null,
      out: outs.get(s.id) || null,
    });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/** One set's outcome aggregates. n counts every stamped signal in the
 *  set; scored counts those with a finalized outcome; the medians/shares
 *  run over the scored subset only (a still-tracking signal is pending,
 *  not a flat zero). sharePeak50 = share of scored rows whose forward
 *  peak (maxRet, the outcome tracker's own excursion field) reached
 *  >= +50%. */
function aggSet(rows) {
  const scored = rows.filter(r => r.out && r.out.done);
  const r60 = scored.map(r => r.out.r60).filter(Number.isFinite);
  const peaks = scored.map(r => r.out.maxRet).filter(Number.isFinite);
  return {
    n: rows.length,
    scored: scored.length,
    medianR60: r60.length ? round(median(r60)) : null,
    sharePeak50: peaks.length ? round(peaks.filter(x => x >= 0.5).length / peaks.length, 3) : null,
  };
}

/** One rule's row: the vetoed set, the passed set, the unknowns (flag
 *  null — the underlying value was missing, and unknown is neither set),
 *  and the both-halves split of the same sets at the study-wide median
 *  signal time. */
function ruleRow(rows, flagOf, splitTs) {
  const vetoed = rows.filter(r => flagOf(r) === true);
  const passed = rows.filter(r => flagOf(r) === false);
  const half = (arr, first) => arr.filter(r => (first ? r.ts <= splitTs : r.ts > splitTs));
  return {
    vetoed: aggSet(vetoed),
    passed: aggSet(passed),
    unknown: rows.length - vetoed.length - passed.length,
    halves: [
      { vetoed: aggSet(half(vetoed, true)), passed: aggSet(half(passed, true)) },
      { vetoed: aggSet(half(vetoed, false)), passed: aggSet(half(passed, false)) },
    ],
  };
}

/** The /deadentry payload over folded rows (see foldStampedPopSignals). */
export function buildDeadEntryCard(rows, now) {
  const rs = rows || [];
  const splitTs = rs.length ? median(rs.map(r => r.ts)) : null;
  const thresholds = DEAD_ENTRY_THRESHOLDS_USD.map(t => ({
    threshold: t,
    ...ruleRow(rs, r => (r.veto ? r.veto[`wouldBlock${t}`] : null), splitTs),
  }));
  const buyVelRule = { line: BUY_VEL_BLOCK_PER_MIN, ...ruleRow(rs, r => r.buyVelBlock30, splitTs) };
  const firstTs = rs.length ? rs[0].ts : null;
  const spanDays = firstTs != null ? Math.max(0, (now - firstTs) / 86400e3) : 0;
  const maxVetoed = thresholds.reduce((m, r) => Math.max(m, r.vetoed.n), 0);
  const ready = maxVetoed >= DEAD_ENTRY_BAR.vetoedSignals && spanDays >= DEAD_ENTRY_BAR.days;
  return {
    enabled: true,
    generatedTs: now,
    note: 'record-only shadow study — would these pop entries have been vetoed on their own 5m volume / buy velocity? Nothing gates on the stamps; the both-halves split is at the median signal time.',
    stampedPopSignals: rs.length,
    fastPopSignals: rs.filter(r => r.fast).length,
    pendingOutcomes: rs.filter(r => !(r.out && r.out.done)).length,
    unknownVol: rs.filter(r => r.volM5 == null).length,
    unknownBuyVel: rs.filter(r => r.buyVel == null).length,
    firstStampTs: firstTs,
    spanDays: round(spanDays, 2),
    thresholds,
    buyVelRule,
    status: {
      ready,
      collecting: !ready,
      bar: { ...DEAD_ENTRY_BAR },
      progress: { vetoedSignals: maxVetoed, days: round(spanDays, 1) },
      basis: `ready = some threshold reaches >=${DEAD_ENTRY_BAR.vetoedSignals} vetoed stamped pop signals AND the stamps have been collecting >=${DEAD_ENTRY_BAR.days} days (span from the first stamped pop signal). Until both legs hold, the study is COLLECTING and no threshold is endorsed.`,
    },
  };
}
