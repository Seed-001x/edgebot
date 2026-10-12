// liveFeed.test.mjs — parser tests for the PumpPortal websocket feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewCoin } from '../src/liveFeed.js';

const MINT = 'HyGtGYUEnnJXzGaN3RdLb261P82nGrApxJj3KsZ3V7Ht';

test('parses a create event', () => {
  const raw = JSON.stringify({ txType: 'create', mint: MINT, symbol: 'COMPANY', name: 'Comany', traderPublicKey: 'x' });
  const out = parseNewCoin(raw);
  assert.equal(out.mint, MINT);
  assert.equal(out.symbol, 'COMPANY');
});

test('parses a Buffer payload', () => {
  const raw = Buffer.from(JSON.stringify({ txType: 'create', mint: MINT }));
  assert.equal(parseNewCoin(raw).mint, MINT);
});

test('ignores non-create events', () => {
  assert.equal(parseNewCoin(JSON.stringify({ txType: 'buy', mint: MINT })), null);
  assert.equal(parseNewCoin(JSON.stringify({ txType: 'sell', mint: MINT })), null);
  assert.equal(parseNewCoin(JSON.stringify({ message: 'subscribed' })), null);
});

test('ignores malformed payloads', () => {
  assert.equal(parseNewCoin('not json'), null);
  assert.equal(parseNewCoin(''), null);
  assert.equal(parseNewCoin(JSON.stringify({ txType: 'create' })), null);
  assert.equal(parseNewCoin(JSON.stringify({ txType: 'create', mint: 'not-a-mint!!' })), null);
  assert.equal(parseNewCoin(JSON.stringify(null)), null);
});
