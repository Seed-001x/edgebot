// signalFields.js — record-only context fields computed at signal time and
// carried on every signal record (taken / skipped / shadow). Pure functions of
// data the bot already samples; NO detector, gate, or sizing code reads them.
// Each field is null when the underlying samples are insufficient — the
// minimums are stated per field below and pinned by tests.
//
//   buyVelPerMin        — buy-side txn velocity: the mean of the samples'
//                         trailing-5m buy counts over the recent window,
//                         divided by 5 → buy txns per minute. TXN-BASED: it
//                         counts transactions (DexScreener's rolling m5
//                         counts), NOT unique buyers — one wallet can print
//                         many buys.
//   curveFillPctPerMin  — bonding-curve fill speed for a coin still ON the
//                         pump.fun curve at signal time (view.dex ===
//                         'pumpfun'): the slope of sampled market cap over
//                         the window, expressed as percentage points of the
//                         nominal graduation market cap (GRAD_MC_USD) gained
//                         per minute. On the curve, market cap rises
//                         monotonically as the curve fills, so mc slope IS
//                         fill speed. Null post-graduation (any AMM dex) or
//                         when curve data is absent.
//   holderGrowthPerMin / holderGrowthPctPerMin — holder-count change per
//                         minute (absolute, and % of the first reading) over
//                         the holder samples the bot accumulated from its own
//                         RugCheck reads (see gate.js holderLog — holder
//                         counts are not part of the DexScreener views, so
//                         this series only exists for mints the bot has
//                         already had RugCheck reports read for: judged
//                         signals, held positions' snapshots).
//   poolAgeMin / babyPool — age of the signal view's representative pair
//                         (DexScreener pairCreatedAt — the same source the
//                         2026-10-14 baby-pool journal audit used) at signal
//                         time, and whether it falls in the "baby pool" band
//                         (≤ BABY_POOL_MAX_MIN old) that audit found carrying
//                         ~2× the per-trade loss rate. Record-only study tag
//                         (user order 2026-10-15, signal-side shape): NO gate
//                         reads it — detect.js minPairAgeMin is a separate,
//                         currently-off knob. babyPool is tri-state: true /
//                         false when the age is known, null when it is not
//                         (no pairCreatedAt on the view, or a future-dated
//                         timestamp) — unknown never masquerades as "old".
//   distFromPeakPct / peakAgeSec / peakVeto — distance of the signal price
//                         under the trailing-60m SAMPLED peak (the bot's own
//                         price samples, the series the detectors judge on),
//                         how long ago that peak last printed, and a SHADOW
//                         veto verdict (user order 2026-10-15): wouldBlock
//                         when dist ≥ PEAK_VETO_DIST_PCT and age ≤
//                         PEAK_VETO_AGE_SEC. The 2026-10-15 forensic found
//                         the day's bad entries were mostly invisible in the
//                         stamps the gates judge on — coins bought after the
//                         local high was already in. This stamp makes the
//                         rollover measurable on every signal so a veto can
//                         be scored before it is ever made real: NO gate,
//                         detector or sizing path reads any of the three.
//   volM5 / buyVel / deadEntryVeto / buyVelBlock30 — the dead-entry veto
//                         study stamps (user GO 2026-10-15, off the Job 2d
//                         separator analysis): the signal's own 5m volume in
//                         USD (the figure detection itself judged on — the
//                         signal metrics' volM5 when the caller carries it,
//                         else the view's) and the buy velocity (the same
//                         value as buyVelPerMin, restated so the stamp is
//                         self-contained for re-scoring), plus would-block
//                         verdicts at FOUR volume lines ($15k / $17.5k / $20k
//                         / $25k — the whole curve is shadowed because the
//                         in-sample candidate at $17.5k flipped sign against
//                         $15k over a $2.5k gap, i.e. it was fit to the data)
//                         and at a 30/min buy-velocity line. Job 2d found ten
//                         entry-time features at coin-flip separation and
//                         only immediate activity intensity (volM5, buyVel)
//                         separating at all. Tri-state discipline, same as
//                         babyPool: a missing volM5 leaves ALL FOUR verdicts
//                         null — unknown never reads as block or pass — and a
//                         missing buyVel leaves buyVelBlock30 null. Values
//                         ride along verbatim so any threshold can be
//                         re-scored later from the journal alone. NOTHING
//                         branches on any of it: no gate, detector, sizing or
//                         exit path reads these fields; the /deadentry
//                         scorecard is the only consumer.
//   chg1mPct / chg1mShadow — the 1-minute price change into the signal
//                         (owner order 2026-10-16, off the last-50 separation
//                         study, where a candle REBUILD of this number —
//                         the bot never recorded its own — separated: all
//                         10 covered winners were rising in their entry
//                         minute, 9 of 20 covered losers were already
//                         falling). Computed from the bot's OWN samples:
//                         the signal view's price vs the sampled price
//                         closest to 60s earlier, accepted only when that
//                         sample sits within CHG1M_TOL_MS of the target —
//                         too-thin history reads null, never fabricated.
//                         chg1mShadow is the falling-minute block SHADOW
//                         verdict: 'would-block' when chg1mPct < 0, 'pass'
//                         when >= 0, 'unknown' when the samples can't say.
//                         Record-only: the owner ordered the block
//                         shadow-tested first (the study's covered winner
//                         sample was only n=10) — no gate, detector or
//                         sizing path reads either field; Bot tallies the
//                         verdicts in stats.shadowChg1m, nothing else
//                         consumes them.

