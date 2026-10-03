// One tick of the experiment. GitHub Actions runs this every 20 minutes:
//   1. re-price every open position and settle resolved markets
//   2. every DECIDE_EVERY_HOURS, let the AI trade and let the random baseline trade
//   3. append an equity snapshot and write the JSON the dashboard reads

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fetchCandidates, getBook, getMarket, simulateBuy, simulateSell } from "./polymarket.mjs";
import { decide, MODEL } from "./agent.mjs";

const DATA_DIR = new URL("../docs/data/", import.meta.url);
const START_USD = 50;
const BUDGET_USD = Number(process.env.BUDGET_USD || 10);
const DECIDE_EVERY_HOURS = Number(process.env.DECIDE_EVERY_HOURS || 6);
const DURATION_DAYS = 7;
const MAX_POSITION_PCT = 0.06;
const MIN_ORDER_CEILING_PCT = 0.1; // a 5 share minimum may exceed 6% on pricier contracts
const MAX_OPEN = 8;

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 1e4) / 1e4;

const newBot = (name) => ({
  name,
  cash: START_USD,
  positions: [],
  closed: [],
  bill: { usd: 0, inputTokens: 0, outputTokens: 0, searches: 0, calls: 0 },
});

async function load(file, fallback) {
  try {
    return JSON.parse(await readFile(new URL(file, DATA_DIR), "utf8"));
  } catch {
    return fallback;
  }
}

const equityOf = (bot) => bot.cash + bot.positions.reduce((s, p) => s + p.shares * p.mark, 0);

async function refreshPositions(bot, log) {
  const still = [];
  for (const p of bot.positions) {
    let m;
    try {
      m = await getMarket(p.marketId);
    } catch (err) {
      log.push(`price refresh failed for ${p.marketId}: ${err.message}`);
      still.push(p);
      continue;
    }
    if (m.resolved) {
      const payout = r4(p.shares * m.prices[p.outcomeIndex]);
      bot.cash += payout;
      bot.closed.unshift({
        ...p,
        closedAt: new Date().toISOString(),
        exit: m.prices[p.outcomeIndex] === 1 ? "won" : "lost",
        proceeds: payout,
        pnl: r4(payout - p.cost - p.fees),
      });
      continue;
    }
    p.mark = m.prices[p.outcomeIndex] ?? p.mark;
    p.bid = m.bids[p.outcomeIndex];
    still.push(p);
  }
  bot.positions = still;
}

async function buy(bot, market, outcomeIndex, requestedUsd, extra) {
  const equity = equityOf(bot);
  if (bot.positions.length >= MAX_OPEN) return { ok: false, why: "already at 8 open positions" };
  if (bot.positions.some((p) => p.marketId === market.id && p.outcomeIndex === outcomeIndex)) {
    return { ok: false, why: "already holds this outcome" };
  }
  const book = await getBook(market.tokens[outcomeIndex]);
  const ask = book.asks[0]?.price;
  if (!ask) return { ok: false, why: "no sellers in the book" };

  const minShares = Math.max(book.minShares, market.minShares);
  const minUsd = minShares * (ask + market.feeRate * ask * (1 - ask)) * 1.01;
  let stake = Math.min(requestedUsd, equity * MAX_POSITION_PCT, bot.cash);
  if (stake < minUsd) {
    if (minUsd <= equity * MIN_ORDER_CEILING_PCT && minUsd <= bot.cash) stake = minUsd;
    else return { ok: false, why: `minimum order (${minShares} shares, $${minUsd.toFixed(2)}) is too big for the bankroll` };
  }

  const fill = simulateBuy(book, stake, market.feeRate);
  if (fill.shares < minShares) return { ok: false, why: "not enough liquidity for the minimum order" };
  bot.cash = r4(bot.cash - fill.cost - fill.fees);
  const position = {
    id: `${market.id}-${outcomeIndex}-${Date.now()}`,
    marketId: market.id,
    question: market.question,
    outcome: market.outcomes[outcomeIndex],
    outcomeIndex,
    slug: market.slug,
    eventSlug: market.eventSlug,
    endDate: market.endDate,
    openedAt: new Date().toISOString(),
    shares: fill.shares,
    avgPrice: fill.avgPrice,
    cost: fill.cost,
    fees: fill.fees,
    mark: fill.avgPrice,
    bid: book.bids[0]?.price ?? null,
    ...extra,
  };
  bot.positions.push(position);
  return { ok: true, position };
}

