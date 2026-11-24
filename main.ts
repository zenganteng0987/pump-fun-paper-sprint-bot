// main.ts — entrypoint for the Pump.fun Paper Sprint bot.
//
// The job of this file is only the wiring between the harness and the
// strategy. The harness speaks agent-fun/replay/v2 over stdin/stdout:
// it opens with one hello line, then one batch line per slot, then a
// done line at the end of the window. For every batch the bot must
// answer with exactly one reply line carrying that batch's orders.
//
// All of that line handling lives in the shim (vendor/makefun-bot.ts).
// This file just hands the shim a callback per batch: take the batch
// the harness just delivered, ask strategy.ts what to do with it, and
// return those orders. The strategy itself — the entry signal, the
// exits, the sizing — is all in strategy.ts.
//
// Paper trading only. Nothing here touches the network, the clock, or
// any randomness, so two runs of the same replay produce the same
// action log byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { decideOrders } from './strategy.ts';

// Hand the whole conversation to the shim. It keeps the bot state
// (account, positions, curves, pending orders) current, calls the
// callback below once per batch, and writes the reply line.
await runBot({
  // One batch in, one reply out: the orders the strategy decides on
  // this slot's events, marks and fills.
  onBatch(state, batch) {
    return decideOrders(state, batch);
  },

  // The run is over and the final account has been folded in. There
  // is nothing left to send — no reply goes back for a done message —
  // so this hook only exists to make the lifecycle explicit.
  onDone() {
    // Final positions were already flattened by the harness.
  },
});
