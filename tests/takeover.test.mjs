// TAKEOVER switch (user 2026-10-15, the XZON race: his manual sell and the bot's
// own ratchet sell fired into the same balance and the bot's sell found nothing):
// POST /takeover hands an open position to the user ENTIRELY. While pos.takenOver
// is set, exit judging is skipped in full — no TP ladder, no trails, no stop
// family, no bleed, no probation leash/expiry, no ratchet, no momentum failure,
// no time stops, not even liquidity death — and nothing else in the bot may sell
// the position either (bundle watcher, no-quote force-exit). Marks, peaks and
// flow history keep updating; the manual-exit detector and the reconciler keep
// working, so the user's own sell books exactly as manual sells book today.
// POST /release hands it back with FRESH arming (the protect precedent): no
// pendings, stop un-armed, probation cleared, and the stall/probation clock
// re-anchored to the release moment (pos.stallBaseTs). The flag lives on the
// persisted position record: survives restarts, dies with the position.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateExit } from '../src/exits.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg } from './helpers.mjs';

// ---- judge level (exits.test.mjs rig) ----
const cfg = testCfg({ stallProbationSec: 0 }); const NOW = 1_000_000_000_000;
const S = 1000;
const pos = (o = {}) => ({ entrySol: 0.02, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 5 * 60000, ...o });
const mark = (valueSol, o = {}) => ({ valueSol, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });
const takenPos = (o = {}) => pos({ takenOver: NOW - 60000, ...o });
const stallCfg = { ...cfg, stallSec: 60, stallBandPct: 0.05, dipStopPct: 0 };
const probCfg = { ...cfg, stallSec: 180, stallProbationSec: 300, stallLeashPct: 0.07, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
const beCfg = { ...cfg, dipStopPct: 0 };
const bleedCfg = { ...cfg, dipStopPct: 0, stallSec: 0 };
const hist = (...prints) => prints.map(([agoSec, move]) => ({ ts: NOW - agoSec * S, move }));

test('takeover: every exit family is skipped — the whole stack holds at fraction 0', () => {
  const tp1Fixed = { ...cfg, tp1AdaptMax: cfg.tp1Pct };
  const shapes = [
    ['liquidity death', () => pos(), () => mark(0.05, { liqUsd: 1500 }), cfg, /liquidity death/],
    ['dip stop', () => pos(), () => mark(0.011), cfg, /dip stop/],
    ['TP1', () => pos(), () => mark(0.0264), tp1Fixed, /TP1/],
    ['TP2', () => pos({ tp1Done: true, remainingFrac: 0.6 }), () => mark(0.0264), cfg, /TP2/],
    ['moonbag trail', () => pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.25, peakRatio: 2 }), () => mark(0.006), cfg, /moonbag trail/],
    ['post-TP1 trail', () => pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.30 }), () => mark(0.01152), cfg, /post-TP1 trail/],
    ['stall', () => pos({ entryTs: NOW - 60 * S }), () => mark(0.0201), stallCfg, /stall \(in entry range/],
    ['probation leash', () => pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} }), () => mark(0.0185), { ...probCfg, exitConfirmSec: 0 }, /probation leash/],
    ['probation expiry', () => pos({ entryTs: NOW - 400 * S, probationSince: NOW - 100 * S, exitPending: {} }), () => mark(0.0201), probCfg, /probation expired/],
    ['break-even ratchet', () => pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {} }), () => mark(0.0204), { ...beCfg, exitConfirmSec: 0 }, /break-even ratchet/],
    ['bleed exit', () => pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: {} }), () => mark(0.0182), { ...bleedCfg, exitConfirmSec: 0 }, /bleed exit/],
    ['momentum failure', () => pos({ entryTs: NOW - 15 * 60000 }), () => mark(0.019, { buysM5: 0, sellsM5: 10 }), { ...cfg, dipStopPct: 0, stopHardPct: 0, stopLoss: 0, stallSec: 0 }, /momentum failure/],
    ['time stop', () => pos({ entryTs: NOW - 30 * 60000, tp1Done: true, remainingFrac: 0.6, peakRatio: 1.05 }), () => mark(0.0126), cfg, /time stop/],
    ['max hold', () => pos({ entryTs: NOW - 130 * 60000, tp1Done: true, remainingFrac: 0.6, peakRatio: 1.5 }), () => mark(0.018), cfg, /max hold/],
  ];
  for (const [name, mkPos, mkMark, c, reason] of shapes) {
    const ctl = evaluateExit(mkPos(), mkMark(), c, NOW);
    assert.ok(ctl.fraction > 0 && reason.test(ctl.reason || (ctl.tp1 ? 'TP1' : ctl.tp2 ? 'TP2' : '')), `${name}: control must sell (got fraction=${ctl.fraction} reason=${ctl.reason})`);
    const d = evaluateExit(takenPos(mkPos()), mkMark(), c, NOW);
    assert.equal(d.fraction, 0, `${name}: taken-over position must hold`);
    assert.equal(d.takenOver, true, `${name}: decision must carry the takeover flag`);
    assert.ok(!d.tp1 && !d.tp2, `${name}: no TP bookkeeping under takeover`);
  }
});

