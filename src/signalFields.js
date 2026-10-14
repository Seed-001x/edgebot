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

export const GRAD_MC_USD = 69000; // nominal pump.fun graduation market cap (USD)

// Minimum evidence per field (below → null):
export const FIELDS_MIN = {
  buyVel: { samples: 2, spanMin: 2, windowMin: 10 },
  curveFill: { samples: 3, spanMin: 2, windowMin: 30 },
  holders: { samples: 2, spanMin: 5, windowMin: 90 },
};

const inWindow = (arr, now, windowMin) => (arr || []).filter(x => x && now - x.ts <= windowMin * 60000 && now - x.ts >= -60000);
const spanMinOf = (arr) => (arr.length >= 2 ? (arr[arr.length - 1].ts - arr[0].ts) / 60000 : 0);
const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/**
 * @param samples  the coin's History samples [{ ts, price, mc, buysM5, ... }] oldest first
 * @param view     the signal-time view (dex decides curve membership)
 * @param holders  holder samples [{ ts, holders }] oldest first (gate.js holderSamples)
 * @param now      signal time (ms)
 */
export function computeSignalFields({ samples = [], view = null, holders = [], now = Date.now() } = {}) {
  const out = { holderGrowthPerMin: null, holderGrowthPctPerMin: null, curveFillPctPerMin: null, buyVelPerMin: null };

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

  return out;
}
