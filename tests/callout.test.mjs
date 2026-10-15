import test from 'node:test';
import assert from 'node:assert/strict';
import { validateThesis, thesisViolation, simpleFallback, buildThesis, postCallout, progressThesis } from '../src/callout.js';

// Thesis-only callouts (user, 2026-10-14): "no numbers or stats… just thesis."
// The v2 facts line (entry mc / % moves / volume / buy share) is deleted.

const NO_STATS = [/\d/, /%/, /\$\s?\d/, /in 5 min/i, /\bmc\b/i, /volume/i, /holders/i];

test('validateThesis: rejects any digit, percent or dollar amount', () => {
  assert.equal(validateThesis('in $musclecat at $46k mc.'), null);          // $ amount + digit
  assert.equal(validateThesis('a strong cat, up 59% today'), null);          // percent + digit

  assert.equal(validateThesis('a cat with 5000 holders and rising'), null); // digit
  assert.equal(validateThesis('the cat launchpad, $12k already'), null);    // $ amount
  assert.equal(validateThesis('right at its highs, 62% buys'), null);       // percent + digit
});

test('validateThesis: accepts a clean thesis — the cashtag is a name, not a stat', () => {
  assert.equal(validateThesis('cute cat.'), 'cute cat.');
  assert.equal(validateThesis('this is a cat launchpad. looks good.'), 'this is a cat launchpad. looks good.');
  assert.equal(validateThesis('"A strong cat meme for fitness enthusiasts."'), 'a strong cat meme for fitness enthusiasts.');
  assert.equal(validateThesis('gym cat energy, all gains. in $musclecat.'), 'gym cat energy, all gains. in $musclecat.');
});

test('validateThesis: rejects hype, fluff, disclaimers and non-answers', () => {
  assert.equal(validateThesis('the next moon gem of solana'), null);
  assert.equal(validateThesis('a whopping big deal of a cat'), null);
  assert.equal(validateThesis('not financial advice, but cute cat'), null);
  assert.equal(validateThesis('NONE'), null);
  assert.equal(validateThesis(''), null);
  assert.equal(validateThesis(null), null);
});

test('thesisViolation: names the stat that killed the draft', () => {
  assert.match(thesisViolation('up 59 and climbing'), /number/);
  assert.match(thesisViolation('up a lot % today'), /percent/);
  assert.equal(thesisViolation('cute cat.'), null);
  assert.equal(thesisViolation('in $musclecat, gym cat energy'), null); // cashtag alone is fine
});

test('facts-line builder and the old exports are gone', async () => {
  const m = await import('../src/callout.js');
  assert.equal(m.factBlock, undefined);
  assert.equal(m.thesis, undefined);
  assert.equal(m.validClause, undefined);
  assert.equal(m.narrativeClause, undefined);
});

