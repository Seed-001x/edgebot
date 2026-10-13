// reports.js — a full report after every N closed trades, shown on the dashboard.
// Pure builder: journal closes + their entry conditions (the taken signal) + the
// post-exit outcome per trade, in one structured record out. No I/O, no trading —
// safe to unit-test and safe to run inside the close path.

const sum = (arr) => arr.reduce((a, c) => a + (c.pnlSol || 0), 0);
const r4 = (x) => +x.toFixed(4);
const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj && obj[k] != null) out[k] = obj[k];
  return out;
};
// The conditions a coin was in when the bot decided to ape it.
const CONDITION_KEYS = ['gainPct', 'chgH1', 'chgM5', 'buyRatioM5', 'volM5', 'volH1', 'drawFromPeak', 'roundTrip'];

export function buildTradeReport({ index, sinceTs, untilTs, closes, opens, signals, postExits, postExitPending, staleAborts }) {
  const rows = (closes || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const openById = new Map((opens || []).map(o => [o.id, o]));
  const taken = (signals || []).filter(s => s.decision === 'taken');
  const peById = new Map((postExits || []).map(p => [p.id, p]));
  const pendingIds = new Set(postExitPending || []);
  const withPnl = rows.filter(c => c.pnlSol != null);
  const wins = withPnl.filter(c => c.pnlSol > 0);
  const losses = withPnl.filter(c => c.pnlSol <= 0);
  const manual = rows.filter(c => c.manual);
  const bot = rows.filter(c => !c.manual);
  const holds = rows.map(c => c.heldMin).filter(x => x != null).sort((a, b) => a - b);
  const reasons = {};
  for (const c of rows) {
    const k = String(c.reason || 'unknown').split(' (')[0].split(' — ')[0];
    reasons[k] = (reasons[k] || 0) + 1;
  }
  const best = withPnl.length ? withPnl.reduce((a, c) => (c.pnlSol > a.pnlSol ? c : a)) : null;
  const worst = withPnl.length ? withPnl.reduce((a, c) => (c.pnlSol < a.pnlSol ? c : a)) : null;

  const detail = rows.map(c => {
    const o = openById.get(c.id) || {};
    // the taken signal nearest the open is the decision record for this trade
    let sig = null;
    for (const s of taken) {
      if (s.mint !== c.mint) continue;
      if (o.ts && Math.abs((s.ts || 0) - o.ts) > 180000) continue;
      if (!sig || (s.ts || 0) > (sig.ts || 0)) sig = s;
    }
    const pe = peById.get(c.id);
    return {
      symbol: c.symbol, mint: c.mint, setup: c.setup || o.setup || (sig && sig.setup) || null,
      entry: {
        ts: o.ts || null, sol: o.entrySol ?? null,
        mc: sig ? (sig.mc ?? null) : null, price: sig ? (sig.price ?? null) : null,
        conditions: sig ? pick(sig.metrics, CONDITION_KEYS) : {},
      },
      exit: {
        ts: c.ts || null, reason: c.reason || null, heldMin: c.heldMin ?? null,
        pnlSol: c.pnlSol ?? null, pnlSource: c.pnlSource || null, manual: !!c.manual,
      },
      // what the coin did in the 5 minutes after the exit
      after: pe
        ? { lastMovePct: pe.lastMovePct ?? null, peakMovePct: pe.peakMovePct ?? null, troughMovePct: pe.troughMovePct ?? null }
        : (pendingIds.has(c.id) ? { tracking: true } : null),
    };
  });
  const peMoves = detail.map(d => d.after).filter(a => a && a.lastMovePct != null);
  return {
    index, sinceTs, untilTs,
    trades: rows.length,
    wins: wins.length, losses: losses.length,
    netSol: r4(sum(withPnl)),
    avgWinSol: wins.length ? r4(sum(wins) / wins.length) : null,
    avgLossSol: losses.length ? r4(sum(losses) / losses.length) : null,
    best: best ? { symbol: best.symbol, pnlSol: best.pnlSol } : null,
    worst: worst ? { symbol: worst.symbol, pnlSol: worst.pnlSol } : null,
    manual: { n: manual.length, netSol: r4(sum(manual)) },
    bot: { n: bot.length, netSol: r4(sum(bot)) },
    medianHoldMin: holds.length ? holds[Math.floor(holds.length / 2)] : null,
    reasons,
    postExit: {
      tracked: peMoves.length,
      ranAfterExit: peMoves.filter(p => p.lastMovePct > 10).length,   // kept running after we sold
      diedAfterExit: peMoves.filter(p => p.lastMovePct < -10).length, // died after we sold (good exit)
    },
    staleAborts: staleAborts || 0, // freshness guard vetoes in the window
    rows: detail,
  };
}
