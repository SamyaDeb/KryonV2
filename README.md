# How to run  Kryon client

Stellar/Soroban perpetual-futures DEX terminal (Next.js 16 + React 19). Launch market: **XLM-PERP**, USDC-settled, on Stellar **testnet**.

## Prerequisites

- [Bun](https://bun.sh)
- [Freighter](https://freighter.app) wallet, set to **Stellar Testnet**
- A desktop / large screen (≥ 1024px) — the terminal is desktop-first

## Setup

```bash
bun install
```

Create `.env` (Next.js) **and** `.env.local` (the off-chain scripts read this):

```ini
DATABASE_URL="postgresql://…neon.tech/db?sslmode=require"   # Neon Postgres
ORACLE_PUBLISHER_SECRET="S…"                                 # authorized oracle publisher key
```

Order & market data uses the app's own `/api` routes (same-origin) — no matcher/indexer URL needed.

## Run

```bash
bun run dev        # http://localhost:3000  →  /trade/XLM-PERP
```

### Off-chain services (run for live prices & fills)

```bash
bun run dev:oracle     # publish XLM price on-chain (~8s)
bun run dev:matcher    # match orders + settle fills on-chain
bun run dev:indexer    # sync on-chain state → DB
```

## Other

```bash
bun run build && bun run start   # production
bun run lint
```

## CI/CD

GitHub Actions are configured for production readiness:

- `.github/workflows/ci.yml` runs client lint, typecheck, audit, production gate, build, plus protocol Rust checks on PRs and pushes to `main`.
- `.github/workflows/mainnet-preflight.yml` is a manual mainnet gate that requires every mainnet contract, asset, app, websocket, database, and signer secret to be configured.
- `.github/workflows/deploy-client.yml` is a manual Vercel deployment pipeline. Production deploys require `confirm_mainnet=mainnet` and pass the full gate before deployment.
- `.github/workflows/production-validation.yml` validates the live production app: security headers, readiness, core APIs, websocket reconnect storm behavior, market-data soak, and required wallet/trading evidence links.
- `.github/workflows/codeql.yml` runs JavaScript/TypeScript static security analysis on PRs, `main`, and weekly.
- `.github/dependabot.yml` opens weekly dependency and GitHub Actions update PRs.

Required GitHub variables for production:

```ini
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_WS_URL
NEXT_PUBLIC_STELLAR_RPC_URL
NEXT_PUBLIC_ACTIVE_MARKETS
NEXT_PUBLIC_CONTRACT_GOVERNANCE
NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER
NEXT_PUBLIC_CONTRACT_VAULT
NEXT_PUBLIC_CONTRACT_ENGINE
NEXT_PUBLIC_CONTRACT_ORDER_GATEWAY
NEXT_PUBLIC_CONTRACT_INSURANCE
NEXT_PUBLIC_CONTRACT_LIQUIDATION
NEXT_PUBLIC_CONTRACT_RISK
NEXT_PUBLIC_ASSET_NATIVE_XLM
NEXT_PUBLIC_ASSET_USDC
NEXT_PUBLIC_USDC_ISSUER
```

Required GitHub secrets for production:

```ini
DATABASE_URL
MATCHER_OPERATOR_SECRET
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID
VERCEL_TOKEN
```

Required GitHub variables for live production validation:

```ini
WALLET_E2E_EVIDENCE_URL
TRADING_E2E_EVIDENCE_URL
OBSERVABILITY_DASHBOARD_URL
INCIDENT_RUNBOOK_URL
ROLLBACK_RUNBOOK_URL
LIVE_GATE_MARKET_ID
```

## Routes

- `/trade/[market]` — trading terminal (e.g. `/trade/XLM-PERP`)
- `/portfolio` — account overview
- `/leaderboard` — trader rankings