/* Fetch stubbing, same pattern as the old suite: dispatch by URL. */
function stubFetch({ coin = null, openai = '' } = {}) {
  const calls = { openai: 0 };
  const fn = async (url) => {
    const u = String(url);
    if (u.includes('api.openai.com')) {
      calls.openai++;
      const content = typeof openai === 'function' ? openai(calls.openai) : openai;
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }
    if (u.includes('/coins/')) {
      if (!coin) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => coin };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  fn.calls = calls;
  return fn;
}

async function withEnv(key, fn) {
  const realFetch = globalThis.fetch;
  const had = 'OPENAI_API_KEY' in process.env;
  const prev = process.env.OPENAI_API_KEY;
  if (key == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
  try { return await fn(); }
  finally {
    globalThis.fetch = realFetch;
    if (had) process.env.OPENAI_API_KEY = prev; else delete process.env.OPENAI_API_KEY;
  }
}

test('buildThesis: rich research produces a thesis-only post — no facts fragments', async () => {
  const stub = stubFetch({
    coin: { name: 'Cat Launchpad', symbol: 'CATLP', description: 'The first launchpad where cat coins are born — a launchpad for cat tokens, run by the community.', twitter: '', website: '' },
    openai: 'this is a cat launchpad — new cat coins are born here and the community runs the show. looks good.',
  });
  await withEnv('test-key', async () => {
    globalThis.fetch = stub;
    const out = await buildThesis(
      { address: 'MINT1', symbol: 'CATLP', name: 'Cat Launchpad', mc: 46000 },
      { setup: 'pop', metrics: { gainPct: 59, volM5: 36000, buyRatioM5: 0.61 } }, // rich signal: none of it may render
    );
    assert.equal(out, 'this is a cat launchpad — new cat coins are born here and the community runs the show. looks good.');
    for (const re of NO_STATS) assert.ok(!re.test(out), `facts fragment leaked: ${re}`);
  });
});

test('buildThesis: an LLM draft that recites stats is retried once, clean rewrite wins', async () => {
  const stub = stubFetch({
    coin: { name: 'Muscle Cat', symbol: 'MUSCLECAT', description: '', twitter: '', website: '' },
    openai: (n) => n === 1
      ? 'muscle cat up 59% in 5 min with $36k volume, 61% buys'
      : 'a strong cat with gym energy. cute cat. $musclecat',
  });
  await withEnv('test-key', async () => {
    globalThis.fetch = stub;
    const out = await buildThesis({ address: 'MINT2', symbol: 'MUSCLECAT', name: 'Muscle Cat' }, {});
    assert.equal(out, 'a strong cat with gym energy. cute cat. $musclecat');
    assert.equal(stub.calls.openai, 2); // exactly one retry
  });
});

test('buildThesis: LLM fails validation twice → simple fallback, never a stats line', async () => {
  const stub = stubFetch({
    coin: { name: 'Muscle Cat', symbol: 'MUSCLECAT', description: '', twitter: '', website: '' },
    openai: 'muscle cat at $46k mc, +59% in 5 min, $36k volume',
  });
  await withEnv('test-key', async () => {
    globalThis.fetch = stub;
    const out = await buildThesis(
      { address: 'MINT3', symbol: 'MUSCLECAT', name: 'Muscle Cat', mc: 46000 },
      { setup: 'pop', metrics: { gainPct: 59, volM5: 36000 } },
    );
    assert.equal(out, 'muscle cat. looks good.');
    assert.equal(stub.calls.openai, 2);
    for (const re of NO_STATS) assert.ok(!re.test(out), `stats leaked into fallback: ${re}`);
  });
});

test('buildThesis: no research and no LLM key → simple name fallback', async () => {
  const stub = stubFetch({ coin: null }); // pump.fun has nothing on the mint
  await withEnv(null, async () => {
    globalThis.fetch = stub;
    const out = await buildThesis({ address: 'MINT4', symbol: 'MUSCLECAT', name: 'Muscle Cat' }, {});
    assert.equal(out, 'muscle cat. looks good.');
    assert.equal(stub.calls.openai, 0);
  });
});

test('buildThesis: nothing usable at all → null (callout skipped), never a stats line', async () => {
  const stub = stubFetch({ coin: null });
  await withEnv(null, async () => {
    globalThis.fetch = stub;
    const out = await buildThesis({ address: 'MINT5' }, { setup: 'pop', metrics: { gainPct: 59, volM5: 36000, buyRatioM5: 0.61 } });
    assert.equal(out, null);
  });
});

test('simpleFallback: description sentence, name riff, and un-cleanable inputs', () => {
  assert.equal(
    simpleFallback({ description: 'A launchpad for cat coins, run by the community. More words follow here.' }, {}),
    'a launchpad for cat coins, run by the community.',
  );
  assert.equal(simpleFallback({}, { name: 'Muscle Cat', symbol: 'MUSCLECAT' }), 'muscle cat. looks good.');
  // Description carries a stat and the name carries a digit: nothing clean exists.
  assert.equal(simpleFallback({ description: 'Over 5000 holders strong and growing.' }, { name: 'Cat 3000', symbol: 'CAT3000' }), null);
  assert.equal(simpleFallback({}, {}), null);
});

// ---- live-callout gate (user 2026-10-15: CALLOUTS_ENABLED, default OFF) ----
// Disabled must return BEFORE auth/thesis/network: with no wallet key in env,
// a disabled call still resolves the skip (proving auth was never attempted),
// while an enabled call rejects on the missing key (proving it proceeded).
async function withCalloutEnv(fn) {
  const realFetch = globalThis.fetch;
  const saved = {};
  for (const k of ['WALLET_PRIVATE_KEY', 'CALLOUTS_ENABLED']) { saved[k] = process.env[k]; delete process.env[k]; }
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; };
  try { return await fn(() => fetchCalls); }
  finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('postCallout gate: disabled returns the skip immediately — no auth, no fetch', async () => {
  await withCalloutEnv(async (fetchCalls) => {
    const r = await postCallout({ address: 'MINT1', symbol: 'CAT', mc: 1000 }, {}, { enabled: false });
    assert.deepEqual(r, { skipped: 'callouts-disabled' });
    assert.equal(fetchCalls(), 0);
  });
});

test('postCallout gate: default (no opts, no env) is disabled too', async () => {
  await withCalloutEnv(async (fetchCalls) => {
    const r = await postCallout({ address: 'MINT1', symbol: 'CAT', mc: 1000 }, {});
    assert.deepEqual(r, { skipped: 'callouts-disabled' });
    assert.equal(fetchCalls(), 0);
  });
});

test('postCallout gate: enabled proceeds past the gate (fails later on the missing wallet key)', async () => {
  await withCalloutEnv(async () => {
    await assert.rejects(() => postCallout({ address: 'MINT1', symbol: 'CAT', mc: 1000 }, {}, { enabled: true }));
  });
});

test('postCallout gate: CALLOUTS_ENABLED=1 in env arms it when no opts are passed', async () => {
  await withCalloutEnv(async () => {
    process.env.CALLOUTS_ENABLED = '1';
    await assert.rejects(() => postCallout({ address: 'MINT1', symbol: 'CAT', mc: 1000 }, {}));
    delete process.env.CALLOUTS_ENABLED;
    const r = await postCallout({ address: 'MINT1', symbol: 'CAT', mc: 1000 }, {});
    assert.deepEqual(r, { skipped: 'callouts-disabled' });
  });
});

// ---- the took-profit brag is deleted (user 2026-10-15) ----
test('progressThesis: the "took profit… called it here first" text can no longer be produced', () => {
  // progressThesis is the ONLY producer of progress-post text; stillHolding
  // false used to switch it to the brag. Both states now say the same thing.
  const sold = progressThesis({ symbol: 'CAT' }, { progress: true, stillHolding: false });
  const held = progressThesis({ symbol: 'CAT' }, { progress: true, stillHolding: true });
  assert.equal(sold, '$cat still running since the call.');
  assert.equal(held, sold);
  assert.ok(!/took profit/i.test(sold));
  assert.equal(validateThesis(sold), sold); // and it still passes the hard gate
});
