// config.js — every number the bot uses lives here. loadConfig(env) is pure so tests can call it.
// All trading thresholds are STARTING GUESSES. The outcome journal exists so you can tune them from data.

const num = (env, k, d) => {
  const v = env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env = process.env) {
  const hasKey = !!(env.WALLET_PRIVATE_KEY || '').trim();
  const realMode = env.REAL_MODE === '1' && hasKey;
  const cfg = {
    realMode,
    modeWarning: env.REAL_MODE === '1' && !hasKey ? 'REAL_MODE=1 but WALLET_PRIVATE_KEY missing → running in SHADOW mode' : null,

    // ---- hard limits (enforced in risk.js, not advisory) ----
    tradeSol: num(env, 'TRADE_SOL', 0.05),
    maxPositions: num(env, 'MAX_POSITIONS', 5),
    dailyLossSol: num(env, 'DAILY_LOSS_SOL', 0),        // realized loss in a UTC day that halts new entries; 0 = disabled
    haltAfterCloses: num(env, 'HALT_AFTER_CLOSES', 0),  // one-shot: halt new entries after this many more closes; 0 = off
    haltDownSol: num(env, 'HALT_DOWN_SOL', 0),          // balance halt: once armed (baseline = wallet equity at first check), halt if equity falls this much below the baseline; 0 = off. Set 0.09 by user 2026-10-13 for overnight — user corrected: BALANCE, not day P&L.
    // D4 cold-market streak pause (user 2026-10-13, his design over his agent's timer version):
    // N straight red closes pause new entries; the bot keeps scanning and resumes ITSELF only
    // when market breadth (share of sampled coins green on the hour) recovers and stays
    // recovered — never on a timer alone, never on one coin's signal. Bot-managed layer only:
    // the balance halt above it still releases exclusively by the user's hand.
    streakPauseN: num(env, 'STREAK_PAUSE_N', 4),              // straight losses that trigger the pause (0 = off)
    streakPauseMinMin: num(env, 'STREAK_PAUSE_MIN_MIN', 15),  // minimum minutes a pause lasts, however hot it gets
    streakHeatPct: num(env, 'STREAK_HEAT_PCT', 0.5),           // breadth share (chgH1 > 0) that counts as a hot market
    streakHeatSustainMin: num(env, 'STREAK_HEAT_SUSTAIN_MIN', 10), // breadth must hold at/above the line this long to resume
    streakHeatMinCoins: num(env, 'STREAK_HEAT_MIN_COINS', 50),     // breadth only counts with at least this many coins reporting
    killEquityFrac: num(env, 'KILL_EQUITY_FRAC', 0.5),  // wallet SOL below this fraction of starting → permanent halt
    minReserveSol: num(env, 'MIN_RESERVE_SOL', 0.02),   // never spend the last of the fees
    maxTradesPerHour: num(env, 'MAX_TRADES_PER_HOUR', 120),
    mandatoryApesPerHour: num(env, 'MANDATORY_APES_PER_HOUR', 0), // user 2026-10-13 (entry-fixes A1): default OFF — forcing gate-failed signals through to hit an hourly quota made the bot lower its standards exactly when nobody was watching. Was 5 in code / 10 in live env.
    paceRelax: num(env, 'PACE_RELAX', 0),               // user 2026-10-13 (entry-fixes A2): 1 = paceCfg loosens gate thresholds (liq/mc floors cut, maxMc ×1.5). Default 0 = gates run at face value, always.
    mintCooldownMin: num(env, 'MINT_COOLDOWN_MIN', 20),
    loserCooldownH: num(env, 'LOSER_COOLDOWN_H', 6),    // don't re-buy a coin that closed at a loss within this many hours (0 = off)
    closedCooldownH: num(env, 'CLOSED_COOLDOWN_MIN', 0) > 0 ? num(env, 'CLOSED_COOLDOWN_MIN', 0) / 60 : num(env, 'CLOSED_COOLDOWN_H', 3),  // don't re-buy a coin that closed AT ALL (win or loss) within the cooldown (0 = off). Added 2026-10-12 at 3h (the journal's only 2 re-entries both lost); user cooled it to 5 minutes on 2026-10-13 (it blocked an OSPREY re-entry) — CLOSED_COOLDOWN_MIN overrides in minutes when set.
    maxPoolFraction: num(env, 'MAX_POOL_FRACTION', 0.05), // position ≤ 5% of pool liquidity
    allowLarge: env.ALLOW_LARGE === '1',                // typo guard: TRADE_SOL > 0.25 refused unless set
    shadowStartSol: num(env, 'SHADOW_START_SOL', 1),

    // ---- execution ----
    buyBps: num(env, 'BUY_SLIPPAGE_BPS', 1500),
    sellBps: num(env, 'SELL_SLIPPAGE_BPS', 2500),
    priorityFeeLamports: num(env, 'PRIORITY_FEE_LAMPORTS', 100000),
    closeEmptyAccounts: num(env, 'CLOSE_EMPTY_ACCOUNTS', 1) === 1, // after a full sell, close the token account → ~0.002 SOL rent back
    minRoundTrip: num(env, 'MIN_ROUND_TRIP', 0.80),     // sell-back value / spend must be ≥ this, else unexitable/too thin
    jupBase: env.JUP_BASE || 'https://api.jup.ag/swap/v1',
    jupTokensBase: env.JUP_TOKENS_BASE || 'https://lite-api.jup.ag/tokens/v2',
    jupApiKey: env.JUP_API_KEY || '',
    rpcUrls: (env.RPC_URLS || 'https://api.mainnet-beta.solana.com').split(',').map(s => s.trim()).filter(Boolean),

    // ---- eligibility ----
    minMc: num(env, 'MIN_MC', 10000),
    maxMc: num(env, 'MAX_MC', 2_000_000),
    minLiqUsd: num(env, 'MIN_LIQ_USD', 15000),
    minLiqToMc: num(env, 'MIN_LIQ_TO_MC', 0.03),
    minPairAgeMin: num(env, 'MIN_PAIR_AGE_MIN', 0),   // skip pools younger than N min (0 = off). Off: winners W/GTRADE/Playground/19 were all bought 1–5m after pool open

    // ---- 'pop' detector (needs live history: flat → vertical) ----
    popWindowSec: num(env, 'POP_WINDOW_SEC', 300),
    popGainPct: num(env, 'POP_GAIN_PCT', 35),
    popMaxGainPct: num(env, 'POP_MAX_GAIN_PCT', 200),   // already >3x in the window = chasing
    popMinVolH1: num(env, 'POP_MIN_VOL_H1', 20000),   // legacy: pop volume is judged on the 5m window now (below)
    popMinVolM5: num(env, 'POP_MIN_VOL_M5', 25000),   // user 2026-10-12: the 25k belongs on 5m volume, not the hour
    popMinBuysM5: num(env, 'POP_MIN_BUYS_M5', 20),    // was 5: real momentum = many buyers, not a handful
    popMinChgH1: num(env, 'POP_MIN_CHG_H1', 0),       // coin must be UP on the hour: a bounce off a crash is not a pop
    popMaxBelowHigh: num(env, 'POP_MAX_BELOW_HIGH', 0.30), // skip if price is >30% under its 1h high (dead-cat bounce)
    popMaxDropH6: num(env, 'POP_MAX_DROP_H6', 40),    // skip pops on coins down 40%+ over 6h (for young pools: since launch) — a crash
                                                      // that already left the 1h window still counts (0 = off)
    minBuyRatioM5: num(env, 'MIN_BUY_RATIO_M5', 0.60), // user 2026-10-13 (entry-fixes A5): 0.55 → 0.60 — ARCADES (0.56) and MEMEOS (0.57) barely cleared the old bar and died
    maxBuyRatioM5: num(env, 'MAX_BUY_RATIO_M5', 0.85), // D1 band top (user 2026-10-13, Muse's call on 'fix it as you see fit'): the ratio fails at BOTH ends — at 0.85+ the 'demand' is usually one bundled buyer, not a crowd (PEPECAT 0.90 and MIRAGE 0.88 both lost; no winner today printed that high). Applies to pop + trend. 0 = off.
    maxDrawFromPeak: num(env, 'MAX_DRAW_FROM_PEAK', 0.15), // enter on strength, not on the way down

    // ---- 'fast pop' detector (live trade stream, user 2026-10-13) ----
    // The classic pop reads trailing DexScreener aggregates and fires at the echo of a
    // move (SCI: first signal ~90s after the spike peaked; OSPREY: no signal at all
    // during a +230% recovery). Fast pop computes the move from PumpPortal's live
    // trade stream over a short window, so the signal exists seconds after the move
    // does. Same 'pop' pipeline after detection — every gate still applies.
    fastPop: num(env, 'FAST_POP', 1),                        // 1 = on (stream detection active)
    fastPopWindowSec: num(env, 'FAST_POP_WINDOW_SEC', 90),   // rolling window judged on stream trades
    fastPopGainPct: num(env, 'FAST_POP_GAIN_PCT', 30),       // price gain from the window low, %
    fastPopMaxGainPct: num(env, 'FAST_POP_MAX_GAIN_PCT', 0), // entry-fixes A4 knob, shipped OFF: a ceiling here kills the OSPREY shape fast pop was built for — a V-recovery reads +91% off the 90s window low and is a catch, not a chase (the window low is 90 seconds old, not a 5m base). Set FAST_POP_MAX_GAIN_PCT=75 to apply the classic cap here too.
    fastPopMinVolSol: num(env, 'FAST_POP_MIN_VOL_SOL', 2.5), // total SOL traded inside the window
    fastPopMinBuys: num(env, 'FAST_POP_MIN_BUYS', 8),        // distinct buy trades inside the window
    fastPopMinBuyShare: num(env, 'FAST_POP_MIN_BUY_SHARE', 0.60), // buys / (buys + sells), live flow (0.55 → 0.60, entry-fixes A5)
    fastPopMaxBuyShare: num(env, 'FAST_POP_MAX_BUY_SHARE', 0.85), // D1 band top for the stream share — same bundle-bait logic as MAX_BUY_RATIO_M5; 0 = off
    fastPopMaxDrop: num(env, 'FAST_POP_MAX_DROP', 0.08),     // last price may be at most this below the window peak
    fastPopMinTrades: num(env, 'FAST_POP_MIN_TRADES', 12),   // total trades inside the window
    fastPopRecentSec: num(env, 'FAST_POP_RECENT_SEC', 15),   // the move must still be printing…
    fastPopMinRecent: num(env, 'FAST_POP_MIN_RECENT', 3),    // …with at least this many trades in the recent slice
    fastPopMaxSubs: num(env, 'FAST_POP_MAX_SUBS', 150),      // stream subscriptions track the freshest watch mints
    fastPopEvalMs: num(env, 'FAST_POP_EVAL_MS', 1000),       // per-mint evaluation throttle

    // ---- 'trend' detector (runner already ranked hot; uses DexScreener priceChange, no history needed) ----
    trendMinH1: num(env, 'TREND_MIN_H1', 25),
    trendMaxH1: num(env, 'TREND_MAX_H1', 400),
    trendMinM5: num(env, 'TREND_MIN_M5', 2),
    trendMinVolH1: num(env, 'TREND_MIN_VOL_H1', 100000),
    trendMinBuyRatio: num(env, 'TREND_MIN_BUY_RATIO', 0.60), // 0.52 → 0.60 (entry-fixes A5) — MageTrail got in at 0.52 and stopped out
    // Trend pause + quality guards (user 2026-10-13, entry-fixes B1–B5; tonight's trend went 0-for-9):
    trendEnabled: num(env, 'TREND_ENABLED', 0),          // B1: 0 = trend detector paused; pop keeps running. Re-enable only with B2–B5 in and a backtest showing trend net positive.
    trendMinMc: num(env, 'TREND_MIN_MC', 30000),         // B4: trend needs a real market cap (BORING $15k, Urara $15.6k); 0 = off
    trendMinBuyRatioH1: num(env, 'TREND_MIN_BUY_RATIO_H1', 0.55), // B2: the whole HOUR must be buy-dominated, not just a 14-trade 5m blip (Urara: 411 buys vs 445 sells on the hour); 0 = off
    trendMinTxnsM5: num(env, 'TREND_MIN_TXNS_M5', 30),   // B2: at least this many 5m trades before a ratio counts as demand; 0 = off
    trendMaxVolToMc: num(env, 'TREND_MAX_VOL_TO_MC', 3), // B3: wash reject — small cap (below FRESH_SMALL_MC) with hourly volume > this × its cap is churn, not demand (Urara: $71k on $15.6k = 4.5×); applies to pop too; 0 = off
    revivalMinAgeD: num(env, 'REVIVAL_MIN_AGE_D', 7),    // B5: pool at least this many days old…
    revivalMaxChgH6: num(env, 'REVIVAL_MAX_CHG_H6', 300), // …and up this much in 6h = dead-coin revival, skip (Urara's pool was ~67 days old, +550% h6); 0 = off
    trendMinBuysM5: num(env, 'TREND_MIN_BUYS_M5', 5),
    // Freshness is VOLUME, not price (user 2026-10-14, UNTXED): a grind can run +121% on the
    // hour in small price steps, so the old rule (last-5m price gain ≥ a share of the hourly
    // move) made grinds structurally invisible. What must be fresh is the trading itself: 5m
    // volume at/above this floor proves the coin is alive NOW. The coin must still be at least
    // slightly green on the 5m (trendMinM5). 0 = off (no freshness check).
    trendFreshMinVolM5: num(env, 'TREND_FRESH_MIN_VOL_M5', 25000),
    // ---- 'churn' detector (user 2026-10-14): a dumped coin BASING at its lows with a trade
    // count that refuses to die — accumulation BEFORE any pop (the Vwhale shape: −53% peak→low,
    // then ~180 tx/5m of two-way flow at support while its buy ratio sat ~0.50, so pop never
    // fired). Needs the dump, the base, the sustained count, two-way flow, and a real average
    // trade size — the avg floor is what separates accumulation from wash churn by construction:
    // it sits above the botflow ($6) and dust ($1.5) HARD gate floors, and the B3 wash reject /
    // hard gates still judge every churn candidate downstream.
    churnEnabled: num(env, 'CHURN_ENABLED', 1) === 1,
    churnMinDropPct: num(env, 'CHURN_MIN_DROP_PCT', 40),   // sampled peak → window low drop that counts as "dumped"
    churnLowBandPct: num(env, 'CHURN_LOW_BAND_PCT', 10),  // current price must sit within this % of the window low
    churnStableMin: num(env, 'CHURN_STABLE_MIN', 10),     // no new low for this long = the dump is over, it's basing
    churnMinTxM5: num(env, 'CHURN_MIN_TX_M5', 120),       // trailing-5m trade count (buys+sells), sustained over the last 3 samples
    churnMinBuyShare: num(env, 'CHURN_MIN_BUY_SHARE', 0.40), // two-way interest, not an exit stampede (deliberately below the pop 0.60)
    churnMinAvgUsd: num(env, 'CHURN_MIN_AVG_USD', 10),    // volM5 / tx — above BOTFLOW_MAX_AVG_USD ($6) and DUST_MAX_AVG_USD ($1.5) so wash/dust flow can't qualify
    churnWatchH: num(env, 'CHURN_WATCH_H', 3),            // basing watch: a coin that dumped stays watchlist-pinned this many hours past WATCH_TTL
    churnWatchMax: num(env, 'CHURN_WATCH_MAX', 40),       // max pinned coins (oldest pin evicted first)

    // ---- 'flow' detector (user 2026-10-14): tracked smart wallets' BUYS are the trigger,
    // not price momentum. Polls each wallet's recent transactions over the existing Helius
    // RPC (RPC_URLS) — NOT the PumpPortal stream (dark while its wallet sits under the 0.02
    // SOL streaming threshold). A wallet nominates; the full gate stack still judges.
    // FLOW_WALLETS empty = module inert. FLOW_SOLO_WALLETS: a solo wallet's buy fires on its
    // own — no size bar, no confluence — above only the 0.1 SOL anti-dust floor. The user's
    // solo wallets: Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6 ("chairman") and
    // 5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG ("yenni"). FLOW_WALLET_NAMES maps any
    // tracked address to a display name (address:name pairs) used in signal labels —
    // "flow: yenni bought 0.85 SOL"; unnamed wallets label by shortened address.
    flowEnabled: num(env, 'FLOW_ENABLED', 1) === 1,
    flowWallets: (env.FLOW_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean),
    flowSoloWallets: (env.FLOW_SOLO_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean),
    flowNames: Object.fromEntries((env.FLOW_WALLET_NAMES || '').split(',').map(s => s.trim()).filter(Boolean)
      .map(pair => { const i = pair.lastIndexOf(':'); return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : [pair, '']; })
      .filter(([addr, name]) => addr && name)),
    flowPollSec: num(env, 'FLOW_POLL_SEC', 30),           // per-wallet signature poll cadence
    flowMinSol: num(env, 'FLOW_MIN_SOL', 1.0),            // a single tracked wallet buying >= this fires alone
    flowWalletsConfl: num(env, 'FLOW_WALLETS_CONFL', 2),  // …or this many distinct wallets buying the same mint…
    flowWindowMin: num(env, 'FLOW_WINDOW_MIN', 15),       // …inside this window (any size above the 0.1 SOL dust floor)

    // ---- 'graduation watch' (user 2026-10-14: "do that every 2 minutes then not 3hrs") ----
    // Post-graduation runners were structurally invisible: Plois graduated and ran +41%
    // in 5m while the bot had never seen the mint — the /reallists graduated list arrives
    // EMPTY (mirror gap) and the movers/trending scrape is 3-hourly. This poller asks
    // pump.fun's v3 API for recently COMPLETED coins every GRAD_POLL_SEC and feeds fresh
    // graduations into the watchlist through noteMint's reserved slice (source
    // 'graduated'). GRAD_FRESH_MIN is the activity window: a first-observed completion
    // only counts while the coin's last trade is inside it. There is no graduation
    // timestamp in the v3 payload and created_timestamp cannot judge freshness (Plois
    // sat on the curve 49 minutes before graduating) — the first-observed-completion
    // transition is the freshness signal. The first poll after boot primes it, and
    // since the boot backfill (user 2026-10-14) it also ADDS still-fresh completions
    // found at prime time, capped by GRAD_BACKFILL_MAX — a coin that graduated while
    // the bot was down (UNTXED: graduated 01:28 EDT, watcher booted 01:39) is caught
    // at startup instead of being primed away as history.
    gradWatchEnabled: num(env, 'GRAD_WATCH_ENABLED', 1) === 1,
    gradPollSec: num(env, 'GRAD_POLL_SEC', 120),          // how often to ask pump.fun for fresh completions
    gradFreshMin: num(env, 'GRAD_FRESH_MIN', 30),         // a first-seen completion counts while its last trade is within this window
    gradBackfillMax: num(env, 'GRAD_BACKFILL_MAX', 50),   // boot backfill: max adds from the priming poll, freshest first (0 = off, pure priming)

    // Pre-buy freshness guard: abort if the price moved hard between signal and execution (stale quote).
    prebuyMaxDumpPct: num(env, 'PREBUY_MAX_DUMP_PCT', 30), // fresh < signal*(1-30%) → dumped, abort
    prebuyMaxPumpPct: num(env, 'PREBUY_MAX_PUMP_PCT', 100), // fresh > signal*2 → chasing, abort
    // Quote-level freshness guard: price implied by the live round-trip buy quote vs the
    // decision price. The DexScreener re-pull above can lag the pool by minutes (NEVER,
    // 2026-10-12: decided at $49k, filled at $2.3k); the Jupiter quote cannot. 0 = off.
    freshGuardPct: num(env, 'FRESH_GUARD_PCT', 10), // abort if |live − decision| > 10%
    reportEveryTrades: num(env, 'REPORT_EVERY_TRADES', 10), // full report on the dashboard after every N closes

    // ---- gates ----
    requireReportBelowAgeH: num(env, 'REQUIRE_REPORT_BELOW_AGE_H', 6), // young coins with no RugCheck report are blocked
    minHolders: num(env, 'MIN_HOLDERS', 100),
    cloneMinVolMultiple: num(env, 'CLONE_MIN_VOL_MULTIPLE', 2),
    linkedDumpMaxDrain: num(env, 'LINKED_DUMP_MAX_DRAIN', 0.35),
    creatorMaxDrain: num(env, 'CREATOR_MAX_DRAIN', 0.25), // creator-dump gate cap (was hardcoded 0.25 in gate.js)
    creatorVolBypassUsd: num(env, 'CREATOR_VOL_BYPASS_USD', 25000), // creator veto becomes a warning when 5m volume >= this — real flow can absorb the stack (user 2026-10-14, Eikon: skipped at $53K on this gate with $39.1K/5m volume, then bought at $307K and lost). 0 = off (veto always fires).
    insiderCountMax: num(env, 'INSIDER_COUNT_MAX', 50),
    insiderMaxPct: num(env, 'INSIDER_MAX_PCT', 10), // linked-wallet supply cap in the insiders gate (loosened to 15 by env 2026-10-12: skipped coins averaged +16%)
    minQuoteLiqUsd: num(env, 'MIN_QUOTE_LIQ_USD', 1200),
    ladderMinN: num(env, 'LADDER_MIN_N', 15), ladderMaxRatio: num(env, 'LADDER_MAX_RATIO', 1.6),
    revivalDeadDrop: num(env, 'REVIVAL_DEAD_DROP', 50), revivalBounce: num(env, 'REVIVAL_BOUNCE', 50),
    revivalStrong: num(env, 'REVIVAL_STRONG', 80), revivalSellRatio: num(env, 'REVIVAL_SELL_RATIO', 1.25),
    bundleWatch: num(env, 'BUNDLE_WATCH', 1) === 1,
    bundleCheckSec: num(env, 'BUNDLE_CHECK_SEC', 8),
    bundleWindowSec: num(env, 'BUNDLE_WINDOW_SEC', 120),
    bundleDumpFrac: num(env, 'BUNDLE_DUMP_FRAC', 0.25),
    // farm-wallet tiers: balances within FARM_TOL_PCT of each other, in groups of >= FARM_MIN_CLUSTER
    farmTolPct: num(env, 'FARM_TOL_PCT', 0.005),
    farmMinCluster: num(env, 'FARM_MIN_CLUSTER', 3),
    farmMaxWallets: num(env, 'FARM_MAX_WALLETS', 8),
    farmMaxSupplyPct: num(env, 'FARM_MAX_SUPPLY_PCT', 10),
    // dust volume: >= DUST_MIN_TX trades in 1h averaging < DUST_MAX_AVG_USD. Set DUST_MAX_AVG_USD=0 to disable.
    dustMinTx: num(env, 'DUST_MIN_TX', 300),
    dustMaxAvgUsd: num(env, 'DUST_MAX_AVG_USD', 1.5),
    // instant graduation: bonding curve filled in <= N buys = bought out at launch (0 = off)
    instantGradMaxBuys: num(env, 'INSTANT_GRAD_MAX_BUYS', 3),
    // bot flow: coin younger than BOTFLOW_MAX_AGE_H with >= BOTFLOW_MIN_TX trades in 1h averaging < BOTFLOW_MAX_AVG_USD (0 = off)
    botflowMaxAgeH: num(env, 'BOTFLOW_MAX_AGE_H', 2),
    botflowMinTx: num(env, 'BOTFLOW_MIN_TX', 1000),
    botflowMaxAvgUsd: num(env, 'BOTFLOW_MAX_AVG_USD', 6),
    // setup blacklist: 0 = off (per-token blocking only). Set to N to block setups with N+ bad marks.
    setupBlacklistMin: num(env, 'SETUP_BLACKLIST_MIN', 0),
    // name block: any coin whose NAME contains one of these words (whole-word, case-insensitive) is
    // hard-skipped before gates — user 2026-10-13 after CI ("Crypto Inu", -39%) and SCI ("Super
    // Crypto Inu", -23%) died back-to-back inside two minutes. Empty NAME_BLOCK_WORDS = off.
    nameBlockWords: (env.NAME_BLOCK_WORDS ?? 'inu').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // stale-pop veto: skip a pop when the bot's own sampled high for the mint is POP_STALE_SEC+ old
    // and price has rolled POP_STALE_DROP_PCT+ off it (second-hump rollover — user 2026-10-13, SCI).
    // POP_STALE_SEC=0 disables.
    popStaleSec: num(env, 'POP_STALE_SEC', 60),
    popStaleDropPct: num(env, 'POP_STALE_DROP_PCT', 0.08),
    // extension cap: skip classic entries priced more than this fraction above the trailing-1h
    // sampled low (the breakout base) — user 2026-10-13 (OTTO). 0 = off.
    extMaxFromBase: num(env, 'EXT_MAX_FROM_BASE', 1.5),
    // fresh-history fail-closed (user 2026-10-13, entry-fixes A3): when a coin arrives from the
    // trending/movers lists with too little sampled history to judge, the anti-chase guards used
    // to wave it through. Now DexScreener's own aggregates decide: a >FRESH_MAX_CHG_M5 5-minute
    // move already printed = skip; and a small cap whose whole hourly move is one 5m candle
    // (chgM5 ≥ FRESH_M5_SHARE_H1 × chgH1) = skip. BORING: +41.6% m5 vs +13.8% h1 at $14.5k, no samples.
    freshMaxChgM5: num(env, 'FRESH_MAX_CHG_M5', 25),     // 0 = off
    freshSmallMc: num(env, 'FRESH_SMALL_MC', 30000),     // "small cap" line for the fresh check and the B3 wash reject
    freshM5ShareH1: num(env, 'FRESH_M5_SHARE_H1', 0.7),  // 0 = off

    // ---- exits (judged on REALIZABLE value = Jupiter sell quote, not screen price) ----
    stopLoss: num(env, 'STOP_LOSS', 0.15),                // grace-stop ARM line on realizable value (user 2026-10-13: 0.10 live via env)
    stopHardPct: num(env, 'STOP_HARD_PCT', 0.20),         // hard floor: sells at this drawdown, no grace/veto once confirmed
    stopHardConfirmChecks: num(env, 'STOP_HARD_CONFIRM_CHECKS', 2), // consecutive checks at/below the floor before it fires (1 = instant, pre-2026-10-13 behavior)
    stopHardConfirmSec: num(env, 'STOP_HARD_CONFIRM_SEC', 0), // seconds a hard-floor breach must PERSIST before it fires (user 2026-10-13: 3s — "be sure it's still there"); 0 = no time requirement, the check count alone decides
    stopGraceSec: num(env, 'STOP_GRACE_SEC', 5),          // seconds between arming and the flow-confirmed sell
    stopFlowVeto: num(env, 'STOP_FLOW_VETO', 1),          // 1 = buyers absorbing the dip vetoes a confirmed stop (0 = off)
    stopXcheck: num(env, 'STOP_XCHECK', 1),               // 1 = a full exit needs a corroborating instant re-quote (bad-print guard)
    stopXcheckPct: num(env, 'STOP_XCHECK_PCT', 0.20),     // re-quote may differ from the triggering mark by at most this fraction
    dipStopPct: num(env, 'DIP_STOP_PCT', 0.05),           // sell if PRICE drops this far below entry (0 = off)
    stallSec: num(env, 'STALL_SEC', 60),                  // entry stall: sell if price never breaks out within this many seconds of entry (0 = off)
    stallBandPct: num(env, 'STALL_BAND_PCT', 0.05),       // entry range half-width: at stallSec the price must be OUTSIDE entry ± this or the position sells (user 2026-10-13 endpoint version)
    stallBandUpPct: num(env, 'STALL_BAND_UP_PCT', 0.03),  // stall dead-zone UPPER edge only — tighter than the downside: at stallSec, up more than +3% is working, not stalled; the lower edge stays stallBandPct (user 2026-10-14: UNTXED stalled out at +2.2% and then ripped)
    tp1Pct: num(env, 'TP1_PCT', 0.25),                    // bank part on the jump: +25% in your pocket after slippage + SOL fees
    tp1Frac: num(env, 'TP1_FRAC', 0.65),                  // ...sell 65% of it
    // TP ladder (user 2026-10-13): TP1 is adaptive — it ARMS at tp1Pct and the bank target slides up
    // to tp1AdaptMax while the run still looks strong (price near its high + flow supportive, judged
    // on the position's own recorded marks). Fires early on a tp1Giveback rollover from the peak or
    // when strength fades. TP2 banks tp2Frac OF THE ORIGINAL position at tp2Pct; the post-TP2
    // moonbag trails bagTrailPct below peak with no floor/lock.
    tp1AdaptMax: num(env, 'TP1_ADAPT_MAX_PCT', 0.60),     // adaptive TP1 ceiling (net gain)
    tp1Giveback: num(env, 'TP1_GIVEBACK_PCT', 0.08),      // give-back from peak (gain points) that banks TP1 once armed
    tp1FlowMin: num(env, 'TP1_FLOW_MIN_SHARE', 0.50),     // min buy share of 5m flow for the run to count as supported
    tp2Pct: num(env, 'TP2_PCT', 1.00),                    // second bank at +100% net
    tp2Frac: num(env, 'TP2_FRAC', 0.35),                  // ...sells this fraction of the ORIGINAL position (0 = off)
    bagTrailPct: num(env, 'BAG_TRAIL_PCT', 0.15),         // moonbag trail below peak (was 0.35 from the MFE study; user tightened 35→20→15% on 2026-10-13 — exit at -15% under the last recorded peak)
    tpTrailPct: num(env, 'TP_TRAIL_PCT', 0.25),           // after TP1, trail the rest this far below its peak (hard floor at entry)
    tp2RejectZone: num(env, 'TP2_REJECT_ZONE', 0.80),     // middle stage: peak net gain at/above this = it reached for the TP2 mark (user 2026-10-13)
    tp2RejectDrop: num(env, 'TP2_REJECT_DROP', 0.10),     // ...and this far off that peak without converting = rejected → sell the remainder (zone 0 = off)
    lockArm: num(env, 'PROFIT_LOCK_ARM', 0.15),           // once up +15% or more after fees...
    lockKeep: num(env, 'PROFIT_LOCK_KEEP', 0.5),          // ...sell the rest if it falls below half of its best gain (0 = off)
    trailArm: num(env, 'TRAIL_ARM', 1.00),
    trailPct: num(env, 'TRAIL_PCT', 0.25),
    timeStopMin: num(env, 'TIME_STOP_MIN', 25),
    timeStopMinGain: num(env, 'TIME_STOP_MIN_GAIN', 0.10),
    maxHoldMin: num(env, 'MAX_HOLD_MIN', 120),
    momentumFailSellRatio: num(env, 'MOMENTUM_FAIL_SELL_RATIO', 1.8),

    // ---- loops ----
    discoverEverySec: num(env, 'DISCOVER_EVERY_SEC', 20),
    pollEverySec: num(env, 'POLL_EVERY_SEC', 10),
    positionEverySec: num(env, 'POSITION_EVERY_SEC', 4),
    watchMax: num(env, 'WATCH_MAX', 400),
    watchTtlMin: num(env, 'WATCH_TTL_MIN', 20),
    signalCooldownMin: num(env, 'SIGNAL_COOLDOWN_MIN', 10),
    maxSignalsPerTick: num(env, 'MAX_SIGNALS_PER_TICK', 3),

    // ---- live feed (PumpPortal websocket: new launches in seconds) ----
    liveFeed: env.LIVE_FEED !== '0',
    liveFeedUrl: env.PUMPPORTAL_WS_URL || 'wss://pumpportal.fun/api/data',
    pumpportalApiKey: env.PUMPPORTAL_API_KEY || '',   // unlocks PumpPortal trade streaming (subscribeTokenTrade is key-gated: the linked wallet must hold >= 0.02 SOL). Appended as ?api-key= at connect; never logged.

    dataDir: env.DATA_DIR || './data',
    port: num(env, 'PORT', 3000),
  };
  cfg.txFeeSol = (5000 + cfg.priorityFeeLamports) / 1e9; // SOL network cost of one swap transaction
  return cfg;
}

