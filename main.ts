// Momentum paper bot for the pump.fun replay harness.
//
// For every coin that comes from a real CreateEvent we wait until its real SOL reserve
// has enough depth, then buy it once at most, and only on a batch where the token's
// latest observed price has risen since the previous batch. Once bought we hold.
//
// Determinism: this file never reads the clock, the environment or Math.random. It only
// folds the values the shim already put on `state` (Map iteration is insertion-ordered,
// all comparisons are on bigints), so two runs of the same transcript produce identical
// replies. Diagnostics, if any, would go to stderr via console.error and never to stdout.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, BuyInput, Curve } from './vendor/makefun-bot.ts';

// A coin needs at least this much real SOL reserve before we consider entering it.
const MIN_REAL_SOL_DEPTH = LAMPORTS_PER_SOL / 10n;
// Fixed-point scale so the price ratio stays an exact bigint comparison.
const PRICE_SCALE = 1_000_000_000n;
// We send our own limit; 10000 bps means "accept the decision-time price or worse".
const MAX_SLIPPAGE_BPS = 10_000;

// Latest price of a curve, in scaled SOL per token; null until the curve has tokens.
function tokenPrice(curve: Curve): bigint | null {
  if (curve.virtual_token_reserves <= 0n) return null;
  return (curve.virtual_quote_reserves * PRICE_SCALE) / curve.virtual_token_reserves;
}

async function main(): Promise<void> {
  const bought = new Set<string>();
  const lastPrice = new Map<string, bigint>();

  await runBot({
    onBatch(state: BotState, _batch: Batch): BuyInput[] {
      const orders: BuyInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;
      const maxOpen = state.hello.caps.max_open_positions;
      const txFee = state.txFeeLamports();

      // Positions held plus buys still in flight; buys added below are net-new mints.
      let openNow = state.committedPositionCount();
      // Cash not already reserved by pending orders; new orders must fit in what remains.
      let budget = state.freeCashLamports();

      for (const [mint, curve] of state.curves) {
        const price = tokenPrice(curve);
        if (price === null) continue;

        const prior = lastPrice.get(mint);
        lastPrice.set(mint, price);

        if (bought.has(mint) || curve.complete || curve.created_slot === null) continue;
        if (prior === undefined || price <= prior) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL_DEPTH) continue;
        if (openNow >= maxOpen) break;

        // size = the mint's per-batch size cap, but never more than we can still afford,
        // counting this order's transaction fee.
        const cap = state.maxBuyLamports(mint);
        const affordable = budget - txFee;
        if (affordable <= 0n) break;
        const size = cap < affordable ? cap : affordable;
        if (size <= 0n) continue;

        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        bought.add(mint);
        openNow += 1;
        budget -= txFee + size;

        if (orders.length >= maxOrders) break;
      }

      return orders;
    },
  });
}

await main();