export const GRAD_MC_USD = 69000; // nominal pump.fun graduation market cap (USD)
export const BABY_POOL_MAX_MIN = 15; // baby-pool band ceiling (min) from the 2026-10-14 audit
export const DEAD_ENTRY_THRESHOLDS_USD = [15000, 17500, 20000, 25000]; // dead-entry veto curve (USD 5m volume)
export const BUY_VEL_BLOCK_PER_MIN = 30; // dead-entry study's buy-velocity line (buys/min)
export const CHG1M_WINDOW_MS = 60000; // chg1m lookback: the minute before the signal
export const CHG1M_TOL_MS = 30000; // the "60s ago" sample must sit within this of the target, else chg1m is unknown

// Minimum evidence per field (below → null):
export const FIELDS_MIN = {
  buyVel: { samples: 2, spanMin: 2, windowMin: 10 },
  curveFill: { samples: 3, spanMin: 2, windowMin: 30 },
  holders: { samples: 2, spanMin: 5, windowMin: 90 },
  peak: { samples: 2, spanSec: 30, windowMin: 60 },
};

const inWindow = (arr, now, windowMin) => (arr || []).filter(x => x && now - x.ts <= windowMin * 60000 && now - x.ts >= -60000);
const spanMinOf = (arr) => (arr.length >= 2 ? (arr[arr.length - 1].ts - arr[0].ts) / 60000 : 0);
const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/**
 * @param samples  the coin's History samples [{ ts, price, mc, buysM5, ... }] oldest first
 * @param view     the signal-time view (dex decides curve membership)
 * @param holders  holder samples [{ ts, holders }] oldest first (gate.js holderSamples)
 * @param now      signal time (ms)
 * @param veto     optional shadow-veto lines { distPct, ageSec } — when given, a
 *                 peakVeto verdict block is computed from the peak stamps (record-only)
 * @param volM5    optional: the signal's own 5m volume USD as detection judged
 *                 it (the signal metrics figure). Wins over the view's volM5
 *                 when finite; null/absent falls back to the view.
 */
