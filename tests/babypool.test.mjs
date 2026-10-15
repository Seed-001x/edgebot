// Baby-pool signal tag (record-only, user order 2026-10-15 — the signal-side
// shape): every signal record's fields block carries poolAgeMin (age of the
// view's representative pair at signal time, DexScreener pairCreatedAt — the
// audit's own basis) and babyPool (≤15 min band from the 2026-10-14 journal
// audit). Nothing branches on either value; these tests pin the computation
// and the honest-null behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSignalFields, BABY_POOL_MAX_MIN } from '../src/signalFields.js';
import { view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const M = 60000;

test('babypool: band ceiling is the audit band (15 min)', () => {
  assert.equal(BABY_POOL_MAX_MIN, 15);
});

test('babypool: young pool is tagged with its age', () => {
  const f = computeSignalFields({ samples: [], view: view({ createdAt: T0 - 8.24 * M }), holders: [], now: T0 });
  assert.equal(f.poolAgeMin, 8.2);
  assert.equal(f.babyPool, true);
});

test('babypool: boundary — exactly 15 min is in the band, 15.1 is out', () => {
  const at = computeSignalFields({ samples: [], view: view({ createdAt: T0 - 15 * M }), holders: [], now: T0 });
  assert.equal(at.poolAgeMin, 15);
  assert.equal(at.babyPool, true);
  const over = computeSignalFields({ samples: [], view: view({ createdAt: T0 - 15.1 * M }), holders: [], now: T0 });
  assert.equal(over.babyPool, false);
});

test('babypool: old pool is tagged false, not null', () => {
  const f = computeSignalFields({ samples: [], view: view({ createdAt: T0 - 600 * M }), holders: [], now: T0 });
  assert.equal(f.poolAgeMin, 600);
  assert.equal(f.babyPool, false);
});

test('babypool: brand-new pool (age 0) is in the band', () => {
  const f = computeSignalFields({ samples: [], view: view({ createdAt: T0 }), holders: [], now: T0 });
  assert.equal(f.poolAgeMin, 0);
  assert.equal(f.babyPool, true);
});

test('babypool: unknown age stays null — never masquerades as old', () => {
  for (const createdAt of [null, undefined, 0, NaN]) {
    const f = computeSignalFields({ samples: [], view: view({ createdAt }), holders: [], now: T0 });
    assert.equal(f.poolAgeMin, null, `createdAt=${createdAt}`);
    assert.equal(f.babyPool, null, `createdAt=${createdAt}`);
  }
  const noView = computeSignalFields({ samples: [], view: null, holders: [], now: T0 });
  assert.equal(noView.poolAgeMin, null);
  assert.equal(noView.babyPool, null);
});

test('babypool: future-dated pair timestamp yields null, not a negative age', () => {
  const f = computeSignalFields({ samples: [], view: view({ createdAt: T0 + 5 * M }), holders: [], now: T0 });
  assert.equal(f.poolAgeMin, null);
  assert.equal(f.babyPool, null);
});

test('babypool: tag rides alongside the existing fields, others untouched', () => {
  const samples = [0, 2, 4, 6, 8].map(k => ({ ts: T0 + k * M, price: 1, mc: 50000, buysM5: 50, sellsM5: 10 }));
  const f = computeSignalFields({ samples, view: view({ dex: 'pumpswap', createdAt: T0 - 3 * M }), holders: [], now: T0 + 8 * M });
  assert.equal(f.buyVelPerMin, 10); // pre-existing field unchanged
  assert.equal(f.poolAgeMin, 11); // 3 min before T0 + 8 min elapsed
  assert.equal(f.babyPool, true);
});
