import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeReport } from '../src/reports.js';

const close = (o = {}) => ({ type: 'close', symbol: 'X', mint: 'M', pnlSol: 0.01, heldMin: 2, reason: 'stop-loss (-17%)', ts: 1000, ...o });

test('buildTradeReport: splits bot vs manual, wins/losses, reasons, post-exit', () => {
  const closes = [
    close({ symbol: 'A', pnlSol: 0.03, heldMin: 1 }),
    close({ symbol: 'B', pnlSol: -0.02, heldMin: 3, reason: 'stall (60s near entry)' }),
    close({ symbol: 'C', pnlSol: 0.05, heldMin: 20, manual: true, reason: 'manual exit (sold in own wallet)' }),
    close({ symbol: 'D', pnlSol: -0.01, heldMin: 2, manual: true, reason: 'reconcile: sold outside bot (manual sell) — P&L from chain' }),
  ];
  const postExits = [
    { id: '1', lastMovePct: 25 }, { id: '2', lastMovePct: -30 }, { id: '3', lastMovePct: null },
  ];
  const r = buildTradeReport({ index: 3, sinceTs: 0, untilTs: 9999, closes, postExits, staleAborts: 2 });
  assert.equal(r.index, 3);
  assert.equal(r.trades, 4);
  assert.equal(r.wins, 2); assert.equal(r.losses, 2);
  assert.equal(r.netSol, 0.05);
  assert.equal(r.manual.n, 2); assert.equal(r.manual.netSol, 0.04);
  assert.equal(r.bot.n, 2); assert.equal(r.bot.netSol, 0.01);
  assert.equal(r.best.symbol, 'C'); assert.equal(r.worst.symbol, 'B');
  assert.equal(r.medianHoldMin, 3);
  assert.equal(r.reasons['stop-loss'], 1);
  assert.equal(r.postExit.tracked, 3);
  assert.equal(r.postExit.ranAfterExit, 1);
  assert.equal(r.postExit.diedAfterExit, 1);
  assert.equal(r.staleAborts, 2);
  assert.equal(r.rows.length, 4);
});

test('buildTradeReport: empty window is a valid zero report', () => {
  const r = buildTradeReport({ index: 1, sinceTs: 0, untilTs: 1, closes: [], postExits: [], staleAborts: 0 });
  assert.equal(r.trades, 0); assert.equal(r.netSol, 0); assert.equal(r.best, null); assert.equal(r.medianHoldMin, null);
});