export function computeSignalFields({ samples = [], view = null, holders = [], now = Date.now(), veto = null, volM5 = null } = {}) {
  const out = { holderGrowthPerMin: null, holderGrowthPctPerMin: null, curveFillPctPerMin: null, buyVelPerMin: null, poolAgeMin: null, babyPool: null, distFromPeakPct: null, peakAgeSec: null, peakVeto: null, volM5: null, buyVel: null, deadEntryVeto: null, buyVelBlock30: null, chg1mPct: null, chg1mShadow: 'unknown' };

  // ---- pool age / baby-pool tag (view's pairCreatedAt; no samples needed) ----
  if (view && Number.isFinite(view.createdAt) && view.createdAt > 0) {
    const ageMin = (now - view.createdAt) / 60000;
    if (ageMin >= 0) {
      out.poolAgeMin = round(ageMin, 1);
      out.babyPool = ageMin <= BABY_POOL_MAX_MIN;
    }
  }

  // ---- buy velocity (txn-based) ----
  {
    const w = inWindow(samples, now, FIELDS_MIN.buyVel.windowMin).filter(s => Number.isFinite(s.buysM5));
    if (w.length >= FIELDS_MIN.buyVel.samples && spanMinOf(w) >= FIELDS_MIN.buyVel.spanMin) {
      const meanBuysM5 = w.reduce((a, s) => a + s.buysM5, 0) / w.length;
      out.buyVelPerMin = round(meanBuysM5 / 5, 2);
    }
  }

  // ---- bonding-curve fill speed (pre-graduation only) ----
  if (view && view.dex === 'pumpfun') {
    const w = inWindow(samples, now, FIELDS_MIN.curveFill.windowMin).filter(s => s.mc > 0);
    if (w.length >= FIELDS_MIN.curveFill.samples && spanMinOf(w) >= FIELDS_MIN.curveFill.spanMin) {
      const first = w[0], last = w[w.length - 1];
      const slopeMcPerMin = (last.mc - first.mc) / spanMinOf(w);
      out.curveFillPctPerMin = round((slopeMcPerMin / GRAD_MC_USD) * 100, 3);
    }
  }

  // ---- holder growth ----
  {
    const w = inWindow(holders, now, FIELDS_MIN.holders.windowMin).filter(s => Number.isFinite(s.holders));
    if (w.length >= FIELDS_MIN.holders.samples && spanMinOf(w) >= FIELDS_MIN.holders.spanMin) {
      const first = w[0], last = w[w.length - 1];
      const perMin = (last.holders - first.holders) / spanMinOf(w);
      out.holderGrowthPerMin = round(perMin, 2);
      if (first.holders > 0) out.holderGrowthPctPerMin = round((perMin / first.holders) * 100, 3);
    }
  }

  // ---- distance under the trailing sampled peak + shadow veto ----
  {
    const w = inWindow(samples, now, FIELDS_MIN.peak.windowMin).filter(s => Number.isFinite(s.price) && s.price > 0);
    const spanSec = w.length >= 2 ? (w[w.length - 1].ts - w[0].ts) / 1000 : 0;
    if (w.length >= FIELDS_MIN.peak.samples && spanSec >= FIELDS_MIN.peak.spanSec) {
      let peak = 0, peakTs = null;
      for (const s of w) { if (s.price >= peak) { peak = s.price; peakTs = s.ts; } } // >= : the peak's age runs from its MOST RECENT print
      const cur = view && Number.isFinite(view.price) && view.price > 0 ? view.price : w[w.length - 1].price;
      if (cur >= peak) { out.distFromPeakPct = 0; out.peakAgeSec = 0; } // at/above the sampled top right now
      else {
        out.distFromPeakPct = round((peak - cur) / peak, 3);
        out.peakAgeSec = Math.max(0, Math.round((now - peakTs) / 1000));
      }
    }
    if (veto) {
      const d = out.distFromPeakPct, a = out.peakAgeSec;
      out.peakVeto = {
        wouldBlock: d != null && a != null && d >= veto.distPct && a <= veto.ageSec,
        distPct: d, ageSec: a,
      };
    }
  }

  // ---- dead-entry veto study stamps (record-only; see header) ----
  {
    let vol = null;
    if (Number.isFinite(volM5) && volM5 >= 0) vol = volM5;
    else if (view && Number.isFinite(view.volM5) && view.volM5 >= 0) vol = view.volM5;
    out.volM5 = vol != null ? round(vol, 2) : null;
    out.buyVel = out.buyVelPerMin;
    const vetoMap = {};
    for (const t of DEAD_ENTRY_THRESHOLDS_USD) vetoMap[`wouldBlock${t}`] = vol != null ? vol < t : null;
    out.deadEntryVeto = vetoMap;
    out.buyVelBlock30 = out.buyVelPerMin != null ? out.buyVelPerMin < BUY_VEL_BLOCK_PER_MIN : null;
  }

  // ---- 1-minute price change into the signal + falling-minute shadow verdict ----
  {
    const priced = (samples || []).filter(s => s && Number.isFinite(s.price) && s.price > 0);
    const cur = view && Number.isFinite(view.price) && view.price > 0 ? view.price : null;
    if (cur != null && priced.length) {
      const target = now - CHG1M_WINDOW_MS;
      let best = null, bestDist = Infinity;
      for (const s of priced) { const d = Math.abs(s.ts - target); if (d < bestDist) { bestDist = d; best = s; } }
      if (best && bestDist <= CHG1M_TOL_MS && best.ts < now) out.chg1mPct = round((cur / best.price - 1) * 100, 1);
    }
    out.chg1mShadow = out.chg1mPct == null ? 'unknown' : (out.chg1mPct < 0 ? 'would-block' : 'pass');
  }

  return out;
}