async function sell(bot, marketId, outcomeIndex, extra) {
  const p = bot.positions.find((x) => x.marketId === marketId && x.outcomeIndex === outcomeIndex);
  if (!p) return { ok: false, why: "no such open position" };
  const market = await getMarket(marketId);
  const book = await getBook(market.tokens[outcomeIndex]);
  const fill = simulateSell(book, p.shares, market.feeRate);
  if (fill.sold < p.shares) return { ok: false, why: "not enough buyers to exit the whole position" };
  bot.cash = r4(bot.cash + fill.proceeds);
  bot.positions = bot.positions.filter((x) => x !== p);
  bot.closed.unshift({
    ...p,
    closedAt: new Date().toISOString(),
    exit: "sold",
    exitPrice: fill.avgPrice,
    proceeds: fill.proceeds,
    pnl: r4(fill.proceeds - p.cost - p.fees),
    exitReasoning: extra.reasoning,
  });
  return { ok: true };
}

async function aiCycle(state, candidates, log) {
  const bot = state.bots.ai;
  const equity = equityOf(bot);
  const budgetLeft = BUDGET_USD - bot.bill.usd;
  const at = new Date().toISOString();

  if (!process.env.ANTHROPIC_API_KEY) {
    return { at, skipped: true, summary: "Waiting for an API key, so the AI is not trading yet.", trades: [] };
  }
  if (budgetLeft < 0.5) {
    return { at, skipped: true, summary: `API budget of $${BUDGET_USD} is used up. The agent is retired; open bets still settle.`, trades: [] };
  }
  if (equity < 1) {
    return { at, skipped: true, summary: "Bankroll is gone. The agent could not pay for itself.", trades: [] };
  }

  const recent = state.decisions.filter((d) => !d.skipped).slice(0, 3);
  const plan = await decide({ now: at, bot, equity, budgetLeft, candidates, recent });

  // Pay for yourself: the real API bill comes out of the paper bankroll.
  bot.cash = r4(bot.cash - plan.bill.usd);
  for (const k of ["usd", "inputTokens", "outputTokens", "searches"]) bot.bill[k] = r4(bot.bill[k] + plan.bill[k]);
  bot.bill.calls += 1;

  const byId = new Map(candidates.map((m) => [m.id, m]));
  const results = [];
  for (const t of plan.trades ?? []) {
    const base = { ...t, question: byId.get(t.market_id)?.question ?? bot.positions.find((p) => p.marketId === t.market_id)?.question };
    try {
      if (t.action === "buy") {
        const m = byId.get(t.market_id);
        if (!m) {
          results.push({ ...base, ok: false, why: "market was not in the allowed list" });
          continue;
        }
        const res = await buy(bot, m, t.outcome_index, t.stake_usd, {
          myProbability: t.my_probability,
          reasoning: t.reasoning,
        });
        results.push({
          ...base,
          outcome: m.outcomes[t.outcome_index],
          ok: res.ok,
          why: res.why,
          filled: res.position && { shares: res.position.shares, avgPrice: res.position.avgPrice, usd: r2(res.position.cost + res.position.fees) },
        });
      } else {
        const res = await sell(bot, t.market_id, t.outcome_index, { reasoning: t.reasoning });
        results.push({ ...base, ok: res.ok, why: res.why });
      }
    } catch (err) {
      results.push({ ...base, ok: false, why: `execution error: ${err.message}` });
      log.push(`trade failed: ${err.message}`);
    }
  }

  return {
    at,
    model: plan.model ?? MODEL,
    summary: plan.summary,
    trades: results,
    queries: plan.queries,
    costUsd: r4(plan.bill.usd),
  };
}

