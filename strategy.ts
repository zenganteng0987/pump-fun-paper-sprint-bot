// Strategy: sustained-demand sniper with fast take-profit / stop-loss / trailing exit.
//
// The signal, measured on the kit's 24h dev window (1222 coins): a coin whose first 8
// trades are all buys keeps running — 43% of such coins end a trade in profit, against
// 29% for coins in general — while a coin whose early tape already includes sells
// usually dumps. The streak alone is not enough: the 8 buys must also carry real
// size (at least 5 SOL bought across them). Thin streaks of dust buys usually dump;
// streaks with size behind them keep running, and on the local replay that filter
// lifts the win rate from ~56% to ~60% while keeping 174 coins in the window.
// So the bot waits until a coin has printed 8 straight buys with at least 5 SOL
// behind them, then buys it once (a single order: at the 8th trade the median coin
// already holds 9.5 SOL of real reserve, so the 1%-of-reserve size cap admits the
// whole 0.05 SOL stake), and exits fast: take-profit 1.5%, stop-loss 20%, trailing
// 5% off the peak realizable gain, or 100 slots (~40 seconds) after entry,
// whichever comes first. The small take-profit is deliberate: on the dev window the
// coins that run rarely run far, and a 10% target let most winners round-trip back
// to a loss. Measured on the same window, 1.5% beats 2% slightly (+0.1169 vs
// +0.1145 SOL) and 1.2% falls back to +0.1144 SOL, so 1.5% sits at the local peak.
// One shot per coin, never re-bought. Paper trading only.
//
// Two harness facts shape the code:
//  - A fill lands 2 slots after the decision, and the reserves a fill meets are the
//    recorded ones shifted by the bot's own net flow into that curve (its buys raise
//    the price it faces, its sells lower it). The bot rebuilds that shift from its own
//    fills (curve quote recovered from the paid/proceeds amounts) and sizes buys off
//    the shifted cap with a safety margin, so orders stop being rejected for size.
//  - A position is judged by what selling it would actually pay (the constant-product
//    quote for its tokens against the shifted reserves, minus curve fees), not by the
//    marginal spot price, which overstates value by the bot's own price impact.
//  - A sell only frees its position slot when its fill lands, so no second sell is
//    sent while one is pending, and a slot freed by a sell in this reply is only
//    reused by a buy in the same reply when the sell resolves first (sells are sent
//    first).
//
// Paper trading only: no real funds, no network, no clock, no randomness. All
// decisions come from the batch the harness delivers (events, marks, fills, account).

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export const PARAMS = {
  /** Target stake per coin, lamports (one single buy). */
  TARGET_LAMPORTS: 50_000_000n,
  /** Smallest single buy we bother sending, lamports. */
  MIN_BUY_LAMPORTS: 10_000_000n,
  /** How many straight buys from the first trade qualify a coin. */
  STREAK_TRADES: 8,
  /** Only consider a coin whose qualifying trade arrives this soon after creation. */
  MAX_AGE_SLOTS: 3000,
  /** Sell everything when the realizable value is this far above the entry cost. */
  TAKE_PROFIT: 0.015,
  /** Sell everything when the realizable value is this far below the entry cost. */
  STOP_LOSS: 0.2,
  /** Sell everything when the realizable value falls this far below its peak. 0 = off. */
  TRAILING_DRAWDOWN: 0.05,
  /** Sell everything after holding this many slots. */
  MAX_HOLD_SLOTS: 100,
  /** Fraction of the size cap actually used (the rest is a margin for offset error). */
  CAP_USE_BPS: 9500,
  /** Reject nothing for price movement between decision and fill. */
  MAX_SLIPPAGE_BPS: 10_000,
  /** Minimum SOL bought across the qualifying streak (lamports; 0 = off). */
  MIN_STREAK_SOL_LAMPORTS: 5_000_000_000n,
  /** Minimum distinct buyers across the qualifying streak (0 = off; tested, adds nothing). */
  MIN_STREAK_BUYERS: 0,
};

