# edgebot

A Solana memecoin runner bot built around the edges we found were missing from the old bot.
**It starts in SHADOW mode (live quotes, simulated fills, nothing signed) and only trades real money when you set
`REAL_MODE=1` *and* provide `WALLET_PRIVATE_KEY`.** Defaults are tiny: 0.02 SOL per trade, 3 positions, 0.06 SOL daily loss cap.

## What it does (and where)

| Edge | Module | How |
|---|---|---|
| Sees the coins you see | `sources.js` | Quota-based discovery: Jupiter volume-ranked trending/traded, pump.fun movers, PumpSwap by volume, boosts, new pools. Each source gets its own slice, so new launches can't crowd out runners. |
| Catches flat → vertical | `detect.js` | **pop**: +35% inside 5 min measured from the window low, still near the high, real buy flow, not already >3x. **trend**: already-ranked runner (multi-hour move + heavy volume) still green on 5m. Polled every 10s. |
| Rejects rigged launches | `gate.js` | Identical-balance wallet clusters, creator-dump simulation against the pool, linked-wallet networks, pool depth vs market cap, vertical-launch, concentration, open mint/freeze authority, LP not locked. Young coins with no RugCheck report are blocked. |
| Rejects copies | `gate.js` | A younger coin carrying the name/ticker of an older coin with ≥2x its volume or liquidity is blocked. |
| Sizes by exit value | `exec.js`, `risk.js` | Before every buy it prices the buy **and the immediate sell-back** via Jupiter; refuses if the sell-back is worth <80% of the spend. Position ≤1% of pool liquidity. Exits are judged on live sell quotes, not screen price. |
| Hard limits | `risk.js` | Max positions, per-trade size, hourly trade cap, per-coin cooldown, daily loss cap, fee reserve, kill switch (<50% of starting equity = permanent halt). State is persisted; restarting does not reset it. Create a file named `HALT` in `DATA_DIR` to stop new entries instantly. |
| Knows if it works | `journal.js` | Every signal — taken **and skipped** — is followed forward and its return recorded at +5/+15/+60 min. `/report` shows each detector's edge and whether each gate is saving or costing you. |

## Quick start

```bash
npm install
cp .env.example .env     # edit; never commit it
npm test                 # offline tests (53)
npm start                # SHADOW mode by default
curl localhost:3000/state ; curl localhost:3000/report
```

## Going live (recommended order)

1. **Create a brand-new throwaway wallet.** Fund it with only what you can afford to lose (e.g. 0.2–0.3 SOL). Never reuse your main wallet.
2. Use a paid RPC (Helius/QuickNode). Set `RPC_URLS`. The public endpoint is slow and rate-limited.
3. Set `WALLET_PRIVATE_KEY` in your host's **environment settings** (never in the repo, never in chat) and `REAL_MODE=1`.
4. Put `DATA_DIR` on a **persistent disk**, or positions/risk state/the journal are lost on every redeploy.
5. **Watch the first live trade by hand** (`/state`, Solscan). The signing/broadcast path could not be run in the build sandbox.
6. Let it run. Read `/report` after a day or two, then tune (below). Do not raise `TRADE_SOL` until the numbers justify it.

Optional but sensible: run in shadow for a few hours first (just leave `REAL_MODE` unset) to confirm all sources return data — `/state` → `stats.sourceCounts` shows how many each source returned.

## Reading `/report`

* `bySetup["pop/taken"]` vs `["pop/skipped"]`: if skipped coins do as well as taken ones, your gates aren't adding anything for that setup.
* `bySkipReason.clones` (etc.): strongly **negative** `avgR15` = that gate is saving you. Strongly **positive** = it is costing you winners; loosen it.
* `trades.byExitReason`: shows which exit rule makes or loses money.
* An `avgR15` that is positive but whose `avgMaxRet` is far higher means entries are fine and exits are leaving money (or vice versa).

## Tuning knobs (all env vars; defaults are starting guesses, not proven values)

Detectors: `POP_GAIN_PCT`, `POP_MAX_GAIN_PCT`, `MIN_BUY_RATIO_M5`, `MAX_DRAW_FROM_PEAK`, `TREND_MIN_H1`, `TREND_MIN_VOL_H1`
Eligibility: `MIN_MC`, `MAX_MC`, `MIN_LIQ_USD`, `MIN_LIQ_TO_MC`
Exits: `DIP_STOP_PCT` (0.05), `STALL_SEC` (60), `STALL_BAND_PCT` (0.02), `STOP_LOSS`, `TP1_PCT`, `TP1_FRAC`, `TRAIL_ARM`, `TRAIL_PCT`, `TIME_STOP_MIN`, `MAX_HOLD_MIN`
Execution: `BUY_SLIPPAGE_BPS`, `SELL_SLIPPAGE_BPS`, `PRIORITY_FEE_LAMPORTS`, `MIN_ROUND_TRIP`
Limits: `TRADE_SOL`, `MAX_POSITIONS`, `DAILY_LOSS_SOL`, `KILL_EQUITY_FRAC`, `MAX_TRADES_PER_HOUR`

## Known limits — read these

* **No guarantee of profit.** This removes avoidable losses and gives you measurement; whether what's left is profitable is an empirical question `/report` will answer.
* Not verified from the build sandbox (no outbound network there): the Jupiter token-list endpoint, GeckoTerminal's `sort` param, the live Jupiter swap/RPC path, and real signing. Each data source is fail-open and reported in `/state`; the swap path throws (= no trade) rather than guess. `JUP_BASE` defaults to the endpoint your old bot used; if it needs a key, set `JUP_API_KEY` or `JUP_BASE=https://lite-api.jup.ag/swap/v1`.
* Data comes from DexScreener polling (~10s). It will not win races against faster, mempool-level bots. It aims for runners that last minutes, not the first seconds of a launch.
* The clone gate also blocks a legitimately new coin that happens to reuse an older, bigger coin's ticker. That is a deliberate trade-off; `bySkipReason.clone` tells you what it costs.
* Realized P&L in real mode is estimated from sell quotes, not parsed from the transaction.
* Broadcast is plain RPC with a priority fee. For harder-to-land trades add Jito/Helius Sender later.
* Nothing here is financial advice. Memecoin trading loses money for most participants.
