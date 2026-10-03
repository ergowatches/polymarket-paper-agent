# Polymarket paper agent

A one week experiment: give an AI agent $50 of fake money, let it trade real Polymarket markets, and make it pay its own API bill out of that $50. A random-pick bot trades the same markets with the same rules as a baseline.

Live dashboard: https://ergowatches.github.io/polymarket-paper-agent/

## What is real and what is not
- Real: market list, prices, full order books, taker fees (`shares x rate x p x (1 - p)`), 5 share minimums, resolutions, the AI's web research.
- Fake: the money. No wallet, no keys, no orders. The code only reads public Polymarket APIs.

## How it runs
- The AI is a scheduled Claude Code routine on Anthropic's cloud (every 6 hours, 26 minutes past 00/06/12/18 UTC), running on the owner's Claude plan, so there is no API key or API bill. Its prompt is in `ROUTINE.md`. It reads `docs/data/candidates.json` and `docs/data/state.json`, researches with web search, and pushes `docs/data/orders.json`.
- `.github/workflows/tick.yml` runs `src/run.mjs` every 20 minutes and right after each orders push. It re-prices open bets, settles resolved markets, fills pending orders against the live book at the AI's limit price, lets the random baseline trade the same list, and refreshes the market list.
- GitHub Pages serves `docs/index.html`.

## Rules
At most 6% of equity per new bet (a 5 share minimum may round a bet up to 10%), at most 8 open bets, only markets that resolve inside the week.

## Controls
- Pause the executor: `gh workflow disable tick`.
- Pause or edit the AI: https://claude.ai/code/routines
