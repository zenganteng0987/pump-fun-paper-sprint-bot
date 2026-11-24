# pump-fun-paper-sprint-bot

[![competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zenganteng0987/pump-fun-paper-sprint-bot/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zenganteng0987/pump-fun-paper-sprint-bot/reward.svg)](https://make.fun)

Paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun)
competition on make.fun — a $2 winner-takes-all sprint, free entry, ranked by net
PnL on a 6-hour pump.fun replay window. Paper trading only: the replay uses market
data, never real funds.

## Strategy: sustained-demand sniper

On the kit's 24h dev window (1222 coins), a coin whose first 8 trades are all buys
keeps running — 43% of such coins end a trade in profit, against 29% for coins in
general — while a coin whose early tape already includes sells usually dumps.

So the bot watches every new coin from its `CreateEvent` and buys once, 0.05 SOL,
the moment its 8th straight buy prints (and only while every trade so far is a
buy, within 3000 slots of creation, and at least 5 SOL was bought across those 8
trades — the volume filter matters: thin streaks of dust buys usually dump, while
streaks with real size behind them keep running). One shot per coin, never
re-bought. Then it exits fast, whichever comes first:

- take-profit at +1.5% of realizable value over entry cost,
- stop-loss at −20%,
- trailing exit at 5% below the peak realizable gain (only while still in profit),
- or 100 slots (~40 seconds) after entry.

A position is judged by what selling it would actually pay — the constant-product
quote for its tokens against the reserves the bot really meets, minus curve fees —
not by the marginal spot price, which overstates value by the bot's own price
impact. Fills land 2 slots after the decision, and the bot's own flow shifts the
reserves it meets, so it rebuilds that shift from its own fills and sizes buys off
the shifted 1%-of-real-reserve size cap with a 5% safety margin.

## Layout

- `main.ts` — entrypoint: speaks `agent-fun/replay/v2` through the shim.
- `strategy.ts` — the strategy (`decideOrders`): entry signal, exits, sizing.
- `vendor/makefun-bot.ts` — the kit's SDK shim (line protocol, state, validation).

## Run

Node 22.18+ runs the TypeScript as-is; the grader runs `node main.ts`. The bot
reads one JSON line per batch on stdin (hello, batch, done) and writes exactly one
reply per batch on stdout. No network, no clock, no randomness, no environment —
every decision comes from the batch the harness delivers, so two runs produce
identical action logs.

## Dev results (kit's `grade-local`, process driver, dev window)

- Net PnL **+0.1169 SOL** (+1.17% on 10 SOL paper capital; 90% interval −0.31..+0.52 SOL)
- 407 fills over 177 coins, 177 round trips, win rate 58.8%, max drawdown 1.55%
- 0 rejected orders, 5 failed transactions (seeded 2% failure draw)
- Guardrails met: 177 coins with a round trip ≥ 0.01 SOL (bar: 20), drawdown well under 50%
- Two executions reproduced byte for byte (deterministic)
- Top 3 coins made 23% of the gains; without them net PnL is −0.15 SOL — as with
  every pump bot on a short window, a few coins carry the result

For comparison, the same strategy with a 10% take-profit scored −0.135 SOL on the
same window, with a 2% take-profit (the previous value) +0.1145 SOL, with a 1.2%
take-profit +0.1144 SOL, and with a 2% take-profit but no volume filter −0.029 SOL.

## License

MIT — see [LICENSE](LICENSE).
