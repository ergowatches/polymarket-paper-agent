// The AI trader: one Claude call per decision cycle, with live web search,
// ending in a structured submit_decisions tool call.

import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.AGENT_MODEL || "claude-opus-5";

// USD per million tokens, plus web search at $10 per 1,000.
const PRICING = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
};
const SEARCH_USD = 0.01;

const SYSTEM = `You are an autonomous trading agent in a one week paper money experiment on Polymarket.
Prices, order books and taker fees are real and live. The money is not. Every cycle your own API bill (tokens and web searches) is deducted from your bankroll, so you have to pay for yourself.

Each cycle (about every 6 hours) you receive your portfolio and a list of open binary markets that resolve within the experiment window, with live ask and bid for each outcome.

How to work:
1. Shortlist a few markets where public information could give you an edge (sports injuries and lineups, polls, official schedules, weather forecasts, scheduled data releases).
2. Use web_search to check current facts before betting. Searches cost money, so spend them where they change a decision.
3. Estimate the probability of the outcome yourself. Buy only when your probability beats the ask by at least 5 percentage points after the taker fee.
4. Size with fractional Kelly. Never put more than 6% of equity into a new position. Respect the minimum order shown. At most 8 open positions, and never buy the same outcome twice.
5. Sell an open position when new evidence says it is now priced above your estimate.
6. Holding is a valid decision. Most cycles should end with zero to three trades.

Finish every cycle by calling submit_decisions exactly once. Write the summary for a smart friend who does not trade: plain words, concrete facts, no hype.`;

const SUBMIT_TOOL = {
  name: "submit_decisions",
  description:
    "Submit this cycle's decisions. Call exactly once, after any research. An empty trades array means hold everything.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "trades"],
    properties: {
      summary: {
        type: "string",
        description: "Two to four sentences: what you looked at, what you did and why.",
      },
      trades: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "market_id", "outcome_index", "stake_usd", "my_probability", "reasoning"],
          properties: {
            action: { type: "string", enum: ["buy", "sell"] },
            market_id: { type: "string" },
            outcome_index: { type: "integer", enum: [0, 1] },
            stake_usd: {
              type: "number",
              description: "For buy: USDC to spend including fees. For sell: ignored, the whole position is sold.",
            },
            my_probability: { type: "number", description: "Your probability from 0 to 1 that this outcome wins." },
            reasoning: { type: "string", description: "One or two sentences naming the evidence." },
          },
        },
      },
    },
  },
};

const money = (n) => `$${n.toFixed(2)}`;
const cents = (p) => (p == null ? "n/a" : `${Math.round(p * 1000) / 10}c`);

function buildPrompt({ now, bot, equity, budgetLeft, candidates, recent }) {
  const held = bot.positions.length
    ? bot.positions
        .map(
          (p) =>
            `- market ${p.marketId} | ${p.question} | holding ${p.outcome} (index ${p.outcomeIndex}) | ` +
            `${p.shares} shares at avg ${cents(p.avgPrice)} | now ${cents(p.mark)} | resolves ${p.endDate}`,
        )
        .join("\n")
    : "(none)";

  const rows = candidates
    .map(
      (m) =>
        `${m.id} | ${m.question} | [0] ${m.outcomes[0]} ask ${cents(m.asks[0])} bid ${cents(m.bids[0])} | ` +
        `[1] ${m.outcomes[1]} ask ${cents(m.asks[1])} bid ${cents(m.bids[1])} | ends ${m.endDate} | ` +
        `vol24h $${Math.round(m.volume24h)} | fee rate ${m.feeRate} | min ${m.minShares} shares`,
    )
    .join("\n");

  const memory = recent.length
    ? recent.map((d) => `- ${d.at}: ${d.summary}`).join("\n")
    : "(first cycle)";

  return `Time now: ${now}
Equity: ${money(equity)} (cash ${money(bot.cash)}). Started with $50.00. API bill paid so far: ${money(bot.bill.usd)}.
Remaining API budget for the whole experiment: ${money(budgetLeft)}.

Open positions:
${held}

Your last cycles:
${memory}

Markets you may buy (id | question | outcomes with live ask and bid | end | volume | fee | minimum):
${rows}`;
}

function costOf(usage, model) {
  const p = PRICING[model] ?? PRICING["claude-opus-5"];
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return {
    usd: (input * p.input + (usage.output_tokens ?? 0) * p.output) / 1e6 + searches * SEARCH_USD,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    searches,
  };
}

export async function decide(ctx) {
  const messages = [{ role: "user", content: buildPrompt(ctx) }];
  const params = {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }, SUBMIT_TOOL],
  };

  const bill = { usd: 0, inputTokens: 0, outputTokens: 0, searches: 0 };
  const queries = [];
  let nudged = false;

  for (let turn = 0; turn < 6; turn++) {
    const res = await create({ ...params, messages });
    const c = costOf(res.usage, res.model ?? MODEL);
    for (const k of Object.keys(bill)) bill[k] += c[k];

    for (const b of res.content) {
      if (b.type === "server_tool_use" && b.name === "web_search" && b.input?.query) queries.push(b.input.query);
    }

    if (res.stop_reason === "refusal") {
      return { summary: "The model declined this cycle, so nothing was traded.", trades: [], queries, bill };
    }
    const submit = res.content.find((b) => b.type === "tool_use" && b.name === "submit_decisions");
    if (submit) return { ...submit.input, queries, bill, model: res.model ?? MODEL };

    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue;
    if (res.stop_reason === "end_turn" && !nudged) {
      nudged = true;
      messages.push({ role: "user", content: "Call submit_decisions now with your final decisions." });
      continue;
    }
    break;
  }
  return { summary: "The agent ran out of turns without submitting, so nothing was traded.", trades: [], queries, bill };
}

// Server side refusal fallback where the API supports it, plain request otherwise.
async function create(params) {
  const client = new Anthropic();
  try {
    return await client.beta.messages.create({
      ...params,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
      return client.messages.create(params);
    }
    throw err;
  }
}
