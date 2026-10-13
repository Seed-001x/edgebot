// liveFeed.test.mjs — parser tests for the PumpPortal websocket feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewCoin, parseTrade, LiveFeed } from '../src/liveFeed.js';

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

// ---- parseTrade (fast pop stream) ----
test('parses a buy trade with the trade-implied price', () => {
  const raw = JSON.stringify({ txType: 'buy', mint: MINT, solAmount: 0.5, tokenAmount: 250000, marketCapSol: 85.5 });
  const t = parseTrade(raw);
  assert.equal(t.mint, MINT);
  assert.equal(t.side, 'buy');
  assert.ok(Math.abs(t.price - 0.5 / 250000) < 1e-12);
  assert.equal(t.mcSol, 85.5);
});
test('parses a sell trade; marketCapSol optional', () => {
  const t = parseTrade(JSON.stringify({ txType: 'sell', mint: MINT, solAmount: 1.25, tokenAmount: 500000 }));
  assert.equal(t.side, 'sell');
  assert.equal(t.mcSol, null);
});
test('ignores non-trade and unusable payloads', () => {
  assert.equal(parseTrade(JSON.stringify({ txType: 'create', mint: MINT, solAmount: 1, tokenAmount: 5 })), null);
  assert.equal(parseTrade(JSON.stringify({ txType: 'migrate', mint: MINT, solAmount: 1, tokenAmount: 5 })), null);
  assert.equal(parseTrade(JSON.stringify({ txType: 'buy', mint: MINT, solAmount: 0, tokenAmount: 5 })), null);
  assert.equal(parseTrade(JSON.stringify({ txType: 'buy', mint: MINT, tokenAmount: 5 })), null);
  assert.equal(parseTrade(JSON.stringify({ message: 'subscribed' })), null);
  assert.equal(parseTrade('not json'), null);
});

// ---- trade subscription sync ----
test('syncTradeSubs subscribes additions and unsubscribes removals', () => {
  const A = 'A'.repeat(32), B = 'B'.repeat(32), C = 'C'.repeat(32);
  let desired = [A, B];
  const sent = [];
  const feed = new LiveFeed({ onMint: () => {}, tradeWatch: () => desired });
  feed.ws = { send: (s) => sent.push(JSON.parse(s)) };
  feed.stats.connected = true;
  feed.syncTradeSubs();
  assert.deepEqual(sent, [{ method: 'subscribeTokenTrade', keys: [A, B] }]);
  assert.equal(feed.tradeSubs.size, 2);
  desired = [B, C];
  feed.syncTradeSubs();
  assert.deepEqual(sent[1], { method: 'subscribeTokenTrade', keys: [C] });
  assert.deepEqual(sent[2], { method: 'unsubscribeTokenTrade', keys: [A] });
  assert.deepEqual([...feed.tradeSubs].sort(), [B, C]);
  feed.syncTradeSubs(); // no change = no frames
  assert.equal(sent.length, 3);
});
