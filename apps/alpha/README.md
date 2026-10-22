# Alpha (inside Rutherford)

Paper trading lab: crypto + stocks + Polymarket, a 4-bot arena where bots compete and learn from each other, a forecast scoreboard, and an AI market analyst. It runs inside Rutherford at `/alpha/`. Switch to it with the green **R** on the left rail.

- `server.cjs`: Alpha's routes (`createHandler` is mounted by Rutherford; `node apps/alpha/server.cjs` still runs it on its own)
- `lib/market.cjs` + `lib/stocks.cjs`: crypto (Coinbase) and stocks (Alpaca, or Yahoo fallback)
- `lib/polymarket.cjs`: Polymarket odds (read-only) and paper bets
- `lib/bots.cjs`: the Bot Arena: bot rules, the AI bot, stats, and learning (evolution)
- `lib/strategies.cjs`, `lib/paper.cjs`, `lib/store.cjs`: forecast signals + stats, portfolio math, storage

**Tuning the bots:** each rule bot's starting settings are in `GENOMES` at the top of `lib/bots.cjs`. Change them and restart the arena from Alpha Settings.
- `public/`: Alpha's own UI
- `tests/`: run with everything else via `npm test` in the Rutherford folder

Paper money everywhere except the **Real $** tab. `lib/live.cjs` is the only code that can place a real order. It is off by default, needs your Alpaca keys, enforces budget, per-trade, daily-loss and order-count limits, never sells holdings it didn't buy, and never resends an order whose reply was lost. Every rule has a test in `tests/live.test.cjs`.
`lib/picks.cjs` is Rutherford's Picks (web-researched odds + scored track record).
