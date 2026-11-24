// Momentum bot: buy a newly created coin the first time its reserve price ticks up.
// It records every CreateEvent mint and acts at most once per coin, on the first upward tick.
import { LAMPORTS_PER_SOL, runBot, type BuyInput } from './vendor/makefun-bot.ts';

const candidates = new Set<string>();
const prevPrice = new Map<string, bigint>();
const bought = new Set<string>();

await runBot({
  onBatch(state, batch) {
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent' && ev.mint) candidates.add(ev.mint);
    }
    const caps = state.hello.caps;
    const orders: BuyInput[] = [];
    for (const mint of candidates) {
      if (bought.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete || curve.real_token_reserves <= 0n) continue;
      const price = curve.real_quote_reserves / curve.real_token_reserves;
      const prev = prevPrice.get(mint);
      prevPrice.set(mint, price);
      if (prev === undefined || price <= prev) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap * 200n < LAMPORTS_PER_SOL) continue;
      if (state.committedPositionCount() + orders.length >= caps.max_open_positions) continue;
      if (orders.length >= caps.max_orders_per_batch) continue;
      const quote = cap < LAMPORTS_PER_SOL / 20n ? cap : LAMPORTS_PER_SOL / 20n;
      const spent = orders.reduce((s, o) => s + o.quote_lamports, 0n);
      const fee = state.txFeeLamports() * BigInt(orders.length + 1);
      if (spent + quote + fee > state.freeCashLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: quote, max_slippage_bps: 10000 });
      bought.add(mint);
    }
    return orders;
  },
});
