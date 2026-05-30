---
id: stress-test-report
title: Stress-Test Report
sidebar_position: 92
---

# Stress-Test Report

Production-hardening pass against the live testnet stack. Each finding below was
reproduced, fixed, and re-verified.

## Summary

| # | Area | Severity | Status |
| --- | --- | --- | --- |
| 1 | Order intake — no input validation | High | Fixed |
| 2 | Order intake — internal error leakage | Medium | Fixed |
| 3 | DB transient failure under burst | Medium | Fixed |
| 4 | Cancel route — crash on bad nonce + error leak | Medium | Fixed |
| 5 | Settlement masked failures as "unknown" | Medium | Fixed |
| 6 | DB/chain divergence on settle failure | High | Fixed |
| 7 | Shared signing key → `tx_bad_seq` dropped settlements | High | Fixed |
| 8 | WebSocket reconnect loop against absent server | Low | Fixed |
| 9 | Oracle poll unhandled rejection on RPC failure | Medium | Fixed |
| 10 | Leaderboard route latency (sequential queries) | Low | Fixed |

## Findings & fixes

### 1–2. Order intake validation & error leakage
**Test:** posted malformed orders — invalid address, unknown market id (999),
negative size, non-numeric nonce, empty owner.
**Before:** invalid address/market/size **accepted** (polluting the book and
leaderboard); a bad nonce returned a raw `500` with internal error text.
**Fix:** `lib/validation.ts` validates address (StrKey), market, size, price,
nonce, expiry → `400` with safe messages; handlers log internally and return
generic errors. **Re-verified:** all malformed payloads now rejected `400`;
valid orders still `200`.

### 3. DB transient failure under burst
**Test:** 100 concurrent order POSTs.
**Result before:** 99/100 `200`, 1 `500` (Neon `fetch failed`).
**Fix:** `withRetry` in `lib/db.ts` retries transient Neon errors (fetch
failed / connection reset) with backoff on write paths; deterministic errors
are not retried.

### 4. Cancel route hardening
`BigInt(nonce)` threw on non-numeric input and leaked errors. **Fix:** validate
address + numeric nonce, wrap in `withRetry`, generic error responses.

### 5. Masked settlement failures
Settlement failures surfaced as `"unknown"`. **Fix:** decode the real failure
(`tx_bad_seq`, contract error code, confirmation timeout) and log per-attempt.
This exposed finding #7.

### 6. DB/chain divergence
**Test:** a fill matched and was marked filled in the DB, but on-chain
settlement failed — the order vanished from the book with no position created.
**Fix:** settlement is now **awaited**; on permanent failure `rollbackFill`
deletes the fill and restores `filledSize`, returning the order to the book.
The DB orderbook can no longer show trades that didn't settle on-chain.

### 7. Shared signing key → dropped settlements
**Root cause:** the matcher and oracle keeper shared `ORACLE_PUBLISHER_SECRET`,
so concurrent transactions collided on the account sequence
(`tx_bad_seq` → settlement "confirmation timeout", position never updated).
**Fix:** introduced a **dedicated, funded operator key** (`MATCHER_OPERATOR_SECRET`,
registered via `set_operator`); `submitSettleFillDirect` also retries
`tx_bad_seq` with a fresh sequence and treats timeout as terminal (no
double-settle). **Re-verified:** fresh trades settle first-try; positions update.

### 8. WebSocket reconnect loop
The client pointed at a non-existent `/api/ws`, reconnecting forever.
**Fix:** gated behind `NEXT_PUBLIC_WS_URL` — dormant by default, polling is the
realtime path; activates cleanly when a streaming server is deployed.

### 9. Oracle poll unhandled rejection
A failed/slow Soroban RPC in the mark-price poll became an unhandled rejection
on the interval. **Fix:** wrapped to degrade to the Binance price instead of
throwing.

### 10. Leaderboard latency
COUNT + ranked query ran sequentially (~1.7s). **Fix:** run them in parallel →
**~0.31s warm**.

## Throughput observations (dev environment)

| Scenario | Result |
| --- | --- |
| 100 concurrent order POSTs | 99/100 `200` pre-fix → retry covers the transient post-fix |
| 20 concurrent orderbook reads | 20/20 `200`, ~1.6s wall |
| Warm read latency (orderbook/trades/portfolio) | ~0.30s |
| Warm leaderboard latency | ~0.31s (was ~1.7s) |
| End-to-end trade → settle → PnL → leaderboard | verified; correct realized-PnL signs and ranking |

## Scenarios validated by design

- **Race conditions / double-fill** — matcher loop is strictly sequential;
  `pendingFills` + idempotent `Fill`/`PnlEvent` keys prevent double-spend.
- **Refresh / multi-tab during a trade** — order placement is nonce-idempotent;
  TanStack Query refetches on mount; no duplicate orders or state corruption.
- **Failed tx handling** — retry on `tx_bad_seq`, rollback on permanent failure.
- **Reconnect** — WS client has exp-backoff + jitter + resubscribe; polling
  resumes immediately on disconnect.

## Residual / out of scope here

- Per-address rate limiting on order intake (recommended pre-mainnet).
- Load testing at mainnet scale (needs dedicated infra + production build).
- See [Mainnet Readiness](/mainnet-readiness) for the full gap list.