interface CoinTrack {
  createdSlot: number;
  /** Trades seen on this coin, in order. */
  trades: number;
  /** Buys among those trades. */
  buys: number;
  /** Peak realizable gain since entry (fraction of cost). */
  peakGain: number;
  firstBuySlot: number;
  /** Net quote (lamports) this bot has put into the curve minus what it took out. */
  netQuote: bigint;
  /** Net tokens this bot has taken out of the curve minus what it put back. */
  netTokens: bigint;
  /** Bought once already (filled or in flight): never buy again. */
  bought: boolean;
  /** A sell is in flight for this mint. */
  sellPending: boolean;
  /** SOL bought across the qualifying streak (lamports). */
  streakSol: bigint;
  /** Distinct buyers across the qualifying streak. */
  streakBuyers: Set<string>;
}

const tracks = new Map<string, CoinTrack>();

function trackOf(mint: string): CoinTrack | undefined {
  return tracks.get(mint);
}

/** Reserves the bot actually meets: recorded reserves shifted by its own net flow. */
function adjustedReserves(state: BotState, mint: string): { vq: bigint; vt: bigint; rq: bigint; rt: bigint } | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  const t = trackOf(mint);
  const nq = t?.netQuote ?? 0n;
  const nt = t?.netTokens ?? 0n;
  const vq = c.virtual_quote_reserves + nq;
  const vt = c.virtual_token_reserves - nt;
  const rq = c.real_quote_reserves + nq;
  const rt = c.real_token_reserves - nt;
  if (vq <= 0n || vt <= 0n || rq <= 0n || rt <= 0n) return null;
  return { vq, vt, rq, rt };
}

/**
 * What selling `tokens` would actually pay right now: the constant-product quote
 * against the shifted reserves, minus the 95 + 30 bps curve fees, minus the tx fee.
 * Exact for the reserves the bot meets; the fill 2 slots later may differ.
 */
function realizableLamports(state: BotState, mint: string, tokens: bigint): bigint | null {
  const r = adjustedReserves(state, mint);
  if (r === null || tokens <= 0n) return null;
  const q = (tokens * r.vq) / (r.vt + tokens);
  const fee = (q * 95n + 9_999n) / 10_000n;
  const creatorFee = (q * 30n + 9_999n) / 10_000n;
  const proceeds = q - fee - creatorFee - state.txFeeLamports();
  return proceeds;
}

/** Size cap on this mint now, from the shifted reserves, with the safety margin. */
function buyCapLamports(state: BotState, mint: string): bigint {
  const r = adjustedReserves(state, mint);
  if (r === null) return 0n;
  return (r.rq * BigInt(state.hello.caps.max_order_bps_of_real_reserve) * BigInt(PARAMS.CAP_USE_BPS)) / 10_000n / 10_000n;
}

/**
 * Recover the curve quote q of a fill from what was paid/received. A buy pays
 * q + ceil(q*95/10000) + ceil(q*30/10000); a sell receives q - the same fees.
 * Inverting with the fee rates (95 + 30 bps) is exact to within a lamport or two.
 */
function curveQuoteOfFill(fill: { side: string; quote_lamports: string }): bigint {
  const q = BigInt(fill.quote_lamports);
  if (fill.side === 'buy') return (q * 10_000n) / 10_125n;
  return (q * 10_000n) / 9_875n;
}

