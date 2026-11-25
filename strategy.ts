// Clean Sharpe Sniper — a paper-trading bot for the pump.fun Sharpe Sprint.
//
// Why this shape: places go by hourly Sharpe ratio, so the bot wants many
// small, low-variance wins, not one moonshot — but on pump.fun the return
// distribution is a fat tail: most fresh coins bleed slowly while a few
// percent run far in their first minutes. Tight take-profits cut those
// runners off, and tight stop-losses realise the bleed, so both lose. This
// bot buys a fresh launch once, only when its opening tape looks like a real
// launch rather than the creator's own cluster (the creator put in at most
// 2.5 SOL and only two other wallets have piled in yet, with real reserves
// already past 2 SOL), sizes every entry the same tiny 0.015 SOL, and then
// gives the trade room: a wide +20% take-profit, a -25% stop-loss, and a
// 60-slot clock. The many small losers are the price of the few runners, and
// because each stake is tiny and the hold is short, the stake recycles
// across many coins in a 6-hour window, which is what keeps the hourly
// Sharpe ratio steady instead of lottery-like. The settings were chosen on
// the dev window with the kit's own replay simulator, preferring flat
// regions of the grid over its single best cell: on dev this bot loses a
// little (-0.067 SOL over 24h, 111 round trips, 1.0% max drawdown), the
// honest result on a window where every long-only approach loses — the edge
// is the tight selectivity, not a fitted profit.
// Entry (decided once per coin, while it is at most maxAgeSlots old):
//   - the creator's own buys in the opening tape are at most maxDevBuySol,
//     and the creator has not sold anything yet (a creator who already sells
//     is exiting, not launching);
//   - at most maxBuyers distinct non-creator buyers have piled in so far: a
//     launch bundled by many wallets in its first slots is usually the
//     creator's cluster waiting to dump;
//   - net SOL inflow over the opening tape is at least minFlowSol, with at
//     least minTrades recorded trades;
//   - price run-up from creation sits inside [minRunup, maxRunup]: rising,
//     but not already mooned;
//   - real SOL reserves sit inside [minRqSol, maxRqSol], and the 1% size cap
//     allows at least the 0.01 SOL minimum round trip.
// Exit (whole position, every batch):
//   - take profit at +takeProfit over cost, stop loss at -stopLoss;
//   - trailing stop: once up trailArm, sell on a fall of trailDrop from the
//     position's peak value (trailArm >= 1 turns it off);
//   - time stop: sell after maxHoldSlots held (0 = off), or after holdTrades
//     further trades print on the coin (0 = off);
//   - creator-sell exit: sell at once when the creator sells while held;
//   - a completed curve is closed by the replay itself.
// Sizing: stakeSol per entry (or the size cap when smaller), at most 5 open
// positions, one entry per coin for the whole run.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import { LAMPORTS_PER_SOL, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const BPS = 10_000n;

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** SOL to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time (SOL). */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys in the opening tape: at most this (SOL). */
  maxDevBuySol: number;
  /** Trades seen before entry. */
  minTrades: number;
  /** Distinct non-creator buyers before entry, at most. */
  maxBuyers: number;
  /** Net SOL inflow (buys minus sells) over the opening tape, at least this (SOL). */
  minFlowSol: number;
  /** Price now over the create price, as a fraction: window. */
  minRunup: number;
  maxRunup: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (fraction). */
  takeProfit: number;
  /** Exit when it is worth this much under its cost (fraction). */
  stopLoss: number;
  /** Trailing stop: once up at least this, exit on a fall of trailDrop from the peak value (>= 1 = off). */
  trailArm: number;
  trailDrop: number;
  /** Exit after holding this many slots (0 = off). */
  maxHoldSlots: number;
  /** Exit after this many further trades print on the coin (0 = off). */
  holdTrades: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 0,
  maxAgeSlots: 4,
  stakeSol: 0.015,
  minBuySol: 0.01,
  minRqSol: 2,
  maxRqSol: 30,
  maxDevBuySol: 2.5,
  minTrades: 0,
  maxBuyers: 2,
  minFlowSol: 0,
  minRunup: 0,
  maxRunup: 10,
  buySlippageBps: 10_000,
  takeProfit: 0.2,
  stopLoss: 0.25,
  trailArm: 1,
  trailDrop: 0.1,
  maxHoldSlots: 60,
  holdTrades: 0,
  exitOnDevSell: false,
};

/** Opening tape of one coin. */
interface Coin {
  creator: Pubkey;
  createSlot: number;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  buySol: bigint;
  sellSol: bigint;
  entered: boolean;
  complete: boolean;
}

