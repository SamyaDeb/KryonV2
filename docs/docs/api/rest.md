---
id: rest
title: REST API
sidebar_position: 1
---

# REST API

All endpoints are Next.js route handlers under `client/app/api/**`, served
same-origin. Requests/responses are JSON. Monetary fields are raw fixed-point
strings on trading endpoints and human-unit floats on analytics endpoints
(noted per route).

## Orders

### `POST /api/orders`

Persist an order intent. Validated before any DB write.

```json
{
  "owner": "G…",            "market_id": 1,
  "is_long": true,          "size": "10000000",          // 1e7
  "limit_price": "205000000000000000",  // 1e18, 0 = market
  "reduce_only": false,     "nonce": "1780061000000",
  "expiry_ts": "1780064600"
}
```

Responses: `200 { ok: true }` · `400 { ok: false, error }` (validation) ·
`500 { ok: false, error: "Failed to persist order" }`.

Validation rejects invalid addresses, unknown markets, non-positive/oversized
sizes, negative/oversized prices, bad nonces, and past/over-distant expiries.

### `POST /api/orders/cancel`

```json
{ "owner": "G…", "nonce": "1780061000000" }
```

Marks the order cancelled (idempotent). Validated address + numeric nonce.

## Market data

### `GET /api/markets/:id`

Market state — `last_price`, `volume`, `long_open_interest`,
`short_open_interest`, `funding_long_index`, `funding_short_index`,
`last_oracle_price` (raw `1e18`/`1e7` strings).

### `GET /api/markets/:id/orderbook`

```json
{ "bids": [{ "price": "0.2050", "size": "1.0000" }], "asks": [], "timestamp": 1780061673243 }
```

Prices/sizes are aggregated and pre-formatted to human units here.

### `GET /api/markets/:id/trades?limit=50`

Recent fills: `{ price, size, side: "buy"|"sell", timestamp }`.

### `GET /api/markets/:id/candles`

OHLC candles for the chart.

### `GET /api/fills?address=G…&limit=20&since=<ms>`

Per-address fill history (maker or taker).

## Analytics

### `GET /api/leaderboard`

See [Leaderboard System](/data/leaderboard). Params: `period`, `metric`,
`limit`, `offset`, `search`. Returns ranked traders in human units.

### `GET /api/portfolio/:address`

See [Portfolio Tracking](/data/portfolio). Returns analytics + pnl/balance/
funding history + equity curve in human units.

## Conventions

- **Validation first** — malformed payloads never reach the DB.
- **No internal-error leakage** — handlers log server-side and return generic
  messages.
- **Transient retry** — write paths retry transient Neon errors via `withRetry`.
- **Caching** — analytics routes set `s-maxage` + `stale-while-revalidate`;
  market reads are `no-store` (freshness-critical).