test('takeover: tracking still runs — peak, move and moveHist follow the marks', () => {
  const p = takenPos({ entryTs: NOW - 30 * S, exitPending: {} });
  const d1 = evaluateExit(p, mark(0.024), cfg, NOW);            // ratio 1.20 — a fresh high print
  assert.equal(d1.fraction, 0);
  assert.equal(d1.newPeak, 1.2);
  assert.equal(d1.newPeakMove, 1.2);
  assert.equal(d1.moveHist.length, 1);
  assert.equal(d1.moveHist[0].move, 1.2);
  p.peakRatio = d1.newPeak; p.peakMove = d1.newPeakMove; p.moveHist = d1.moveHist; // bot.js threads the state back
  const d2 = evaluateExit(p, mark(0.021), cfg, NOW + 4 * S);    // faded print: peak must NOT come down
  assert.equal(d2.newPeak, 1.2);
  assert.equal(d2.moveHist.length, 2);
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.021), cfg, NOW).takenOver, undefined); // untaken decisions carry no flag
});

test('takeover: stored pendings are dropped silently and all arming state clears', () => {
  const p = takenPos({
    entryTs: NOW - 200 * S, stopArmedTs: NOW - 5000, floorChecks: 2, floorSince: NOW - 5000,
    probationSince: NOW - 20000, tp1Arm: { ts: NOW - 5000, share: 0.5 },
    exitPending: { ratchet: NOW - 12000, bleed: NOW - 5000, leash: NOW - 5000 },
  });
  const d = evaluateExit(p, mark(0.0182), { ...bleedCfg, exitConfirmSec: 10 }, NOW); // bleed-shaped crash print
  assert.equal(d.fraction, 0);
  assert.deepEqual(d.exitPending, {});          // every pending dropped...
  assert.deepEqual(d.exitConfirmEvents, []);    // ...silently — no fake 'cancelled' events
  assert.equal(d.stopArmedTs, null);
  assert.equal(d.floorChecks, 0);
  assert.equal(d.floorSince, null);
  assert.equal(d.probationSince, null);
  assert.equal(d.tp1Arm, null);
});

test('takeover + protect: takeover wins — nothing judges and no protectedBlock is reported', () => {
  const p = pos({ protected: NOW - 60000, takenOver: NOW - 30000 });
  const d = evaluateExit(p, mark(0.011), cfg, NOW);   // deep in dip-stop territory, where protect alone would report a block
  assert.equal(d.fraction, 0);
  assert.equal(d.takenOver, true);
  assert.equal(d.protectedBlock, null);
});

test('release: the stall clock re-anchors — a matured probation cannot fire, and probation restarts from the release anchor', () => {
  // the record as releasePosition leaves it: probation cleared, stallBaseTs = release time (60s ago)
  const released = pos({ entryTs: NOW - 400 * S, probationSince: null, exitPending: {}, stallBaseTs: NOW - 60 * S });
  const d = evaluateExit(released, mark(0.0201), probCfg, NOW);   // true age 400s, stall age only 60s — deadline not reached
  assert.equal(d.fraction, 0);
  assert.equal(d.probationSince, null);
  const ctl = evaluateExit(pos({ entryTs: NOW - 400 * S, probationSince: NOW - 100 * S, exitPending: {} }), mark(0.0201), probCfg, NOW);
  assert.equal(ctl.fraction, 1); assert.match(ctl.reason, /probation expired/);   // control: unreleased, the matured expiry sells
  const d2 = evaluateExit(released, mark(0.0201), probCfg, NOW + 121 * S);       // stall age now 181s ≥ 180s, still in the band
  assert.equal(d2.fraction, 0);
  assert.equal(d2.probationSince, NOW + 121 * S);                                // probation starts fresh from the new anchor
});