export function decideOrders(state: BotState, batch: Batch): OrderInput[] {
  const P = PARAMS;
  const orders: OrderInput[] = [];
  const tx = state.txFeeLamports();
  let free = state.freeCashLamports();
  let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

  // --- fold this batch's fills into the per-coin net flow --------------------
  for (const f of batch.fills) {
    if (f.status !== 'filled') {
      if (!f.client_id.startsWith('_')) {
        const t = trackOf(f.mint);
        if (t !== undefined && f.side === 'sell') t.sellPending = false;
      }
      continue;
    }
    const t = trackOf(f.mint);
    if (t === undefined) continue;
    if (f.client_id.startsWith('_')) {
      // A harness close (complete / flatten / write-off): the position is gone.
      t.netQuote -= curveQuoteOfFill({ side: 'sell', quote_lamports: f.quote_lamports });
      t.netTokens -= BigInt(f.token_amount);
      t.sellPending = false;
      continue;
    }
    if (f.side === 'buy') {
      t.netQuote += curveQuoteOfFill({ side: 'buy', quote_lamports: f.quote_lamports });
      t.netTokens += BigInt(f.token_amount);
      t.bought = true;
      if (t.firstBuySlot < 0) t.firstBuySlot = f.slot;
    } else {
      t.netQuote -= curveQuoteOfFill({ side: 'sell', quote_lamports: f.quote_lamports });
      t.netTokens -= BigInt(f.token_amount);
      t.sellPending = false;
    }
  }

  // --- fold this batch's events into per-coin tracks -----------------------
  // The entry decision is made in the same pass, in event order: a coin qualifies
  // the moment its 8th straight buy is seen.
  const entries = new Set<string>();
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (!tracks.has(e.mint)) {
        tracks.set(e.mint, { createdSlot: e.slot, trades: 0, buys: 0, peakGain: 0, firstBuySlot: -1, netQuote: 0n, netTokens: 0n, bought: false, sellPending: false, streakSol: 0n, streakBuyers: new Set() });
      }
    } else if (e.event === 'TradeEvent') {
      const t = tracks.get(e.mint);
      if (t === undefined) continue;
      t.trades += 1;
      if (e.is_buy) {
        t.buys += 1;
        if (t.trades <= P.STREAK_TRADES) {
          t.streakSol += BigInt(e.sol_amount);
          t.streakBuyers.add(e.user);
        }
      }
      // Qualifies while every trade so far is a buy, from the 8th trade on: a
      // rejected first attempt is retried on later batches while the streak holds.
      if (!t.bought && t.trades >= P.STREAK_TRADES && t.buys === t.trades
        && t.streakSol >= P.MIN_STREAK_SOL_LAMPORTS
        && t.streakBuyers.size >= P.MIN_STREAK_BUYERS) {
        entries.add(e.mint);
      }
    }
  }

  // --- exits first: selling frees position slots for new buys --------------
  for (const [mint, pos] of state.positions) {
    const track = tracks.get(mint);
    if (track?.sellPending) continue;
    if (pos.token_amount === 0n) continue;
    const value = realizableLamports(state, mint, pos.token_amount);
    if (value === null) continue;
    const cost = pos.cost_lamports;
    const gain = Number(value - cost) / Number(cost);
    if (track !== undefined) {
      if (track.firstBuySlot < 0) track.firstBuySlot = state.slot;
      if (gain > track.peakGain) track.peakGain = gain;
    }
    const peak = track !== undefined ? track.peakGain : gain;
    const fromPeak = gain - peak;
    const held = track !== undefined && track.firstBuySlot >= 0 ? state.slot - track.firstBuySlot : 0;
    const takeProfit = gain >= P.TAKE_PROFIT;
    const stopLoss = gain <= -P.STOP_LOSS;
    const trailing = P.TRAILING_DRAWDOWN > 0 && fromPeak <= -P.TRAILING_DRAWDOWN && gain > 0;
    const tooOld = held >= P.MAX_HOLD_SLOTS;
    if (takeProfit || stopLoss || trailing || tooOld) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.MAX_SLIPPAGE_BPS });
      if (track !== undefined) track.sellPending = true;
      slots += 1; // the slot frees once the sell fills; sells are sent first
    }
  }

  // --- entries: one single buy per qualifying coin --------------------------
  for (const mint of entries) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    const track = tracks.get(mint);
    if (track === undefined || track.bought) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (state.slot - track.createdSlot > P.MAX_AGE_SLOTS) continue;
    const isNew = !state.positions.has(mint)
      && ![...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'buy');
    if (isNew && slots <= 0) continue;
    const cap = buyCapLamports(state, mint);
    if (cap < P.MIN_BUY_LAMPORTS) continue;
    const amount = P.TARGET_LAMPORTS < cap ? P.TARGET_LAMPORTS : cap;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.MAX_SLIPPAGE_BPS });
    free -= amount + tx;
    if (isNew) slots -= 1;
  }

  return orders;
}

export function resetTracks(): void {
  tracks.clear();
}
