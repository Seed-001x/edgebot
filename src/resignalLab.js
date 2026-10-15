// resignalLab.js — Answered Re-signals shadow (user 2026-10-15, RECORD-ONLY).
//
// The user reviews signals on the dashboard and ANSWERS them — a verdict on
// what the bot did (see verdictOf: the dashboard's Answered chips verbatim,
// minus the ✗/✓ glyphs) plus an optional free-text note ("why I answered
// that way"). This lab answers one question in shadow: WHEN A COIN HE HAS
// ALREADY ANSWERED SIGNALS AGAIN LATER, HOW DOES THE RE-SIGNAL DO — split by
// his verdict? A coin he called "Good coin — missed it" that pops again is a
// different animal from one he called "Correct skip" doing the same thing,
// and until now nothing separated them.
//
// Mechanics: Journal.signal() is the single funnel every signal record flows
// through (taken / skipped / shadow / flow record-only alike). As each new
// signal lands, the journal asks pickResignalMark whether the mint carries a
// user mark on an EARLIER signal (marked-signal ts + 5 min buffer, so the
// marked signal itself and its immediate echo can never count). A hit writes
// ONE record to resignal_shadow.jsonl per (mint, mark) pair — the fired set
// of mark keys is rebuilt from that file at boot, and a NEWER mark on the
// same mint is a new key, so marking again re-arms the mint. Outcomes are
// NOT recomputed here: the new signal is outcome-tracked by the journal's
// existing machinery (r5/r15/r60/maxRet) and the scorecard joins it at read
// time via signalKey.
//
// HARD BOUNDARIES: record-only. Nothing in this module or its journal hook
// posts, signs, buys, sells, or alters any decision; every caller wraps it
// fail-silent so a lab failure can never reach a trading path.
import { median, round } from './util.js';

/** A re-signal must land strictly more than this long after the signal the
 *  user marked — the marked signal itself is excluded by construction (it
 *  was journaled before the mark existed); the buffer also keeps the rapid
 *  same-mint echo right around a mark from counting as a "re-signal". */
export const RESIGNAL_BUFFER_MS = 5 * 60000;

/** The pinned taken-pop baseline (gate-pricing, n=247) — served on the card
 *  as CONTEXT ONLY so a verdict segment's runner share can be eyeballed
 *  against the coins the bot actually took. Not a target, not a gate. */
export const RESIGNAL_BASELINE = { runners: 21.8, crashes: 38.1, r60: -37.5, label: 'pinned taken-pop baseline — context only' };

/** His verdict on a mark, in the dashboard's own words (Answered chips,
 *  index.html: '✗ Good coin — missed it' / '✓ Correct skip' on non-taken
 *  signals, 'You backed it' / 'Bad setup — avoid' on taken ones). The glyph
 *  is presentation; the stored verdict is the plain text. */
export function verdictOf(good, decision) {
  if (decision === 'taken') return good ? 'You backed it' : 'Bad setup — avoid';
  return good ? 'Good coin — missed it' : 'Correct skip';
}

/** Resolve a feedback mark to the signal it was made ON: exactly, via
 *  signalId, when the mark carries one; otherwise the latest signal for the
 *  mint at or before the mark's own timestamp (the same fallback
 *  Journal.feedbackList uses). Returns null when the marked signal cannot be
 *  found — pre-journal marks, marks whose signal aged out of the in-memory
 *  window — and the caller skips those silently. */
export function resolveMark(mark, byId, signals) {
  if (!mark || !mark.mint) return null;
  if (mark.signalId) {
    const s = byId.get(mark.signalId);
    if (!s || !s.mint) return null;
    return { mint: s.mint, markedTs: s.ts, markedMc: s.mc ?? null, markedSetup: s.setup || null, markedDecision: s.decision || null };
  }
  for (let i = (signals || []).length - 1; i >= 0; i--) {
    const s = signals[i];
    if (s.mint === mark.mint && s.ts <= mark.ts) {
      return { mint: s.mint, markedTs: s.ts, markedMc: s.mc ?? null, markedSetup: s.setup || null, markedDecision: s.decision || null };
    }
  }
  return null;
}