// ---- bot level (protect.test.mjs rig) ----
const T0 = 1_000_000_000_000;
function rig() {
  const cfg = testCfg();
  const clock = { t: T0 };
  const exec = new Executor(cfg, { quote: async (input) => (input === SOL_MINT ? { outAmount: '1000000000', priceImpactPct: '0.01' } : { outAmount: '0' }) });
  const deps = {
    now: () => clock.t, exec,
    discover: async () => new Map(),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  };
  const bot = new Bot(cfg, deps);
  const openPos = (o = {}) => {
    const p = { id: 'pos1', mint: 'MINTX', symbol: 'XXX', setup: 'pop', entrySol: 0.05, remainingFrac: 1, peakRatio: 1, peakMove: 1, entryTs: clock.t, entryRoundTrip: 0.97, exitPending: {}, ...o };
    bot.positions.push(p);
    return p;
  };
  return { cfg, clock, deps, bot, openPos };
}

test('takeover: sets the flag on the open position, counts the set, exposes it on /state, persists it', () => {
  const { cfg, bot, openPos } = rig();
  const p = openPos();
  const r = bot.takeoverPosition('MINTX');
  assert.equal(r, p);
  assert.equal(p.takenOver, T0);
  assert.equal(bot.stats.takeover.set, 1);
  assert.equal(bot.state().positions[0].takenOver, T0);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'positions.json'), 'utf8'));
  assert.equal(saved.find(x => x.mint === 'MINTX').takenOver, T0); // on the position record — survives restarts
  // re-takeover (by symbol this time) is a no-op: same flag, no double count
  assert.equal(bot.takeoverPosition('XXX'), p);
  assert.equal(bot.stats.takeover.set, 1);
});

test('takeover: a stored exitPending is dropped at set time, before any further check runs', () => {
  const { bot, openPos } = rig();
  const p = openPos({ exitPending: { ratchet: T0 - 12000, bleed: T0 - 5000 } });
  bot.takeoverPosition('MINTX');
  assert.deepEqual(p.exitPending, {});
});

test('takeover: unknown mint returns null and changes nothing', () => {
  const { bot, openPos } = rig();
  openPos();
  assert.equal(bot.takeoverPosition('NOSUCHMINT'), null);
  assert.equal(bot.positions[0].takenOver, undefined);
  assert.equal(bot.stats.takeover, undefined);
});

test('takeover: the flag survives a reload — a fresh Bot on the same data dir restores it', () => {
  const { cfg, deps, bot, openPos } = rig();
  openPos();
  bot.takeoverPosition('MINTX');
  const bot2 = new Bot(cfg, deps); // loadPositions() reads positions.json, as a restart does
  assert.equal(bot2.positions.length, 1);
  assert.equal(bot2.positions[0].takenOver, T0);
});

test('release: clears the flag, re-anchors the stall clock, fresh-arms the record, counts the release; repeat and unknown calls are clean misses', () => {
  const { cfg, clock, bot, openPos } = rig();
  const p = openPos({ stopArmedTs: T0 - 5000, floorChecks: 2, floorSince: T0 - 5000, probationSince: T0 - 20000, tp1Arm: { ts: T0 - 5000, share: 0.5 }, exitPending: { ratchet: T0 - 12000 } });
  assert.equal(bot.releasePosition('MINTX'), false);      // exists but not taken over
  bot.takeoverPosition('MINTX');
  clock.t = T0 + 3600000;                                  // the user held it for an hour
  const r = bot.releasePosition('MINTX');
  assert.equal(r, p);
  assert.equal(p.takenOver, undefined);
  assert.equal(p.stallBaseTs, T0 + 3600000);               // stall/probation clock re-anchored to the release moment
  assert.equal(p.stopArmedTs, null);                       // fresh arming on the record itself
  assert.equal(p.floorChecks, 0);
  assert.equal(p.floorSince, null);
  assert.equal(p.probationSince, null);
  assert.equal(p.tp1Arm, null);
  assert.deepEqual(p.exitPending, {});
  assert.equal(bot.stats.takeover.released, 1);
  assert.equal(bot.state().positions[0].takenOver, null);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'positions.json'), 'utf8'));
  assert.equal(saved.find(x => x.mint === 'MINTX').takenOver, undefined);
  assert.equal(saved.find(x => x.mint === 'MINTX').stallBaseTs, T0 + 3600000);
  assert.equal(bot.releasePosition('MINTX'), false);       // already released
  assert.equal(bot.releasePosition('NOSUCHMINT'), null);   // no such position
});

