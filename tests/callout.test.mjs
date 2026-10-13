import test from 'node:test';
import assert from 'node:assert/strict';
import { factBlock, validClause } from '../src/callout.js';

// Real entry signals from 2026-10-12 (the trades whose callouts the user called "meh").
test('factBlock: trend leads with the hour and flags acceleration (ETHINU)', () => {
  const out = factBlock({ symbol: 'ETHINU', mc: 63296 }, { setup: 'trend', metrics: { chgH1: 43.76, chgM5: 68.75, buyRatioM5: 0.62, volH1: 50526.29 } });
  assert.equal(out, 'in $ethinu at $63k mc. +44% on the hour, +69% last 5m, $51k/h volume, 62% buys.');
});

test('factBlock: pop leads with the 5-minute move (VIBELON)', () => {
  const out = factBlock({ symbol: 'VIBELON', mc: 47488 }, { setup: 'pop', metrics: { gainPct: 18.9, drawFromPeak: 0.156, buyRatioM5: 0.55, volM5: 12901.9, volH1: 12901.9 } });
  assert.equal(out, 'in $vibelon at $47k mc. +19% in 5 min, $13k 5m volume, 55% buys.');
});

test('factBlock: pop at its highs says so (AGP)', () => {
  const out = factBlock({ symbol: 'AGP', mc: 109552 }, { setup: 'pop', metrics: { gainPct: 24, drawFromPeak: 0, buyRatioM5: 0.55, volM5: 25350.56, volH1: 48501.66 } });
  assert.equal(out, 'in $agp at $110k mc. +24% in 5 min, $25k 5m volume, right at its highs, 55% buys.');
});

test('factBlock: sparse data degrades to the entry line, never filler', () => {
  assert.equal(factBlock({ symbol: 'XYZ', mc: 12000 }, {}), 'in $xyz at $12k mc.');
  assert.ok(!/momentum|whopping/.test(factBlock({ symbol: 'XYZ', mc: 1 }, { setup: 'trend', metrics: {} })));
});

test('validClause: accepts a concrete, number-free description', () => {
  assert.equal(validClause('a prediction market for livestream events'), 'a prediction market for livestream events');
  assert.equal(validClause('"The mascot dog of the ETH merge anniversary."'), 'the mascot dog of the eth merge anniversary');
});

test('validClause: rejects numbers, hype, fluff and non-answers', () => {
  assert.equal(validClause('a coin with 50k holders and rising'), null);       // digits
  assert.equal(validClause('the next moon gem of solana'), null);              // banned hype
  assert.equal(validClause('a whopping momentum play on the rise'), null);     // fluff
  assert.equal(validClause('NONE'), null);
  assert.equal(validClause('up only'), null);                                  // too short
  assert.equal(validClause(''), null);
});

test('factBlock: no setup at all — numbers come from the live view (ETHINU copycat)', () => {
  // The coin the user pasted, 2026-10-12 ~21:57: $209k MC, +375% h1, +8% m5, 464 buys / 323 sells in 5m.
  const view = { symbol: 'ETHINU', mc: 208969, chgH1: 375, chgM5: 7.97, volH1: 151761.93, volM5: 46049.55, buysM5: 464, sellsM5: 323 };
  assert.equal(factBlock(view, {}), 'in $ethinu at $209k mc. +375% on the hour, +8% last 5m, $152k/h volume, 59% buys.');
});

test('narrativeClause: no links — falls back to a name riff, still validated', async () => {
  const { narrativeClause } = await import('../src/callout.js');
  const realFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-key';
  const stub = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
  try {
    globalThis.fetch = stub('riding this eth pair');
    assert.equal(await narrativeClause({}, { name: 'ETH INU', symbol: 'ETHINU' }), 'riding this eth pair');
    globalThis.fetch = stub('a coin with 5000 holders ready to moon');
    assert.equal(await narrativeClause({}, { name: 'ETH INU', symbol: 'ETHINU' }), null); // digits + hype rejected
    globalThis.fetch = stub('NONE');
    assert.equal(await narrativeClause({}, { name: 'XQZ', symbol: 'XQZ' }), null);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  }
});
