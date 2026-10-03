// One tick of the experiment. GitHub Actions runs this every 20 minutes and right after
// the AI pushes new orders:
//   1. re-price every open position and settle resolved markets
//   2. execute pending AI orders (docs/data/orders.json) against live order books,
//      and let the random baseline trade the same market list at the same moment
//   3. publish the market list the AI reads next time, an equity snapshot, and state
//
// The AI itself is a scheduled Claude Code routine (see ROUTINE.md). It never touches
// Polymarket: it reads candidates.json and state.json, researches, and writes orders.json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fetchCandidates, getBook, getMarket, simulateBuy, simulateSell } from "./polymarket.mjs";

const DATA_DIR = new URL("../docs/data/", import.meta.url);
const START_USD = 50;
const DECIDE_EVERY_HOURS = 6;
const DURATION_DAYS = 7;
const MAX_POSITION_PCT = 0.06;
const MIN_ORDER_CEILING_PCT = 0.1; // a 5 share minimum may exceed 6% on pricier contracts
const MAX_OPEN = 8;

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 1e4) / 1e4;

const newBot = (name) => ({ name, cash: START_USD, positions: [], closed: [], searches: 0, cycles: 0 });

async function load(file, fallback) {
  try {
    return JSON.parse(await readFile(new URL(file, DATA_DIR), "utf8"));
  } catch {
    return fallback;
  }
}
const save = (file, data, pretty = true) =>
  writeFile(new URL(file, DATA_DIR), pretty ? JSON.stringify(data, null, 1) + "\n" : JSON.stringify(data));

const equityOf = (bot) => bot.cash + bot.positions.reduce((s, p) => s + p.shares * p.mark, 0);

// Next routine fire: the routine runs at 00, 06, 12 and 18 UTC.
function nextSlot(now) {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(Math.floor(d.getUTCHours() / DECIDE_EVERY_HOURS) * DECIDE_EVERY_HOURS + DECIDE_EVERY_HOURS);
  return d.toISOString();
}

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
      bot.cash = r4(bot.cash + payout);
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

async function buy(bot, market, outcomeIndex, requestedUsd, maxPrice, extra) {
  const equity = equityOf(bot);
  if (bot.positions.length >= MAX_OPEN) return { ok: false, why: "already at 8 open positions" };
  if (bot.positions.some((p) => p.marketId === market.id && p.outcomeIndex === outcomeIndex)) {
    return { ok: false, why: "already holds this outcome" };
  }
  const book = await getBook(market.tokens[outcomeIndex]);
  const ask = book.asks[0]?.price;
  if (!ask) return { ok: false, why: "no sellers in the book" };
  if (ask > maxPrice) return { ok: false, why: `price moved to ${Math.round(ask * 100)}¢, above its limit of ${Math.round(maxPrice * 100)}¢` };

  const minShares = Math.max(book.minShares, market.minShares);
  const minUsd = minShares * (ask + market.feeRate * ask * (1 - ask)) * 1.01;
  let stake = Math.min(requestedUsd, equity * MAX_POSITION_PCT, bot.cash);
  if (stake < minUsd) {
    if (minUsd <= equity * MIN_ORDER_CEILING_PCT && minUsd <= bot.cash) stake = minUsd;
    else return { ok: false, why: `minimum order (${minShares} shares, $${minUsd.toFixed(2)}) is too big for the bankroll` };
  }

  const fill = simulateBuy(book, stake, market.feeRate, maxPrice);
  if (fill.shares < minShares) return { ok: false, why: "not enough liquidity under its limit price" };
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

async function sell(bot, marketId, outcomeIndex, reasoning) {
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
    exitReasoning: reasoning,
  });
  return { ok: true, fill };
}

async function executeOrders(state, orders, log) {
  const bot = state.bots.ai;
  const endsAt = new Date(state.endsAt).getTime();
  const results = [];
  for (const t of orders.trades ?? []) {
    const base = { ...t };
    try {
      if (t.action === "buy") {
        const m = await getMarket(t.market_id);
        base.question = m.question;
        base.outcome = m.outcomes[t.outcome_index];
        if (!m.acceptingOrders || m.closed) {
          results.push({ ...base, ok: false, why: "market is no longer taking orders" });
          continue;
        }
        if (new Date(m.endDate).getTime() > endsAt + 86400e3) {
          results.push({ ...base, ok: false, why: "market resolves after the experiment ends" });
          continue;
        }
        const res = await buy(bot, m, t.outcome_index, Number(t.stake_usd) || 0, Number(t.max_price) || 1, {
          myProbability: t.my_probability,
          reasoning: t.reasoning,
        });
        results.push({
          ...base,
          ok: res.ok,
          why: res.why,
          filled: res.position && { shares: res.position.shares, avgPrice: res.position.avgPrice, usd: r2(res.position.cost + res.position.fees) },
        });
      } else if (t.action === "sell") {
        const held = bot.positions.find((p) => p.marketId === String(t.market_id) && p.outcomeIndex === t.outcome_index);
        base.question = held?.question;
        base.outcome = held?.outcome;
        const res = await sell(bot, String(t.market_id), t.outcome_index, t.reasoning);
        results.push({ ...base, ok: res.ok, why: res.why });
      } else {
        results.push({ ...base, ok: false, why: `unknown action ${t.action}` });
      }
    } catch (err) {
      results.push({ ...base, ok: false, why: `execution error: ${err.message}` });
      log.push(`order failed: ${err.message}`);
    }
  }
  return results;
}

