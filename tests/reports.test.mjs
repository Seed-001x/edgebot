import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeReport } from '../src/reports.js';

const close = (o = {}) => ({ type: 'close', id: 'x', symbol: 'X', mint: 'M', pnlSol: 0.01, heldMin: 2, reason: 'stop-loss (-17%)', ts: 1000, ...o });

test('buildTradeReport: splits bot vs manual, wins/losses, reasons, post-exit', () => {
  const closes = [
    close({ id: '1', symbol: 'A', pnlSol: 0.03, heldMin: 1 }),
    close({ id: '2', symbol: 'B', pnlSol: -0.02, heldMin: 3, reason: 'stall (60s near entry)' }),
    close({ id: '3', symbol: 'C', pnlSol: 0.05, heldMin: 20, manual: true, reason: 'manual exit (sold in own wallet)' }),
    close({ id: '4', symbol: 'D', pnlSol: -0.01, heldMin: 2, manual: true, reason: 'reconcile: sold outside bot (manual sell) — P&L from chain' }),
  ];
  const postExits = [
    { id: '1', lastMovePct: 25, peakMovePct: 40, troughMovePct: -2 },
    { id: '2', lastMovePct: -30, peakMovePct: 1, troughMovePct: -35 },
    { id: 'zzz', lastMovePct: 99 }, // not one of this window's trades — must be ignored
  ];
  const r = buildTradeReport({ index: 3, sinceTs: 0, untilTs: 9999, closes, postExits, postExitPending: ['4'], staleAborts: 2 });
  assert.equal(r.index, 3);
  assert.equal(r.trades, 4);
  assert.equal(r.wins, 2); assert.equal(r.losses, 2);
  assert.equal(r.netSol, 0.05);
  assert.equal(r.manual.n, 2); assert.equal(r.manual.netSol, 0.04);
  assert.equal(r.bot.n, 2); assert.equal(r.bot.netSol, 0.01);
  assert.equal(r.best.symbol, 'C'); assert.equal(r.worst.symbol, 'B');
  assert.equal(r.medianHoldMin, 3);
  assert.equal(r.reasons['stop-loss'], 1);
  assert.equal(r.postExit.tracked, 2);
  assert.equal(r.postExit.ranAfterExit, 1);
  assert.equal(r.postExit.diedAfterExit, 1);
  assert.equal(r.staleAborts, 2);
  assert.equal(r.rows.length, 4);
  // per-trade record: what happened after each exit
  const rowA = r.rows.find(x => x.symbol === 'A');
  assert.equal(rowA.after.lastMovePct, 25);
  assert.equal(rowA.exit.pnlSol, 0.03);
  const rowC = r.rows.find(x => x.symbol === 'C');
  assert.equal(rowC.after, null); // closed but untracked
  const rowD = r.rows.find(x => x.symbol === 'D');
  assert.equal(rowD.after.tracking, true); // still inside its 5 minutes
});

test('buildTradeReport: rows carry the entry conditions from the taken signal', () => {
  const closes = [close({ id: '9', symbol: 'E', mint: 'M9', ts: 5000 })];
  const opens = [{ type: 'open', id: '9', mint: 'M9', symbol: 'E', setup: 'pop', entrySol: 0.1, ts: 4900 }];
  const signals = [
    { mint: 'M9', symbol: 'E', setup: 'pop', decision: 'taken', ts: 4850, mc: 138000, price: 0.001, metrics: { gainPct: 47, buyRatioM5: 0.85, volM5: 45000, chgH1: null, noise: 1 } },
    { mint: 'M9', symbol: 'E', setup: 'pop', decision: 'skipped', ts: 4800, mc: 1, metrics: { gainPct: 1 } },
  ];
  const r = buildTradeReport({ index: 1, sinceTs: 0, untilTs: 9999, closes, opens, signals, postExits: [], staleAborts: 0 });
  const row = r.rows[0];
  assert.equal(row.setup, 'pop');
  assert.equal(row.entry.mc, 138000);
  assert.equal(row.entry.sol, 0.1);
  assert.equal(row.entry.conditions.gainPct, 47);
  assert.equal(row.entry.conditions.buyRatioM5, 0.85);
  assert.equal(row.entry.conditions.volM5, 45000);
  assert.equal('noise' in row.entry.conditions, false);
  assert.equal('chgH1' in row.entry.conditions, false); // nulls are dropped
});

test('buildTradeReport: empty window is a valid zero report', () => {
  const r = buildTradeReport({ index: 1, sinceTs: 0, untilTs: 1, closes: [], postExits: [], staleAborts: 0 });
  assert.equal(r.trades, 0); assert.equal(r.netSol, 0); assert.equal(r.best, null); assert.equal(r.medianHoldMin, null);
});
