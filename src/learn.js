// learn.js — capture what the bot saw at entry, and what happened when the HUMAN closed a position.
// Pure helpers only. Nothing here changes a buy/sell decision: it records, labels and reports.

export const EXIT_REASONS = ['dev_bundle', 'stalled', 'farm_wallets', 'chart_off', 'other'];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** compact, flat feature snapshot (all numbers) so groups of trades can be compared later */
export function snapshotFeatures({ v = {}, sig = {}, rug = null, g = null, now = Date.now() } = {}) {
  const top = (rug && rug.topHolders) || [];
  const top10 = top.slice(0, 10).reduce((a, h) => a + (num(h.pct) || 0), 0);
  const f = {
    price: num(v.price), mc: num(v.mc), liq: num(v.liq), ageMin: v.createdAt ? Math.round((now - v.createdAt) / 60000) : null,
    volM5: num(v.volM5), volH1: num(v.volH1), buysM5: num(v.buysM5), sellsM5: num(v.sellsM5), buysH1: num(v.buysH1), sellsH1: num(v.sellsH1),
    chgM5: num(v.chgM5), chgH1: num(v.chgH1), chgH24: num(v.chgH24),
    holders: rug ? num(rug.totalHolders) : null, insiderWallets: rug ? num(rug.graphInsidersDetected) : null,
    top10Pct: top.length ? +top10.toFixed(2) : null,
    linkedDrain: g && g.checks && g.checks.linkedDump ? num(g.checks.linkedDump.drain) : null,
  };
  f.flowM5 = f.buysM5 != null && f.sellsM5 != null ? +(f.buysM5 / Math.max(1, f.sellsM5)).toFixed(2) : null;
  return { setup: sig.setup || null, warnings: (g && g.warnings) || [], ...f };
}

/** did the human sell outside the bot? on-chain balance far below what the bot thinks it holds */
export function externalExit(trackedRaw, onchainRaw, frac = 0.5) {
  const t = Number(trackedRaw), o = Number(onchainRaw);
  if (!(t > 0) || !Number.isFinite(o)) return false;
  return o < t * (1 - frac);
}

const mean = (a) => { const x = a.filter(Number.isFinite); return x.length ? +(x.reduce((s, y) => s + y, 0) / x.length).toFixed(2) : null; };
const KEYS = ['mc', 'liq', 'ageMin', 'holders', 'insiderWallets', 'top10Pct', 'flowM5', 'chgM5', 'chgH1', 'linkedDrain'];

/** manual exits vs positions the bot closed in profit: which entry features differ? (descriptive only — needs a human to judge) */
export function learnReport(manual, trades) {
  const winners = trades.filter(t => t.type === 'close' && !t.manual && t.pnlSol > 0 && t.entry);
  const byReason = {};
  for (const m of manual) { const r = m.reason || 'untagged'; byReason[r] = (byReason[r] || 0) + 1; }
  const compare = {};
  for (const k of KEYS) compare[k] = { manualExits: mean(manual.map(m => m.entry && m.entry[k])), botWinners: mean(winners.map(t => t.entry[k])) };
  const n = manual.length;
  return {
    manualExits: n, tagged: manual.filter(m => m.reason).length, byReason, botWinnersCompared: winners.length, compare,
    note: n < 20 ? `only ${n} manual exits so far — treat differences as noise until ~20-30 are tagged` : 'enough samples to start looking for a rule (a human should review before anything is automated)',
  };
}
