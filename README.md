<div align="center">

<img width="1441" height="828" alt="Screenshot 2026-07-04 at 4 04 53 PM" src="https://github.com/user-attachments/assets/56f34d11-46a6-4de6-9a74-67f4030a8fa8" />

# Kryon Protocol


**A decentralised perpetual-futures exchange on Stellar / Soroban.**

Off-chain CLOB matching for low-latency execution — custody, margin, funding, and settlement fully on-chain.

[Live App](https://kryonprotocol.vercel.app) · [Documentation](https://kryonprotocol.vercel.app/docs) · [Architecture](#architecture) · [Quick Start](#quick-start)

![Network](https://img.shields.io/badge/network-Stellar%20Mainnet-brightgreen)
![Contracts](https://img.shields.io/badge/contracts-Soroban%20(Rust)-orange)
![Frontend](https://img.shields.io/badge/frontend-Next.js%2016%20%2B%20React%2019-black)
![CI](https://img.shields.io/badge/CI-GitHub%20Actions-green)

</div>

---

## What is Kryon?

Kryon is a perpetual-futures DEX that pairs an **on-chain margin engine and settlement layer** (eight Soroban smart contracts) with an **off-chain central-limit order book matcher**, giving traders a familiar low-latency perp experience without giving up self-custody.

- **Launch market:** `XLM-PERP`, quoted and settled in **USDC** (BTC-PERP and ETH-PERP market configs are ready to enable)
- **Leverage:** up to 10× with 1000bps initial margin on the launch market
- **Custody:** collateral never leaves the on-chain vault; the matcher can only settle orders traders have signed
- **Network:** Stellar **mainnet** — live in production since 2026-07-07

Traders sign order intents with [Freighter](https://freighter.app), the matcher pairs them price-time priority, and every fill is settled on-chain through the order gateway into a single volume-weighted position per (trader, market).

## Architecture

```
                        ┌─────────────────────────┐
   Trader (Freighter)   │      Next.js frontend    │
        │               │  trade · portfolio · LB  │
        │  sign orders  └───────────┬─────────────┘
        ▼                           │ REST (same-origin /api/*)
┌──────────────────┐                ▼
│  Order intents   │      ┌───────────────────────┐
│  (off-chain DB)  │◀────▶│   Next.js API routes   │──▶ Neon Postgres
└────────┬─────────┘      └───────────────────────┘
         │ poll
         ▼
┌──────────────────┐   settle_fill (operator-signed)   ┌──────────────────┐
│  Matcher service │ ────────────────────────────────▶ │  Soroban engine  │
│  (price-time)    │                                    │  vault · oracle  │
└──────────────────┘                                    └──────────────────┘
         ▲                                                       │
         │ state sync (positions, OI, funding, stats)            │
┌──────────────────┐                                             │
│  State indexer   │◀────────────────────────────────────────────┘
└──────────────────┘
```

### On-chain (Soroban contracts, Rust `#![no_std]`)

| Contract | Responsibility |
| --- | --- |
| `perp-vault` | SEP-41 collateral custody, internal balances, risk-gated withdrawals |
| `perp-engine` | Position lifecycle, execution price bands, OI caps, fees, funding indexes, realized PnL settlement |
| `perp-order-gateway` | Settlement entry point for matched fills — nonce tracking, overfill protection, self-trade rejection, cancellations |
| `perp-oracle-adapter` | Guarded price snapshots: publisher auth, staleness checks, quorum medianization, deviation bounds |
| `perp-liquidation` | Account-health liquidation executor with capped rewards and bad-debt recording |
| `perp-insurance` | Insurance fund custody, rewards, bad-debt accounting |
| `perp-risk` | Thin Soroban boundary around the pure Rust risk engine |
| `perp-governance` | Timelock proposal registry and guardian pause control |

The authorisation graph is strict: `Engine.open_position` requires the order gateway, `Vault.apply_pnl` requires the engine, and end-user signatures are required only where users spend their own funds (deposit/withdraw) or revoke their own orders (cancel).

### Off-chain services

| Service | Role |
| --- | --- |
| **Matcher** | Deterministic CLOB with price-time priority, partial fills, replace priority reset, market-order walking — settles fills on-chain via operator-signed `settle_fill` |
| **Oracle keeper** | Publishes the median of Binance/Coinbase/Kraken on-chain every ~8s (≥2 sources required, deviation + USDC-depeg guards) |
| **State indexer** | Syncs on-chain positions, OI, funding, and stats to Postgres; computes leaderboard/portfolio analytics |
| **WebSocket server** | Real-time orderbook and trade broadcast |
| **Settlement reconciler** | Recovers stuck/queued settlement transactions |
| **Liquidation keeper** | Scans accounts, liquidates underwater positions, and runs the contract TTL keepalive |
| **Monitor** | Alerting for stale oracle, bad debt, settlement failures, liquidation backlog |

### Protocol invariants (non-negotiable)

1. Withdrawals are validated against **current account equity**, not stored locked margin.
2. Liquidations are **account-health based**; position-local liquidation only for explicit isolated margin.
3. Funding derives from market imbalance or independent mark/index divergence — never oracle minus itself.
4. Every oracle read carries source, timestamp, confidence, and freshness bounds.
5. Insurance/SLP accounting must reconcile to vault custody plus known unsettled liabilities.
6. Upgrade authority is protocol risk: governance delay plus emergency limits.

## Repository layout

```
.
├── client/                  Next.js 16 trading terminal, API routes, off-chain service scripts
│   ├── app/                 App Router pages (trade, portfolio, leaderboard, markets) + /api routes
│   ├── features/            Trade terminal, chart, wallet, navbar feature modules
│   ├── scripts/             Oracle keeper, matcher, indexer, WS server, reconciler, liquidator, test suites
│   └── config/              Market configs, contract addresses, precision constants
├── kryon-protocol/          Rust workspace — the protocol itself
│   ├── contracts/           8 Soroban contracts (vault, engine, gateway, oracle, risk, …)
│   ├── crates/              protocol-core (fixed-point math, types), risk-engine, order-types
│   ├── services/            Deterministic matcher/indexer/keeper/monitoring/runtime crates
│   ├── testing/             Invariant, fuzz, hardening, and load/chaos harnesses
│   ├── infra/               Deploy manifests, runbooks, monitoring, signer/RPC ops
│   └── prisma/              Postgres schema (orders, fills, positions, tx jobs, audit trail)
├── docs/                    Docusaurus engineering reference (served at /docs)
└── Audit Reports/           Internal audit reports and mainnet-implementation audit
```

## Deployed contracts (Stellar mainnet)

Live in production as of **2026-07-07**. All eight contracts deployed, initialized, wired, and market-configured; admin authority is mid-transfer to the `perp-governance` timelock (48h delay).

| Contract | Address |
| --- | --- |
| Governance | `CDSIEH7UZ62BT523G3RGJQGJHE7AI4EV265ESKZB672GTIEZNBYPYDXU` |
| Oracle Adapter | `CD3ZFYZPLJ6W2KO6HD7HE5P5Q27M5N6ITUPHQDRP23NBIVKE6WTUY25F` |
| Vault | `CDXGTJQS3XLGXSWDUHKMS5PBBFRRKRXRWH3HTBFNXBIAYEZNDTDKLR4J` |
| Engine | `CD6OMHCRDDBDO7I57HCUU52RORFPP7DUIRULWFBOX5WLCO5H2OB3W6LZ` |
| Order Gateway | `CBA2PSRHSIFTSUAFZWMF6CARNO7YR52PWLWLEXYVRACORS2RXNO2DUTJ` |
| Insurance | `CCBEJ3F2PUV5OA4JNX3CPSOJFQMYMFDPLNANR2GJZVQEEBFMB6JYNL54` |
| Liquidation | `CBGSXCZTZOSBMM5RLGZWWLE2USNAXL5ZKCHTZQ6DOKBD3PIEUJXFYDRO` |
| Risk | `CBHZWEIKXULFIH6DCSS7W6BJ3YUVQ5TJFYPP4UKQC4NKLNAF7VLPNVUI` |
| USDC (Circle SAC) | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| XLM SAC | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |

Addresses are mirrored in `client/config/index.ts` and can be overridden via `NEXT_PUBLIC_CONTRACT_*` environment variables. Redeploy scripts live in `client/scripts/redeploy-*.ts`; the mainnet deploy itself was run via `client/scripts/mainnet-deploy.ts`.

<details>
<summary>Testnet contract addresses (used for local development)</summary>

| Contract | Address |
| --- | --- |
| Governance | `CBZT5HUXI42TD55GGB5Y7OZZ72IT5SN64ONOGDYS2PFQCOWIT4XOA6MU` |
| Oracle Adapter | `CARSV4BT3II5QONUAOP4D363OUNTTSSZCXSKNNXKZCBJM7Z6UXSNZ3LP` |
| Vault | `CBQ6634Z3UPXFVVHHV2JNSGXHQOZZK62Z65HCAQTINBGXS3IDXKRTRYK` |
| Engine | `CBSUYAO2EYAQVFISJQKG4TNMJPCDCPPFGI25Q3SW2BJPFSKQ45GRGTXN` |
| Order Gateway | `CAJGC2SIV6DFJETJ6ATG5MR6RPNX5HQ26LYA4RGSHF2QPTBS6OJWONL3` |
| Insurance | `CA3VD55APWCYLVN7PYGJ7NPKSQBE3VU4MWVCSKLOYAZI5RFWWR76G2CL` |
| Liquidation | `CDCRNKXTTTOO7IRVC66KZR5QMVGGZIOF2QPJSVELLD7G7F4IVLM2DCMG` |
| Risk | `CAVCW7XCQRA6VYWBKFDABYZGDNUJYHEYKHR4TT6BQBHS6QPDGFJVYBDS` |

</details>

## Quick start

### Prerequisites

- [Bun](https://bun.sh) (client) · Node 20+ works too
- [Rust](https://rustup.rs) with the workspace toolchain (protocol, optional)
- [Freighter](https://freighter.app) wallet — set to **Stellar Testnet** for local development (the deployed app at [kryonprotocol.vercel.app](https://kryonprotocol.vercel.app) runs on **Stellar Mainnet**)
- A Neon (or any) Postgres database
- Desktop / large screen (≥ 1024 px) — the terminal is desktop-first

> Local dev defaults to testnet contracts (see the collapsed testnet table above) so you can test with faucet funds. To point a local instance at mainnet, set the `NEXT_PUBLIC_CONTRACT_*` / `NEXT_PUBLIC_STELLAR_NETWORK` env vars to the mainnet values instead.

### 1. Run the client

```bash
cd client
bun install
```

Create `client/.env` (Next.js) **and** `client/.env.local` (off-chain scripts read this):

```ini
DATABASE_URL="postgresql://…neon.tech/db?sslmode=require"   # Postgres
ORACLE_PUBLISHER_SECRET="S…"                                 # authorized oracle publisher key
```

```bash
bun run dev        # http://localhost:3000  →  /trade/XLM-PERP
```

Order and market data flows through the app's own same-origin `/api` routes — no separate matcher/indexer URL is needed.

### 2. Run the off-chain services (live prices & fills)

```bash
bun run dev:oracle       # publish XLM price on-chain (~8s cadence)
bun run dev:matcher      # match orders + settle fills on-chain
bun run dev:indexer      # sync on-chain state → DB
bun run dev:ws           # WebSocket server (orderbook + trades)
bun run dev:reconciler   # recover stuck settlement transactions
bun run dev:liquidator   # liquidate underwater positions + contract TTL keepalive
```

A PM2 ecosystem file (`client/ecosystem.config.cjs`) and Docker Compose / Render configs are provided for running the service fleet in the cloud.

### 3. Build the protocol (optional)

```bash
cd kryon-protocol
cargo build --workspace
cargo test  --workspace
```

## Routes

| Route | Page |
| --- | --- |
| `/` | Landing page |
| `/trade/[market]` | Trading terminal (e.g. `/trade/XLM-PERP`) |
| `/portfolio` | Account overview — balances, positions, history |
| `/leaderboard` | Trader rankings |
| `/markets` | Market list |
| `/docs` | Full engineering documentation (Docusaurus) |

### API surface

REST endpoints are Next.js route handlers under `client/app/api/**`: `orders` (submit/cancel), `fills`, `funding`, `markets`, `portfolio`, `leaderboard`, `settlements`, plus `health` and `ready` probes. The WebSocket contract and full request/response schemas are documented in the [API reference](https://kryonprotocol.vercel.app/docs/api/rest).

## Testing & verification

| Suite | Command | Coverage |
| --- | --- | --- |
| Protocol unit + invariants | `cargo test --workspace` | Math, risk engine, contracts, matcher determinism |
| E2E (testnet) | `bun run dev:e2e` | Deposit → order → match → settle → position → close |
| Load test | `bun run dev:load` | All API endpoints under load |
| Failure recovery | `bun run dev:recovery` | Service crash / stuck-tx / reorg scenarios |
| Soak test | `SOAK_MINUTES=3 bun run dev:soak` | Sustained trading cycles |
| Production gate | `bun run production:gate` | Config completeness before deploy |
| Live gate | `bun run production:live-gate` | Live deployment health validation |

Additional harnesses live in `kryon-protocol/testing/`: stateful solvency invariants, fuzz targets, hardening checks (deterministic replay, keeper/monitor agreement), and load/chaos simulations.

## CI/CD

GitHub Actions workflows (`.github/workflows/`):

- **`ci.yml`** — client lint, typecheck, `npm audit`, production gate, build, plus protocol Rust checks on PRs and pushes to `main`
- **`deploy-production.yml`** — auto-deploys the client to Cloudflare Workers (via `@opennextjs/cloudflare` + `wrangler`) on pushes to `main` (paths `client/**`) after a readiness gate
- **`deploy-client.yml`** — manual Vercel deployment pipeline (legacy/fallback); production deploys require `confirm_mainnet=mainnet`
- **`mainnet-preflight.yml`** — manual mainnet gate requiring every contract, asset, app, websocket, database, and signer secret to be configured (passed for the 2026-07-07 mainnet launch; reused for future mainnet redeploys)
- **`production-validation.yml`** — validates the live app: security headers, readiness, core APIs, websocket reconnect storms, market-data soak, and required E2E evidence links
- **`codeql.yml`** + **`dependency-review.yml`** + Dependabot — static security analysis and weekly dependency updates

<details>
<summary>Required GitHub variables & secrets for production</summary>

**Variables**

```ini
NEXT_PUBLIC_APP_URL              NEXT_PUBLIC_CONTRACT_VAULT
NEXT_PUBLIC_WS_URL               NEXT_PUBLIC_CONTRACT_ENGINE
NEXT_PUBLIC_STELLAR_RPC_URL      NEXT_PUBLIC_CONTRACT_ORDER_GATEWAY
NEXT_PUBLIC_ACTIVE_MARKETS       NEXT_PUBLIC_CONTRACT_INSURANCE
NEXT_PUBLIC_CONTRACT_GOVERNANCE  NEXT_PUBLIC_CONTRACT_LIQUIDATION
NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER  NEXT_PUBLIC_CONTRACT_RISK
NEXT_PUBLIC_ASSET_NATIVE_XLM     NEXT_PUBLIC_ASSET_USDC
NEXT_PUBLIC_USDC_ISSUER
```

**Secrets**

```ini
DATABASE_URL
MATCHER_OPERATOR_SECRET
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
CLOUDFLARE_API_TOKEN      # deploy-production.yml (Workers Scripts: Edit)
CLOUDFLARE_ACCOUNT_ID     # deploy-production.yml
VERCEL_ORG_ID             # deploy-client.yml (legacy manual deploy)
VERCEL_PROJECT_ID
VERCEL_TOKEN
```

Worker **runtime** secrets (`DATABASE_URL`, `MATCHER_OPERATOR_SECRET`, `UPSTASH_*`) are set once with `wrangler secret put`, never through CI.

**Live-validation variables**

```ini
WALLET_E2E_EVIDENCE_URL     OBSERVABILITY_DASHBOARD_URL   LIVE_GATE_MARKET_ID
TRADING_E2E_EVIDENCE_URL    INCIDENT_RUNBOOK_URL          ROLLBACK_RUNBOOK_URL
```

</details>

## Security

- **Trusted-operator settlement:** the matcher operator can only settle fills that both traders have signed; it cannot invent positions, move collateral, or bypass price bands, expiry, cancellation, overfill, or self-trade checks enforced on-chain.
- **Guarded oracle:** publisher authorization, publish-time staleness rejection, monotonic replay rejection, confidence checks, quorum medianization with three-source minimum, and source-deviation bounds.
- **Two-step admin transfer** on all contracts holding privileged config roles; governance timelock plus guardian pause.
- **Audits:** internal audit reports (including a mainnet-implementation audit) live in [`Audit Reports/`](Audit%20Reports/). All flagged high/critical findings were fixed and the contracts redeployed.
- Precision model: prices and PnL use 1e18 fixed-point; USDC amounts use 1e7 (Stellar stroop-equivalent) — all math is checked, deterministic, and dependency-light.

The full threat model and trust assumptions are documented in [Security](https://kryonprotocol.vercel.app/docs/security).

## Documentation

The complete engineering reference — architecture, trade lifecycle, PnL & funding math, database schema, REST/WebSocket APIs, runbooks, stress-test report, and mainnet-readiness analysis — is built with Docusaurus from [`docs/`](docs/) and served at [/docs](https://kryonprotocol.vercel.app/docs) on the live deployment.

```bash
cd docs && npm install && npm start   # local docs at http://localhost:3000
```

## Status & roadmap

Kryon is **live on Stellar mainnet** as of 2026-07-07 — all eight contracts deployed and wired, the `XLM-PERP` market configured (10× leverage, guardian pause armed, $500 USDC deposit cap while ramping), and the frontend, matcher, oracle keeper, indexer, and liquidation keeper all running against production. The full suite (E2E, load, soak, failure-recovery, and production-gate) is validated on testnet as part of every release; a mainnet tiny-trade E2E drill is the last item before the deposit cap is lifted. Admin authority is transferring to the `perp-governance` timelock (48h delay) as the final hardening step — see the [mainnet-readiness checklist](https://kryonprotocol.vercel.app/docs/mainnet-readiness) for the full launch runbook.

---

<div align="center">

Built on <a href="https://stellar.org">Stellar</a> · Powered by <a href="https://soroban.stellar.org">Soroban</a>

</div>