// Baseline: same market list, same sizing, same fees, picks at random.
async function monkeyCycle(state, candidates, log) {
  const bot = state.bots.monkey;
  const picks = [...candidates].sort(() => Math.random() - 0.5).slice(0, Math.floor(Math.random() * 3));
  for (const m of picks) {
    const idx = Math.random() < 0.5 ? 0 : 1;
    try {
      await buy(bot, m, idx, equityOf(bot) * MAX_POSITION_PCT, {});
    } catch (err) {
      log.push(`monkey trade failed: ${err.message}`);
    }
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const now = new Date();
  const state = await load("state.json", null) ?? {
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + DURATION_DAYS * 86400e3).toISOString(),
    startUsd: START_USD,
    budgetUsd: BUDGET_USD,
    decideEveryHours: DECIDE_EVERY_HOURS,
    model: MODEL,
    bots: { ai: newBot("AI agent"), monkey: newBot("Random picks") },
    decisions: [],
  };
  const history = await load("history.json", []);
  const log = [];

  for (const bot of Object.values(state.bots)) await refreshPositions(bot, log);

  const live = now < new Date(state.endsAt);
  const force = process.env.FORCE_DECIDE === "true";
  const last = state.lastDecisionAt ? new Date(state.lastDecisionAt).getTime() : 0;
  const due = force || now.getTime() - last >= DECIDE_EVERY_HOURS * 3600e3 - 15 * 60e3;

  if (live && due) {
    const msLeft = new Date(state.endsAt).getTime() - now.getTime();
    const candidates = await fetchCandidates({ maxDays: Math.max(0.5, msLeft / 86400e3) });
    let decision;
    try {
      decision = await aiCycle(state, candidates, log);
    } catch (err) {
      decision = { at: now.toISOString(), skipped: true, summary: `The AI call failed (${err.message}). It will retry next cycle.`, trades: [] };
      log.push(err.stack ?? String(err));
    }
    // Only start the clock once the AI actually ran, so a missing key does not waste a cycle.
    if (!decision.skipped || decision.summary.startsWith("API budget") || decision.summary.startsWith("Bankroll")) {
      if (!state.lastDecisionAt) {
        // The week starts with the first real decision, not with the first deploy.
        state.startedAt = now.toISOString();
        state.endsAt = new Date(now.getTime() + DURATION_DAYS * 86400e3).toISOString();
        history.length = 0;
      }
      state.lastDecisionAt = now.toISOString();
      await monkeyCycle(state, candidates, log);
    }
    decision.candidates = candidates.length;
    state.decisions = [decision, ...state.decisions.filter((d) => !(d.skipped && decision.skipped))].slice(0, 60);
  }

  const ai = equityOf(state.bots.ai);
  history.push({
    t: now.toISOString(),
    ai: r2(ai),
    aiGross: r2(ai + state.bots.ai.bill.usd),
    monkey: r2(equityOf(state.bots.monkey)),
  });

  state.lastRunAt = now.toISOString();
  state.nextDecisionAt = state.lastDecisionAt
    ? new Date(new Date(state.lastDecisionAt).getTime() + DECIDE_EVERY_HOURS * 3600e3).toISOString()
    : null;
  state.live = live;
  state.log = log.slice(-20);

  await writeFile(new URL("state.json", DATA_DIR), JSON.stringify(state, null, 1));
  await writeFile(new URL("history.json", DATA_DIR), JSON.stringify(history));
  console.log(`AI $${ai.toFixed(2)} | random $${equityOf(state.bots.monkey).toFixed(2)} | ${log.length} warnings`);
  for (const line of log) console.log(line);
}

await main();
