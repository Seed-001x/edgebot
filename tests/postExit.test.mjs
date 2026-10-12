import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PostExitTracker, summarizePostExit, POST_EXIT_WINDOW_MS } from '../src/postExit.js';
import { tmp } from './helpers.mjs';

test('summarizePostExit: moves vs the exit anchor', () => {
  const s = summarizePostExit(2, [{ ts: 1, price: 2.2 }, { ts: 2, price: 3 }, { ts: 3, price: 1 }]);
  assert.equal(s.samples, 3);
  assert.equal(s.lastMovePct, -50);
  assert.equal(s.peakMovePct, 50);
  assert.equal(s.troughMovePct, -50);
  assert.deepEqual(summarizePostExit(0, [{ ts: 1, price: 1 }]), { samples: 0, lastMovePct: null, peakMovePct: null, troughMovePct: null });
  assert.deepEqual(summarizePostExit(2, []), { samples: 0, lastMovePct: null, peakMovePct: null, troughMovePct: null });
});

test('tracker: watches, samples from the poll feed, finalizes at +5 min and persists', () => {
  const dir = tmp();
  let now = 1_000_000;
  const tr = new PostExitTracker(dir, () => now);
  tr.watch({ id: 'P1', mint: 'M', symbol: 'AAA', exitTs: now, exitPriceUsd: 1, reason: 'stop-loss', pnlSol: -0.02 });
  const prices = { M: 1.5 };
  tr.tick(m => prices[m] ?? null, now + 60_000);
  now += POST_EXIT_WINDOW_MS + 1000;
  tr.tick(m => prices[m] ?? null, now);
  const { done, pending } = tr.recent();
  assert.equal(pending.length, 0);
  assert.equal(done.length, 1);
  assert.equal(done[0].symbol, 'AAA');
  assert.equal(done[0].lastMovePct, 50); // ripped +50% after the exit
  const lines = fs.readFileSync(path.join(dir, 'post_exit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  // a fresh tracker over the same dir reloads the finalized record
  const tr2 = new PostExitTracker(dir, () => now);
  assert.equal(tr2.recent().done.length, 1);
});

test('tracker: no exit price -> first sample becomes the anchor; duplicate watch ignored', () => {
  const dir = tmp();
  let now = 5_000_000;
  const tr = new PostExitTracker(dir, () => now);
  tr.watch({ id: 'P2', mint: 'M', symbol: 'BBB', exitTs: now, exitPriceUsd: null });
  tr.watch({ id: 'P2', mint: 'M', symbol: 'BBB', exitTs: now, exitPriceUsd: null });
  assert.equal(tr.recent().pending.length, 1);
  tr.tick(() => 4, now + 10_000); // first sample anchors at 4
  now += POST_EXIT_WINDOW_MS + 1000;
  tr.tick(() => 2, now);
  const done = tr.recent().done;
  assert.equal(done.length, 1);
  assert.equal(done[0].anchorPrice, 4);
  assert.equal(done[0].lastMovePct, -50);
});