export function validateConfig(cfg) {
  const errs = [];
  if (cfg.tradeSol <= 0) errs.push('TRADE_SOL must be > 0');
  if (cfg.tradeSol > 0.25 && !cfg.allowLarge) errs.push(`TRADE_SOL=${cfg.tradeSol} looks like a typo (>0.25). Set ALLOW_LARGE=1 if intentional.`);
  if (cfg.maxPositions < 1 || cfg.maxPositions > 10) errs.push('MAX_POSITIONS must be 1..10');
  if (cfg.dailyLossSol < 0) errs.push('DAILY_LOSS_SOL must be >= 0 (0 = disabled)');
  if (cfg.haltAfterCloses < 0) errs.push('HALT_AFTER_CLOSES must be >= 0');
  if (cfg.haltDownSol < 0) errs.push('HALT_DOWN_SOL must be >= 0');
  if (cfg.killEquityFrac <= 0 || cfg.killEquityFrac >= 1) errs.push('KILL_EQUITY_FRAC must be between 0 and 1');
  if (cfg.fastPopWindowSec < 10 || cfg.fastPopWindowSec > 600) errs.push('FAST_POP_WINDOW_SEC must be 10..600');
  if (cfg.fastPopGainPct < 1 || cfg.fastPopGainPct > 1000) errs.push('FAST_POP_GAIN_PCT must be 1..1000');
  if (cfg.fastPopMinBuyShare < 0 || cfg.fastPopMinBuyShare > 1) errs.push('FAST_POP_MIN_BUY_SHARE must be between 0 and 1');
  if (cfg.fastPopMaxDrop < 0 || cfg.fastPopMaxDrop > 0.9) errs.push('FAST_POP_MAX_DROP must be 0..0.9');
  if (cfg.fastPopMaxSubs < 1 || cfg.fastPopMaxSubs > 1000) errs.push('FAST_POP_MAX_SUBS must be 1..1000');
  if (cfg.stopLoss <= 0 || cfg.stopLoss >= 1) errs.push('STOP_LOSS must be between 0 and 1');
  if (cfg.stopHardPct <= 0 || cfg.stopHardPct >= 1) errs.push('STOP_HARD_PCT must be between 0 and 1');
  if (cfg.stopHardConfirmChecks < 1 || cfg.stopHardConfirmChecks > 10) errs.push('STOP_HARD_CONFIRM_CHECKS must be between 1 and 10');
  if (cfg.stopHardConfirmSec < 0 || cfg.stopHardConfirmSec > 60) errs.push('STOP_HARD_CONFIRM_SEC must be between 0 and 60');
  if (cfg.stopGraceSec < 0 || cfg.stopGraceSec > 120) errs.push('STOP_GRACE_SEC must be between 0 and 120');
  if (cfg.stopXcheckPct < 0.05 || cfg.stopXcheckPct > 0.9) errs.push('STOP_XCHECK_PCT must be between 0.05 and 0.9');
  if (cfg.popStaleSec < 0 || cfg.popStaleSec > 600) errs.push('POP_STALE_SEC must be between 0 and 600 (0 = off)');
  if (cfg.popStaleDropPct < 0 || cfg.popStaleDropPct >= 0.9) errs.push('POP_STALE_DROP_PCT must be between 0 and 0.9');
  if (cfg.extMaxFromBase < 0 || cfg.extMaxFromBase > 20) errs.push('EXT_MAX_FROM_BASE must be between 0 and 20 (0 = off)');
  if (cfg.paceRelax < 0 || cfg.paceRelax > 1) errs.push('PACE_RELAX must be 0 or 1');
  if (cfg.fastPopMaxGainPct < 0 || cfg.fastPopMaxGainPct > 5000) errs.push('FAST_POP_MAX_GAIN_PCT must be between 0 and 5000 (0 = off)');
  if (cfg.trendEnabled < 0 || cfg.trendEnabled > 1) errs.push('TREND_ENABLED must be 0 or 1');
  if (cfg.trendMinMc < 0) errs.push('TREND_MIN_MC must be >= 0 (0 = off)');
  if (cfg.trendMinBuyRatioH1 < 0 || cfg.trendMinBuyRatioH1 > 1) errs.push('TREND_MIN_BUY_RATIO_H1 must be between 0 and 1 (0 = off)');
  if (cfg.trendMinTxnsM5 < 0) errs.push('TREND_MIN_TXNS_M5 must be >= 0 (0 = off)');
  if (cfg.trendMaxVolToMc < 0) errs.push('TREND_MAX_VOL_TO_MC must be >= 0 (0 = off)');
  if (cfg.trendFreshMinVolM5 < 0) errs.push('TREND_FRESH_MIN_VOL_M5 must be >= 0 (0 = off)');
  if (cfg.revivalMinAgeD < 0) errs.push('REVIVAL_MIN_AGE_D must be >= 0 (0 = off)');
  if (cfg.revivalMaxChgH6 < 0) errs.push('REVIVAL_MAX_CHG_H6 must be >= 0');
  if (cfg.freshMaxChgM5 < 0) errs.push('FRESH_MAX_CHG_M5 must be >= 0 (0 = off)');
  if (cfg.freshSmallMc < 0) errs.push('FRESH_SMALL_MC must be >= 0');
  if (cfg.freshM5ShareH1 < 0 || cfg.freshM5ShareH1 > 1) errs.push('FRESH_M5_SHARE_H1 must be between 0 and 1 (0 = off)');
  if (cfg.maxBuyRatioM5 < 0 || cfg.maxBuyRatioM5 > 1) errs.push('MAX_BUY_RATIO_M5 must be between 0 and 1 (0 = off)');
  if (cfg.churnMinDropPct < 0 || cfg.churnMinDropPct > 100) errs.push('CHURN_MIN_DROP_PCT must be between 0 and 100');
  if (cfg.churnLowBandPct < 0 || cfg.churnLowBandPct > 100) errs.push('CHURN_LOW_BAND_PCT must be between 0 and 100');
  if (cfg.churnStableMin < 0 || cfg.churnStableMin > 240) errs.push('CHURN_STABLE_MIN must be between 0 and 240');
  if (cfg.churnMinTxM5 < 0) errs.push('CHURN_MIN_TX_M5 must be >= 0');
  if (cfg.churnMinBuyShare < 0 || cfg.churnMinBuyShare > 1) errs.push('CHURN_MIN_BUY_SHARE must be between 0 and 1');
  if (cfg.churnMinAvgUsd < 0) errs.push('CHURN_MIN_AVG_USD must be >= 0');
  if (cfg.churnWatchH < 0 || cfg.churnWatchH > 72) errs.push('CHURN_WATCH_H must be between 0 and 72');
  if (cfg.churnWatchMax < 0 || cfg.churnWatchMax > 500) errs.push('CHURN_WATCH_MAX must be between 0 and 500');
  if (cfg.flowPollSec < 5 || cfg.flowPollSec > 600) errs.push('FLOW_POLL_SEC must be between 5 and 600');
  if (cfg.flowMinSol < 0) errs.push('FLOW_MIN_SOL must be >= 0');
  if (cfg.flowWalletsConfl < 1 || cfg.flowWalletsConfl > 20) errs.push('FLOW_WALLETS_CONFL must be between 1 and 20');
  if (cfg.flowWindowMin < 1 || cfg.flowWindowMin > 240) errs.push('FLOW_WINDOW_MIN must be between 1 and 240');
  if (cfg.gradPollSec < 30 || cfg.gradPollSec > 3600) errs.push('GRAD_POLL_SEC must be between 30 and 3600');
  if (cfg.gradFreshMin < 1 || cfg.gradFreshMin > 1440) errs.push('GRAD_FRESH_MIN must be between 1 and 1440');
  if (cfg.gradBackfillMax < 0) errs.push('GRAD_BACKFILL_MAX must be >= 0 (0 = backfill off)');
  if (cfg.creatorVolBypassUsd < 0) errs.push('CREATOR_VOL_BYPASS_USD must be >= 0 (0 = off)');
  if (cfg.streakPauseN < 0 || cfg.streakPauseN > 50) errs.push('STREAK_PAUSE_N must be between 0 and 50 (0 = off)');
  if (cfg.streakPauseMinMin < 0 || cfg.streakPauseMinMin > 1440) errs.push('STREAK_PAUSE_MIN_MIN must be between 0 and 1440');
  if (cfg.streakHeatPct <= 0 || cfg.streakHeatPct > 1) errs.push('STREAK_HEAT_PCT must be between 0 and 1');
  if (cfg.streakHeatSustainMin < 0 || cfg.streakHeatSustainMin > 240) errs.push('STREAK_HEAT_SUSTAIN_MIN must be between 0 and 240');
  if (cfg.streakHeatMinCoins < 0 || cfg.streakHeatMinCoins > 10000) errs.push('STREAK_HEAT_MIN_COINS must be between 0 and 10000');
  if (cfg.fastPopMaxBuyShare < 0 || cfg.fastPopMaxBuyShare > 1) errs.push('FAST_POP_MAX_BUY_SHARE must be between 0 and 1 (0 = off)');
  if (cfg.dipStopPct < 0 || cfg.dipStopPct >= 1) errs.push('DIP_STOP_PCT must be between 0 and 1 (0 = off)');
  if (cfg.stallSec < 0) errs.push('STALL_SEC must be >= 0 (0 = off)');
  if (cfg.lockKeep < 0 || cfg.lockKeep >= 1) errs.push('PROFIT_LOCK_KEEP must be between 0 and 1 (0 = off)');
  if (cfg.tp1Frac < 0 || cfg.tp1Frac > 1) errs.push('TP1_FRAC must be between 0 and 1');
  if (cfg.tp1AdaptMax < cfg.tp1Pct || cfg.tp1AdaptMax > 3) errs.push('TP1_ADAPT_MAX_PCT must be >= TP1_PCT and <= 3');
  if (cfg.tp1Giveback < 0 || cfg.tp1Giveback > 0.5) errs.push('TP1_GIVEBACK_PCT must be between 0 and 0.5');
  if (cfg.tp1FlowMin < 0 || cfg.tp1FlowMin > 1) errs.push('TP1_FLOW_MIN_SHARE must be between 0 and 1');
  if (cfg.tp2Pct < 0 || cfg.tp2Pct > 5) errs.push('TP2_PCT must be between 0 and 5');
  if (cfg.tp2Frac < 0 || cfg.tp2Frac > 1) errs.push('TP2_FRAC must be between 0 and 1 (0 = off)');
  if (cfg.bagTrailPct < 0 || cfg.bagTrailPct >= 0.9) errs.push('BAG_TRAIL_PCT must be between 0 and 0.9');
  if (cfg.tpTrailPct < 0 || cfg.tpTrailPct >= 1) errs.push('TP_TRAIL_PCT must be between 0 and 1');
  if (cfg.tp2RejectZone < 0 || cfg.tp2RejectZone > 5) errs.push('TP2_REJECT_ZONE must be between 0 and 5');
  if (cfg.tp2RejectDrop < 0 || cfg.tp2RejectDrop >= 0.9) errs.push('TP2_REJECT_DROP must be between 0 and 0.9');
  if (cfg.stallBandPct < -0.5 || cfg.stallBandPct > 1) errs.push('STALL_BAND_PCT must be between -0.5 and 1 (breakout bar above entry for the entry stall)');
  if (cfg.stallBandUpPct < 0 || cfg.stallBandUpPct > 1) errs.push('STALL_BAND_UP_PCT must be between 0 and 1 (upside edge of the entry-stall dead zone)');
  if (cfg.realMode && cfg.rpcUrls.length === 0) errs.push('RPC_URLS required in real mode');
  return errs;
}