// Baseline: same market list, same sizing, same fees, picks at random.
async function monkeyCycle(state, candidates, log) {
  const bot = state.bots.monkey;
  const picks = [...candidates].sort(() => Math.random() - 0.5).slice(0, Math.floor(Math.random() * 3));
  for (const m of picks) {
    try {
      await buy(bot, m, Math.random() < 0.5 ? 0 : 1, equityOf(bot) * MAX_POSITION_PCT, 1, {});
    } catch (err) {
      log.push(`random trade failed: ${err.message}`);
    }
  }
  bot.cycles += 1;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const now = new Date();
  const state = (await load("state.json", null)) ?? {};
  if (!state.lastDecisionAt) {
    // Nothing has traded yet, so keep the books fresh until the first decision lands.
    Object.assign(state, {
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + DURATION_DAYS * 86400e3).toISOString(),
      startUsd: START_USD,
      decideEveryHours: DECIDE_EVERY_HOURS,
      bots: { ai: newBot("AI agent"), monkey: newBot("Random picks") },
      decisions: [],
    });
    delete state.budgetUsd;
    delete state.model;
  }
  const history = await load("history.json", []);
  const log = [];

  for (const bot of Object.values(state.bots)) await refreshPositions(bot, log);

  const live = now < new Date(state.endsAt);
  const msLeft = new Date(state.endsAt).getTime() - now.getTime();
  const candidates = live ? await fetchCandidates({ maxDays: Math.max(0.5, msLeft / 86400e3) }) : [];

  const orders = await load("orders.json", null);
  if (live && orders?.status === "pending" && orders.createdAt !== state.lastOrdersCreatedAt) {
    if (!state.lastDecisionAt) {
      // The week starts with the first real decision, not with the first deploy.
      state.startedAt = now.toISOString();
      state.endsAt = new Date(now.getTime() + DURATION_DAYS * 86400e3).toISOString();
      history.length = 0;
    }
    const trades = await executeOrders(state, orders, log);
    await monkeyCycle(state, candidates, log);
    const ai = state.bots.ai;
    ai.cycles += 1;
    ai.searches += (orders.queries ?? []).length;
    state.decisions = [
      {
        at: orders.createdAt,
        executedAt: now.toISOString(),
        model: orders.model ?? null,
        summary: orders.summary ?? "",
        queries: orders.queries ?? [],
        candidates: orders.candidatesSeen ?? null,
        trades,
      },
      ...state.decisions,
    ].slice(0, 60);
    state.lastDecisionAt = orders.createdAt;
    state.lastOrdersCreatedAt = orders.createdAt;
    state.model = orders.model ?? state.model;
    await save("orders.json", { ...orders, status: "done", processedAt: now.toISOString() });
  }

  history.push({ t: now.toISOString(), ai: r2(equityOf(state.bots.ai)), monkey: r2(equityOf(state.bots.monkey)) });

  state.lastRunAt = now.toISOString();
  state.nextDecisionAt = nextSlot(now);
  state.live = live;
  state.log = log.slice(-20);

  // What the AI reads on its next run: compact, live, and limited to markets it may buy.
  await save("candidates.json", {
    updatedAt: now.toISOString(),
    experimentEndsAt: state.endsAt,
    note: "asks and bids are prices per share in dollars for each outcome. fee = shares x feeRate x p x (1 - p).",
    markets: candidates.map((m) => ({
      id: m.id,
      question: m.question,
      endDate: m.endDate,
      outcomes: m.outcomes.map((name, i) => ({ index: i, name, ask: m.asks[i], bid: m.bids[i] })),
      volume24h: Math.round(m.volume24h),
      feeRate: m.feeRate,
      minShares: m.minShares,
      url: m.eventSlug ? `https://polymarket.com/event/${m.eventSlug}` : null,
    })),
  });
  await save("state.json", state);
  await save("history.json", history, false);
  console.log(`AI $${equityOf(state.bots.ai).toFixed(2)} | random $${equityOf(state.bots.monkey).toFixed(2)} | ${log.length} warnings`);
  for (const line of log) console.log(line);
}

await main();
