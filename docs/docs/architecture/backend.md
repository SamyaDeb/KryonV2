---
id: backend
title: Backend Architecture
sidebar_position: 4
---

# Backend Architecture

The backend is two layers: **stateless API route handlers** (Next.js, talking
to Postgres) and **long-running services** (matcher, oracle keeper, indexer)
that bridge the database and the chain.

## API layer (`client/app/api/**`)

Route handlers are thin: validate input → query/write Neon → shape JSON. They
hold no in-memory state, so they scale horizontally.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/orders` | POST | Validate + persist an order intent |
| `/api/orders/cancel` | POST | Mark an order cancelled |
| `/api/markets/:id` | GET | Market stats (price, OI, volume, funding) |
| `/api/markets/:id/orderbook` | GET | Aggregated bids/asks |
| `/api/markets/:id/trades` | GET | Recent fills |
| `/api/markets/:id/candles` | GET | OHLC candles |
| `/api/fills` | GET | Per-address fill history |
| `/api/leaderboard` | GET | Ranked trader stats |
| `/api/portfolio/:address` | GET | Account analytics + history |
| `/api/settlements`, `/api/settlements/:id/sign` | GET/POST | Legacy settlement signing (superseded by operator model) |

### Hardening

- **Input validation** (`lib/validation.ts`): order intake rejects invalid
  Stellar addresses, unknown markets, non-positive sizes, out-of-range
  prices, bad nonces, and past/absurd expiries with `400` + a safe message.
- **No error leakage**: handlers log internals server-side and return generic
  messages, never raw exception text.
- **Transient retry** (`lib/db.ts` `withRetry`): write paths retry on transient
  Neon errors (`fetch failed`, connection resets) with backoff; deterministic
  errors are not retried.

## Services

### Matcher (`scripts/matcher-service.ts`)

The execution engine. Each 1s tick:

1. Load resting limit orders + pending market orders for each market.
2. Run `matchAll` (price-time priority, self-trade prevention,
   partial-fill accounting via a shared `pendingFills` map).
3. For each match: `persistFill` (idempotent insert + filledSize update),
   then settle on-chain.
4. **Capture both sides' positions before settlement**, settle `settle_fill`
   (operator-signed), then **book realized-PnL events** (`recordFillPnl`).
5. On settlement failure: `rollbackFill` returns the orders to the book for a
   clean re-match — keeping the DB consistent with chain.

The loop is **strictly sequential** (one tick at a time) to avoid overlapping
fills and race conditions. The DB client is recreated after repeated transient
errors.

### Oracle keeper (`scripts/oracle-keeper.ts`)

Publishes live XLM/USD prices from Binance to the oracle adapter every 8s
(under the 60s staleness guard). Uses `ORACLE_PUBLISHER_SECRET`.

### State indexer (`scripts/state-indexer.ts`)

Polls the engine/oracle every 5s and writes market state (last oracle price,
open interest, funding indices) to Postgres. Every ~30s it also runs the
**stats aggregator** (`runAggregation`) to refresh leaderboard and portfolio
tables. Safe to run 24/7.

## Key separation

The matcher and oracle keeper use **different signing keys**
(`MATCHER_OPERATOR_SECRET` vs `ORACLE_PUBLISHER_SECRET`). They were originally
the same account, which caused `tx_bad_seq` sequence-number collisions under
concurrency. Dedicated keys decouple their transaction streams. See
[Deployment](/operations/deployment) and the [Stress-Test
Report](/stress-test-report).

## Settlement submission (`lib/stellar/settlement.ts`)

`submitSettleFillDirect` builds, simulates, assembles, signs (operator), and
submits `settle_fill`, then polls for confirmation. It:

- Retries on `tx_bad_seq` with a fresh account sequence (safe — a rejected tx
  never executed).
- Treats confirmation timeout as **terminal** (no resubmit) to avoid
  double-settlement; the matcher rolls the fill back instead.
