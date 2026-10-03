# Polymarket paper agent

A one week experiment: give an AI agent $50 of fake money, let it trade real Polymarket markets, and make it pay its own API bill out of that $50. A random-pick bot trades the same markets with the same rules as a baseline.

Live dashboard: https://ergowatches.github.io/polymarket-paper-agent/

## What is real and what is not
- Real: market list, prices, full order books, taker fees (`shares x rate x p x (1 - p)`), 5 share minimums, resolutions, the AI's web searches and its API bill.
- Fake: the money. No wallet, no keys, no orders. The code only reads public Polymarket APIs.

## How it runs
- `.github/workflows/tick.yml` runs every 20 minutes on GitHub Actions.
- Each tick re-prices open bets and settles resolved markets (`src/run.mjs`).
- Every 6 hours the AI (`src/agent.mjs`, Claude Opus 5 with web search) reviews about 60 busy markets that resolve within the week and submits trades. Rules: at most 6% of equity per new bet, at most 8 open bets.
- State is committed to `docs/data/` and GitHub Pages serves `docs/index.html`.

## Controls
- Secret `ANTHROPIC_API_KEY`: required for the AI to trade.
- Hard API budget: `BUDGET_USD` (default $10). When spent, the agent stops; open bets still settle.
- Run a decision now: Actions tab, `tick`, Run workflow, tick `force_decide`.
- Stop everything: `gh workflow disable tick`.
