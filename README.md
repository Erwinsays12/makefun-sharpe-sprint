[![Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Erwinsays12/makefun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Erwinsays12/makefun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Clean Sharpe Sniper

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition on make.fun.

The bot trades paper money on a 6-hour pump.fun replay. Places go by hourly
Sharpe ratio, so the strategy is built for steady, controlled gains rather
than one lucky moonshot: it buys a fresh launch once, only when its opening
tape looks like a real launch — the creator put in at most 2.5 SOL, only two
other wallets have piled in yet, and real reserves are already past 2 SOL —
sizes every entry the same tiny 0.015 SOL, and exits on a wide +20%
take-profit, a −25% stop-loss, or a 60-slot clock. Losers are cut small,
runners are given room, and the small stake recycles across many coins.

## How it works

- **Entry (once per coin, within 4 slots of creation):** creator buys ≤ 2.5
  SOL, creator has not sold, at most 2 distinct non-creator buyers so far,
  price run-up 0–1000% from creation, real SOL reserves between 2 and 30
  SOL, and the 1%-of-reserve size cap allowing at least the 0.01 SOL
  minimum round trip.
- **Exit (whole position):** take profit +20%, stop loss −25%, or 60 slots
  held.
- **Limits:** at most 5 open positions, one entry per coin, fully
  deterministic (no clock, no network, no randomness).

## Local check

On the kit's dev window (via the kit's own replay simulator) this bot loses
a little — −0.067 SOL over 24 hours, 111 round trips, 1.0% max drawdown —
the honest result on a window where every long-only approach loses; the
edge is the tight selectivity, not a fitted profit.

## Run

The grader runs `node main.ts` (Node 22). `vendor/makefun-bot.ts` is the
kit's bot shim, vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
