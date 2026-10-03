// Read-only Polymarket access: market discovery (Gamma API) and live order books (CLOB API).
// Nothing here can place an order. Fills are simulated against the real book.

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

async function getJson(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function normalizeMarket(m) {
  const outcomes = parse(m.outcomes) ?? [];
  const prices = (parse(m.outcomePrices) ?? []).map(Number);
  const tokens = parse(m.clobTokenIds) ?? [];
  const bid0 = m.bestBid == null ? null : Number(m.bestBid);
  const ask0 = m.bestAsk == null ? null : Number(m.bestAsk);
  const event = m.events?.[0];
  const settled = prices.length === 2 && prices.every((p) => p === 0 || p === 1);
  return {
    id: String(m.id),
    question: m.question,
    slug: m.slug,
    eventSlug: event?.slug ?? null,
    endDate: m.endDate,
    outcomes,
    prices,
    tokens,
    // Binary books mirror each other: buying outcome 1 at x is selling outcome 0 at 1 - x.
    asks: [ask0, bid0 == null ? null : round(1 - bid0)],
    bids: [bid0, ask0 == null ? null : round(1 - ask0)],
    volume24h: Number(m.volume24hr ?? 0),
    liquidity: Number(m.liquidityNum ?? 0),
    feeRate: Number(m.feeSchedule?.rate ?? 0),
    minShares: Number(m.orderMinSize ?? 5),
    acceptingOrders: m.acceptingOrders !== false,
    orderBook: m.enableOrderBook !== false,
    closed: Boolean(m.closed),
    resolved: Boolean(m.closed) && (m.umaResolutionStatus === "resolved" || settled),
  };
}

export async function getMarket(id) {
  return normalizeMarket(await getJson(`${GAMMA}/markets/${id}`));
}

// Open binary markets that resolve inside the experiment window, busiest first.
export async function fetchCandidates({ minHours = 3, maxDays = 7, limit = 60 } = {}) {
  const now = Date.now();
  const min = new Date(now + minHours * 3600e3).toISOString();
  const max = new Date(now + maxDays * 86400e3).toISOString();
  const raw = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await getJson(
      `${GAMMA}/markets?active=true&closed=false&limit=100&offset=${offset}` +
        `&order=volume24hr&ascending=false&end_date_min=${min}&end_date_max=${max}`,
    );
    raw.push(...page);
    if (page.length < 100) break;
  }

  const perEvent = new Map();
  const out = [];
  for (const m of raw.map(normalizeMarket)) {
    if (!m.orderBook || !m.acceptingOrders) continue;
    if (m.outcomes.length !== 2 || m.tokens.length !== 2) continue;
    if (m.liquidity < 5000 || m.volume24h < 5000) continue;
    // Skip near-certain markets: nothing to learn from buying a 98 cent favourite.
    if (m.asks.some((a) => a == null || a < 0.04 || a > 0.96)) continue;
    const key = m.eventSlug ?? m.id;
    const seen = perEvent.get(key) ?? 0;
    if (seen >= 3) continue;
    perEvent.set(key, seen + 1);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

export async function getBook(tokenId) {
  const b = await getJson(`${CLOB}/book?token_id=${tokenId}`);
  const levels = (side) => (side ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) }));
  return {
    bids: levels(b.bids).sort((x, y) => y.price - x.price),
    asks: levels(b.asks).sort((x, y) => x.price - y.price),
    minShares: Number(b.min_order_size ?? 5),
  };
}

// Polymarket taker fee: shares x rate x p x (1 - p), charged in USDC.
export const takerFee = (shares, price, rate) => shares * rate * price * (1 - price);

// Spend `usd` (fees included) by lifting asks, exactly as a market buy would.
export function simulateBuy(book, usd, rate) {
  let remaining = usd;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  for (const { price, size } of book.asks) {
    const perShare = price + rate * price * (1 - price);
    const take = Math.min(size, remaining / perShare);
    if (take <= 0) break;
    shares += take;
    cost += take * price;
    fees += takerFee(take, price, rate);
    remaining -= take * perShare;
    if (remaining <= 1e-9) break;
  }
  return { shares: round(shares), cost: round(cost), fees: round(fees), avgPrice: shares ? round(cost / shares) : null };
}

// Sell `shares` into the bids.
export function simulateSell(book, shares, rate) {
  let left = shares;
  let gross = 0;
  let fees = 0;
  for (const { price, size } of book.bids) {
    const take = Math.min(size, left);
    if (take <= 0) break;
    gross += take * price;
    fees += takerFee(take, price, rate);
    left -= take;
    if (left <= 1e-9) break;
  }
  const sold = shares - left;
  return { sold: round(sold), proceeds: round(gross - fees), fees: round(fees), avgPrice: sold ? round(gross / sold) : null };
}
