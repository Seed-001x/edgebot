import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { classifyTx, countCurveHistory, BUY_DISCS, SELL_DISCS, PUMP_PROGRAM } from '../src/curveChain.js';

const dataFor = (discHex) => bs58.encode(Buffer.concat([Buffer.from(discHex, 'hex'), Buffer.alloc(24, 1)]));
const buyDisc = [...BUY_DISCS][0];
const sellDisc = [...SELL_DISCS][0];

function txWith({ top = [], inner = [] } = {}) {
  return {
    transaction: {
      message: {
        accountKeys: [PUMP_PROGRAM, 'SomeOtherProgram1111111111111111111111111'],
        instructions: top.map(d => ({ programIdIndex: 0, accounts: [], data: d })),
      },
    },
    meta: {
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: inner.length ? [{ index: 0, instructions: inner.map(d => ({ programIdIndex: 0, accounts: [], data: d })) }] : [],
    },
  };
}

test('classifyTx counts pump buy/sell instructions, top-level and inner', () => {
  const tx = txWith({ top: [dataFor(buyDisc)], inner: [dataFor(buyDisc), dataFor(sellDisc)] });
  const c = classifyTx(tx, bs58.decode);
  assert.equal(c.buyIxs, 2);
  assert.equal(c.sellIxs, 1);
});

test('classifyTx ignores other programs and malformed txs', () => {
  const tx = txWith({ top: [dataFor(buyDisc)] });
  tx.transaction.message.instructions[0].programIdIndex = 1; // not the pump program
  assert.equal(classifyTx(tx, bs58.decode).buyIxs, 0);
  assert.deepEqual(classifyTx(null, bs58.decode), { buyIxs: 0, sellIxs: 0 });
  assert.deepEqual(classifyTx({}, bs58.decode), { buyIxs: 0, sellIxs: 0 });
});

test('countCurveHistory: bundled launch = few buy TXS, many buy instructions', () => {
  // discat's real shape: 3 buy txs carrying 4+5+4 buy instructions, 0 sells
  const classified = [
    { err: false, buyIxs: 4, sellIxs: 0 },
    { err: false, buyIxs: 5, sellIxs: 0 },
    { err: false, buyIxs: 4, sellIxs: 0 },
    { err: false, buyIxs: 0, sellIxs: 0 }, // migration
    { err: true, buyIxs: 9, sellIxs: 9 },  // failed txs never count
  ];
  const r = countCurveHistory(classified);
  assert.equal(r.buys, 3);
  assert.equal(r.buyIxs, 13);
  assert.equal(r.sells, 0);
});

test('discriminators are the real pump.fun anchor hashes', () => {
  assert.ok(BUY_DISCS.has('66063d1201daebea'));  // buy
  assert.ok(BUY_DISCS.has('07051dc4f5176550'));  // buy_v3 (discat's buys)
  assert.ok(SELL_DISCS.has('33e685a4017f83ad')); // sell
});