/** An open position as this bot tracks it. */
interface Held {
  entrySlot: number;
  entryTrades: number;
  peakValue: bigint;
  devSoldAtOpen: boolean;
}

function price(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function markValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt === 0n) return 0n;
  return (tokens * vq) / vt;
}

function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function createStrategy(P: Params): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const stake = solToLamports(P.stakeSol);
  const minBuy = solToLamports(P.minBuySol);
  const minRq = solToLamports(P.minRqSol);
  const maxRq = solToLamports(P.maxRqSol);
  const maxDevBuy = solToLamports(P.maxDevBuySol);
  const minFlow = solToLamports(P.minFlowSol);

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // --- fold this batch's events into the tapes ---
    const candidates: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          creator: e.creator,
          createSlot: e.slot,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          trades: 0,
          buyers: new Set<Pubkey>(),
          buySol: 0n,
          sellSol: 0n,
          entered: false,
          complete: false,
        });
        candidates.push(e.mint);
        continue;
      }
      if (e.event === 'TradeEvent') {
        let c = coins.get(e.mint);
        if (c === undefined) {
          c = {
            creator: e.creator,
            createSlot: e.slot,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            devSold: false,
            trades: 0,
            buyers: new Set<Pubkey>(),
            buySol: 0n,
            sellSol: 0n,
            entered: false,
            complete: false,
          };
          coins.set(e.mint, c);
        }
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.buySol += sol;
          if (isDev) c.devBuy += sol;
          else c.buyers.add(e.user);
        } else {
          c.sellSol += sol;
          if (isDev) c.devSold = true;
        }
        c.trades += 1;
        candidates.push(e.mint);
        continue;
      }
      if (e.event === 'CompleteEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }

    // --- exits first: free slots and cash before deciding new entries ---
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = markValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const cost = pos.cost_lamports;
      if (cost === 0n) continue;
      const c = coins.get(mint);
      let rec = held.get(mint);
      if (rec === undefined) {
        rec = { entrySlot: state.slot, entryTrades: c !== undefined ? c.trades : 0, peakValue: value, devSoldAtOpen: c !== undefined && c.devSold };
        held.set(mint, rec);
      }
      if (value > rec.peakValue) rec.peakValue = value;
      const tpNum = BigInt(Math.round(P.takeProfit * 10_000));
      const slNum = BigInt(Math.round(P.stopLoss * 10_000));
      const hitTp = value * BPS >= cost * (BPS + tpNum);
      const hitSl = value * BPS <= cost * (BPS - slNum);
      let hitTrail = false;
      if (P.trailArm < 1) {
        const armNum = BigInt(Math.round(P.trailArm * 10_000));
        const dropNum = BigInt(Math.round(P.trailDrop * 10_000));
        const armed = rec.peakValue * BPS >= cost * (BPS + armNum);
        const fell = value * BPS <= rec.peakValue * (BPS - dropNum);
        hitTrail = armed && fell;
      }
      const hitHold = P.maxHoldSlots > 0 && state.slot - rec.entrySlot >= P.maxHoldSlots;
      const hitTrades = P.holdTrades > 0 && c !== undefined && c.trades - rec.entryTrades >= P.holdTrades;
      const hitDevSell = P.exitOnDevSell && c !== undefined && c.devSold && !rec.devSoldAtOpen;
      if (hitTp || hitSl || hitTrail || hitHold || hitTrades || hitDevSell) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        held.delete(mint);
        slots += 1;
      }
    }

    // --- entries: one small buy per qualifying fresh coin ---
    for (const mint of candidates) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const c = coins.get(mint);
      if (c === undefined || c.entered || c.complete) continue;
      if (state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const age = state.slot - c.createSlot;
      if (age < P.minAgeSlots || age > P.maxAgeSlots) continue;
      if (c.trades < P.minTrades) continue;
      if (c.buyers.size > P.maxBuyers) continue;
      if (c.devBuy > maxDevBuy) continue;
      if (c.devSold) continue;
      if (c.buySol - c.sellSol < minFlow) continue;
      if (curve.real_quote_reserves < minRq) continue;
      if (curve.real_quote_reserves > maxRq) continue;
      const runup = price(curve.virtual_quote_reserves, curve.virtual_token_reserves) / price(c.vq0, c.vt0) - 1;
      if (!(runup >= P.minRunup && runup <= P.maxRunup)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < minBuy) continue;
      const amount = cap < stake ? cap : stake;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
      c.entered = true;
      free -= amount + txFee;
      slots -= 1;
    }

    // --- forget positions the replay closed without us ---
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    return orders;
  }

  return { onBatch };
}