/** The mark a fresh signal record fires on, if any: among the mint's marks
 *  that resolve to an earlier signal, are past the buffer, and have not
 *  already produced a resignal record, the MOST RECENT marked signal wins
 *  (ties: the later mark). `fired` is the Set of mark keys (feedbackKeyOf
 *  form) already claimed — one record per (mint, mark); a newer mark is a
 *  different key, which is what re-arms the mint. */
export function pickResignalMark(signal, feedback, byId, signals, fired) {
  if (!signal || !signal.mint) return null;
  let best = null;
  for (const mark of feedback || []) {
    if (!mark || mark.mint !== signal.mint) continue;
    const key = mark.key || (mark.signalId ? `sid:${mark.signalId}` : `mt:${mark.mint}:${mark.ts}`);
    if (fired && fired.has(key)) continue;
    const resolved = resolveMark(mark, byId, signals);
    if (!resolved) continue;
    if (!(signal.ts > resolved.markedTs + RESIGNAL_BUFFER_MS)) continue;
    if (!best || resolved.markedTs > best.resolved.markedTs || (resolved.markedTs === best.resolved.markedTs && (mark.ts || 0) > (best.mark.ts || 0))) {
      best = { mark, key, resolved };
    }
  }
  return best;
}

/** The /resignals scorecard over resignal records, outcomes joined at read
 *  time via outcomeOf(signalKey) -> the new signal's outcome object (or
 *  null while it is still tracking / unknown). Aggregates per verdict:
 *  medianPeak is the median maxRet over finalized records; sharePeak50 the
 *  share of those that ran >= +50%; sharePosR60 the share of finalized
 *  records carrying an r60 that were green at the hour. */
export function buildResignalCard(records, outcomeOf) {
  const recs = (records || []).filter(r => r && r.kind === 'resignal');
  const joined = recs.map(r => ({ r, out: outcomeOf ? outcomeOf(r.signalKey) : null }));
  const agg = (arr) => {
    const fin = arr.filter(x => x.out && x.out.done);
    const peaks = fin.map(x => x.out.maxRet).filter(Number.isFinite);
    const r60s = fin.map(x => x.out.r60).filter(Number.isFinite);
    return {
      n: arr.length,
      finalized: fin.length,
      medianPeak: peaks.length ? round(median(peaks)) : null,
      medianR60: r60s.length ? round(median(r60s)) : null,
      sharePeak50: peaks.length ? round(peaks.filter(x => x >= 0.5).length / peaks.length, 3) : null,
      sharePosR60: r60s.length ? round(r60s.filter(x => x > 0).length / r60s.length, 3) : null,
    };
  };
  const groups = new Map();
  for (const x of joined) {
    const k = x.r.verdict || 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const byVerdict = {};
  for (const [k, arr] of groups) byVerdict[k] = agg(arr);
  const recent = joined.slice(-12).reverse().map(({ r, out }) => ({
    ts: r.ts, mint: r.mint, symbol: r.symbol || null, verdict: r.verdict || null, good: r.good ?? null,
    notePresent: !!r.notePresent, note: r.note ?? null,
    markedTs: r.markedTs ?? null, markedMc: r.markedMc ?? null, markedSetup: r.markedSetup || null, markedDecision: r.markedDecision || null,
    resignalMc: r.resignalMc ?? null, resignalSetup: r.resignalSetup || null, resignalDecision: r.resignalDecision || null,
    out: out ? { done: !!out.done, r5: out.r5 ?? null, r15: out.r15 ?? null, r60: out.r60 ?? null, maxRet: out.maxRet ?? null, minRet: out.minRet ?? null, partial: !!out.partial } : null,
  }));
  return { byVerdict, recent, baseline: { ...RESIGNAL_BASELINE } };
}
