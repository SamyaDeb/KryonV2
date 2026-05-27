# Redegined Perp

Stellar-native perpetual DEX rebuild isolated from the legacy Krypton codebase.

This tree is intentionally separate from the old app. The legacy repository is a
reference and migration source only; production protocol logic is rebuilt here
with explicit accounting invariants and Soroban-native boundaries.

## Workspace

```text
crates/
  protocol-core/   Shared deterministic math, types, oracle snapshots, accounting primitives
  order-types/     Shared order and fill models for matcher and settlement
  risk-engine/     Pure Rust risk, margin, funding, liquidation planning

contracts/
  perp-governance/ Timelock proposal registry and guardian pause control
  perp-engine/    Position lifecycle, execution bands, fees, funding, realized PnL settlement
  perp-insurance/ Insurance fund custody, rewards, bad debt accounting
  perp-liquidation/ Account-health liquidation executor
  perp-order-gateway/ Matched-order settlement, nonce tracking, cancellations
  perp-oracle-adapter/ Guarded normalized oracle snapshots for collateral and markets
  perp-risk/       Thin Soroban boundary around the pure risk engine
  perp-vault/      SEP-41 collateral custody with risk-gated withdrawals

testing/
  invariants/      Stateful solvency and accounting invariant test plans
  fuzz/            Fuzz targets and corpus notes
  hardening/       Executable service-level invariant checks
  load-chaos/      Replay load and failure-mode simulations

infra/
  deploy/          Deployment manifests and upgrade governance runbooks
  monitoring/      Metrics, alerts, and incident hooks

services/
  indexer-api/     Deterministic event replay and API state views
  keepers/         Deterministic oracle/funding/liquidation keeper decisions
  matcher/         Deterministic off-chain CLOB core with price-time matching
  monitoring/      Alert evaluation for oracle/runtime risk signals
  node-runtime/    HTTP routes, event ingestion, persistence, tx queue primitives
  oracle-keeper/   Deterministic oracle quote normalization for publishers

prisma/
  schema.prisma    Postgres persistence schema for Neon/Prisma-backed runtime state

docs/
  architecture.md
  security-model.md
  legacy-issues-fixed.md
```

## Non-Negotiable Invariants

1. Withdrawals are validated against current account equity, not stored locked margin.
2. Liquidations are account-health based. Position-local liquidation is only valid for explicit isolated margin.
3. Funding is based on market imbalance or independently computed mark/index divergence, never oracle minus itself.
4. Oracle reads carry source, timestamp, confidence, and freshness bounds.
5. SLP/insurance accounting must reconcile to vault custody and known unsettled liabilities.
6. Upgrade authority is treated as protocol risk and must be controlled by governance delay plus emergency limits.

## Launch Market

The intended first market is `XLM-PERP`, quoted and settled in `USDC`.
This is a perpetual futures market for XLM/USDC exposure, not a spot pair.
XLM is the base oracle asset and USDC is the collateral/settlement asset.

## Status

Initial rebuild tranche:

- deterministic fixed-point math with checked arithmetic
- typed market/account/position/oracle models
- pure risk engine with account-level health and liquidation planning
- Soroban risk contract wrapper for auditable state transitions
- Soroban governance/timelock registry with proposal queue/execute/cancel and guardian pause
- guarded oracle adapter with publisher authorization, publish-time staleness checks, monotonic replay rejection, confidence checks, quorum medianization, duplicate-source rejection, odd three-source minimum quorum, and source-deviation bounds
- Soroban vault for token custody, internal balances, engine-synced positions, and risk-gated withdrawals
- Soroban position engine for gateway-gated open/increase/reduce/close flows, execution price bands, OI caps, and realized PnL settlement into the vault
- Engine-owned funding indexes with permissionless imbalance updates and position-level funding realization before mutation/close
- Maker/taker fee charging at the verified settlement boundary with fee-recipient accounting through the vault and post-fee margin enforcement
- Soroban liquidation executor that rejects healthy accounts, force-reduces unhealthy positions through the engine, pays capped rewards, and records bad debt
- Soroban insurance fund that holds backstop collateral and exposes fund balance/deficit state
- Soroban order gateway for matched fills, cancellation, expiry, overfill protection, self-trade rejection, and engine settlement
- Two-step admin nomination/acceptance on contracts that hold privileged config roles
- Shared order-types crate and deterministic matcher core with price-time priority, partial fills, cancels, replace priority reset, market-order walking, expiry pruning, and gateway-compatible fill output
- Oracle keeper normalization crate for Pyth/Reflector/RedStone-style integer quote exponent handling before quorum publication
- Indexer/API state reconstruction crate for fills, positions, funding, oracle, and bad debt views
- Keeper decision crate for stale oracle publication, funding updates, and liquidation candidates
- Monitoring alert crate for stale oracle, bad debt, settlement failure, liquidation backlog, and matcher queue signals
- Node runtime crate with HTTP health/metrics/market routes, replay RPC ingestion, append-only event store, and retry-aware tx queue
- Prisma/Postgres schema for durable Neon-backed events, ledger cursors, orders, fills, positions, oracle snapshots, tx jobs, keeper actions, deployment artifacts, governance proposals, and audit findings
- Runtime traits for live Stellar RPC, durable event stores, and managed signers without coupling protocol math to infrastructure clients
- Signer, RPC, role-transfer, Soroban budget, and audit-package runbooks/scripts
- Hardening harness covering deterministic replay, keeper/monitor agreement, funding interval behavior, and bad-debt alert validation
- Load/chaos harness covering high-volume event replay, tx submission failure mode, and alert storms
- Testnet/mainnet deployment manifests, wasm hash manifest template, mainnet readiness runbook, and Soroban footprint baseline
- architecture/security docs and CI skeleton

The old frontend is untouched.

## Production Caveat

The runtime is dependency-light and offline-testable in this workspace. Live
mainnet operation still requires wiring these primitives to managed Stellar RPC,
durable database storage, signer/HSM infrastructure, real HTTP/WebSocket
process supervision, and measured Soroban footprint budgets.
