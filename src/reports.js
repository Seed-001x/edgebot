// reports.js — a full report after every N closed trades, shown on the dashboard.
// Pure builder: journal closes + manual split + post-exit outcomes + guard stats in,
// one structured report out. No I/O, no trading — safe to unit-test and safe to run
// inside the close path.

const sum = (arr) => arr.reduce((a, c) => a + (c.pnlSol || 0), 0);
const r4 = (x) => +x.toFixed(4);

export function buildTradeReport({ index, sinceTs, untilTs, closes, postExits, staleAborts }) {
  const rows = (closes || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
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
  const pe = postExits || [];
  const peMoves = pe.filter(p => p.lastMovePct != null);
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
      tracked: pe.length,
      ranAfterExit: peMoves.filter(p => p.lastMovePct > 10).length,   // kept running after we sold
      diedAfterExit: peMoves.filter(p => p.lastMovePct < -10).length, // died after we sold (good exit)
    },
    staleAborts: staleAborts || 0, // freshness guard vetoes in the window
    rows: rows.map(c => ({
      symbol: c.symbol, mint: c.mint, manual: !!c.manual,
      pnlSol: c.pnlSol ?? null, heldMin: c.heldMin ?? null, reason: c.reason || null,
    })),
  };
}