test('takeover: the flag dies with the position — a rebuy of the same mint starts untaken', () => {
  const { bot, openPos } = rig();
  openPos();
  bot.takeoverPosition('MINTX');
  bot.positions = [];                                        // the position closed (any path removes the record)
  const fresh = openPos({ id: 'pos2' });
  assert.equal(fresh.takenOver, undefined);
  assert.equal(bot.state().positions[0].takenOver, null);
});

test('takeover + protect coexist: both flags ride the record and /state shows both', () => {
  const { bot, openPos } = rig();
  const p = openPos();
  bot.protectPosition('MINTX');
  bot.takeoverPosition('MINTX');
  assert.equal(p.protected, T0);
  assert.equal(p.takenOver, T0);
  const s = bot.state().positions[0];
  assert.equal(s.protected, T0);
  assert.equal(s.takenOver, T0);
});

// ---- position loop (ratchetShadow.test.mjs rig: stub exec, direct managePosition) ----
const LT0 = 1_800_000_000_000;
function loopRig(over = {}) {
  const cfg = testCfg({ realMode: false, ...over });
  const clock = { t: LT0 };
  const rig = { cfg, clock, mark: 0, markThrows: false, sells: 0, onchain: '0' };
  rig.exec = {
    solBalance: async () => 5,
    markValue: async () => { if (rig.markThrows) throw new Error('no quote'); return rig.mark; },
    sell: async () => { rig.sells++; return { tokensSold: '1000000', solOut: rig.mark, sig: null, simulated: true }; },
    address: async () => 'WALLET',
    ownerBalance: async () => rig.onchain,
    closeEmptyAccounts: async () => {},
  };
  rig.bot = new Bot(cfg, {
    now: () => clock.t, exec: rig.exec,
    discover: async () => new Map(), fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  rig.pos = (o = {}) => ({
    id: 'p1', mint: 'MINT1', symbol: 'TKO', setup: 'pop', entrySol: 0.1, tokensRaw: '1000000',
    remainingFrac: 1, entryRoundTrip: 0.972, peakRatio: 1, peakMove: 1, entryTs: clock.t,
    realizedSol: 0, feesSol: 0, simulated: true, exitPending: {}, ...o,
  });
  return rig;
}

test('managePosition: a taken-over position rides through a crash — no sell, peaks tracked, suppressed passes counted', async () => {
  const r = loopRig();
  const pos = r.pos();
  r.bot.positions.push(pos);
  r.bot.takeoverPosition('MINT1');
  r.mark = 0.1 * 1.30 * 0.972;                               // move 1.30 — a fresh high
  await r.bot.managePosition(pos, 150);
  assert.equal(r.bot.positions.length, 1);
  assert.equal(r.sells, 0);
  assert.ok(pos.peakRatio > 1.26, `peak must track under takeover (got ${pos.peakRatio})`);
  r.clock.t += 4000;
  r.mark = 0.1 * 0.80 * 0.972;                               // move 0.80 — dip stop / floor / bleed all live here
  await r.bot.managePosition(pos, 150);
  r.clock.t += 4000;
  await r.bot.managePosition(pos, 150);
  assert.equal(r.bot.positions.length, 1);                   // still held — the bot never sold
  assert.equal(r.sells, 0);
  assert.deepEqual(r.bot.journal.trades.filter(t => t.id === 'p1' && (t.type === 'sell' || t.type === 'close')), []);
  assert.equal(r.bot.stats.takeover.set, 1);
  assert.equal(r.bot.stats.takeover.sellsSuppressed, 3);     // one suppressed judging pass per check
});

test('managePosition: release restores judging — a matured pre-takeover pending does NOT fire instantly; a fresh window arms, then sells', async () => {
  const r = loopRig();
  const pos = r.pos({ peakMove: 1.12, exitPending: { ratchet: LT0 - 12000 } }); // ratchet pending already matured (12s > 10s window)
  r.bot.positions.push(pos);
  r.bot.takeoverPosition('MINT1');
  assert.deepEqual(pos.exitPending, {});                     // dropped at set time
  r.mark = 0.1 * 1.01 * 0.972;                               // move 1.01 — inside the armed ratchet's trigger
  await r.bot.managePosition(pos, 150);
  assert.equal(r.sells, 0);                                  // suppressed under takeover
  r.bot.releasePosition('MINT1');
  r.clock.t += 2000;
  await r.bot.managePosition(pos, 150);
  assert.equal(r.sells, 0);                                  // NO instant sell off the stale pending — a fresh window arms instead
  assert.equal(pos.exitPending.ratchet, r.clock.t);
  r.clock.t += 11000;                                        // the fresh window matures with the trigger still true
  await r.bot.managePosition(pos, 150);
  assert.equal(r.sells, 1);
  assert.equal(r.bot.positions.length, 0);
  const closes = r.bot.journal.trades.filter(t => t.type === 'close');
  assert.equal(closes.length, 1);
  assert.match(closes[0].reason, /^break-even ratchet/);
});

test('managePosition: the no-quote force-exit is suppressed while taken over (and fires for the control)', async () => {
  const r = loopRig();
  const pos = r.pos({ markFails: 5 });                       // already past the 4-failure force-exit line
  r.bot.positions.push(pos);
  r.bot.takeoverPosition('MINT1');
  r.markThrows = true;
  await r.bot.managePosition(pos, 150);
  assert.equal(r.bot.positions.length, 1);                   // never force-exited
  assert.equal(r.sells, 0);
  const ctl = loopRig();
  const cpos = ctl.pos({ markFails: 5 });
  ctl.bot.positions.push(cpos);
  ctl.markThrows = true;
  await ctl.bot.managePosition(cpos, 150);
  assert.equal(ctl.sells, 1);                                // control: untaken, the fallback sells
  assert.equal(ctl.bot.positions.length, 0);
});

test('managePosition: a manual sell while taken over books as a manual exit — the XZON scenario, race-free', async () => {
  const r = loopRig({ realMode: true });
  const pos = r.pos({ simulated: false });
  r.bot.positions.push(pos);
  r.bot.takeoverPosition('MINT1');
  r.clock.t = LT0 + 120000;                                  // 2 min in — the detector is live (>60s, chain checks due)
  r.mark = 0.09;
  r.onchain = '0';                                           // the user sold everything in his own wallet
  await r.bot.managePosition(pos, 150);                      // strike 1
  assert.equal(r.bot.positions.length, 1);
  assert.equal(r.sells, 0);
  r.clock.t += 16000;
  await r.bot.managePosition(pos, 150);                      // strike 2 — the manual exit books
  assert.equal(r.bot.positions.length, 0);
  assert.equal(r.sells, 0);                                  // the bot itself never sold a token
  const closes = r.bot.journal.trades.filter(t => t.type === 'close');
  assert.equal(closes.length, 1);
  assert.match(closes[0].reason, /^manual exit \(sold in own wallet\)/);
  assert.ok(r.bot.journal.manual.find(x => x.id === 'p1'));
});

// ---- endpoints (manualfill.test.mjs shape) ----
test('endpoints: /takeover and /release — 401 without key, 400 without mint, 404s, 200 happy path', async () => {
  process.env.ADMIN_KEY = 'tk-test-key';
  const { bot, openPos } = rig();
  openPos();
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body, key) => {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-admin-key'] = key;
    const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await post('/takeover', { mint: 'MINTX' })).status, 401);            // no admin key
    assert.equal((await post('/takeover', {}, 'tk-test-key')).status, 400);           // no mint
    assert.equal((await post('/takeover', { mint: 'NOPE' }, 'tk-test-key')).status, 404); // no open position
    const ok = await post('/takeover', { symbol: 'XXX' }, 'tk-test-key');              // symbol resolves too
    assert.equal(ok.status, 200);
    assert.equal(ok.body.takenOver, T0);
    assert.equal(ok.body.position.takenOver, T0);
    assert.equal(bot.positions[0].takenOver, T0);
    const rel404 = await post('/release', { mint: 'NOPE' }, 'tk-test-key');
    assert.equal(rel404.status, 404);
    const rel = await post('/release', { mint: 'MINTX' }, 'tk-test-key');
    assert.equal(rel.status, 200);
    assert.equal(rel.body.takenOver, null);
    assert.equal(bot.positions[0].takenOver, undefined);
    const rel2 = await post('/release', { mint: 'MINTX' }, 'tk-test-key');            // not taken over anymore
    assert.equal(rel2.status, 404);
    assert.equal(rel2.body.error, 'position is not taken over');
    assert.equal((await post('/release', { mint: 'MINTX' })).status, 401);
  } finally { srv.close(); delete process.env.ADMIN_KEY; }
});
