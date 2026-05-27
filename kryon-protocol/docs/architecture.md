# Stellar-Native Architecture

## Why The Legacy Architecture Was Rejected

The legacy implementation split perp, risk, funding, vault, CLOB, and SLP into
separate contracts, but allowed critical invariants to cross module boundaries
without an atomic source of truth. Examples:

- withdrawals checked stored locked margin instead of current equity
- funding compared oracle mark to oracle index and therefore did not move
- liquidations operated on one position while account health was cross-margin
- CLOB settlement accepted midpoint fills without oracle-band enforcement
- SLP NAV could diverge from custody

Those are not patch-level issues. They are solvency model failures.

## New Boundaries

```text
crates/protocol-core
  deterministic math, account snapshots, oracle snapshots, market config,
  position types, collateral accounting

crates/risk-engine
  pure no-IO calculations: account health, withdrawal validation,
  liquidation planning, funding index update

contracts/perp-risk
  thin Soroban boundary that stores market snapshots and delegates all
  calculations to risk-engine

contracts/perp-oracle-adapter
  guarded price adapter. Authorized publishers write either a single-source
  normalized snapshot or a quorum snapshot. All writes reject replayed publish
  times. Quorum writes require unique source publishers, an odd quorum of at
  least three sources, medianize provider prices, reject wide source deviation,
  and validate source publish time plus write time before storage.

contracts/perp-vault
  SEP-41 collateral custody. Deposits transfer real Stellar assets into the
  contract, balances are tracked internally, and withdrawals are blocked unless
  account health remains above initial margin using engine-synced positions.

contracts/perp-engine
  position lifecycle and settlement boundary. It opens, increases, reduces, and
  closes normal positions only through the configured order gateway and inside
  configured oracle execution bands, tracks open interest by side, updates
  funding indexes from market imbalance, realizes funding before position
  mutation, charges maker/taker fees through an authorized collector, rechecks
  post-fee initial margin before crediting protocol fees, realizes PnL into the
  vault, and syncs the vault's protocol-owned position snapshot.

contracts/perp-insurance
  backstop collateral custody. It accepts funded deposits, pays capped
  liquidation rewards through the authorized liquidation contract, and records
  explicit bad debt instead of hiding insolvency inside vault math.

contracts/perp-liquidation
  account-health liquidation executor. It rejects healthy accounts, calls the
  engine's authorized force-reduce path, verifies that liquidation reduces risk,
  pays capped rewards from insurance, and records negative-equity bad debt.

contracts/perp-order-gateway
  matched-fill settlement boundary. Off-chain matchers submit maker/taker order
  intents, while the contract enforces auth, expiry, cancellation, nonce fill
  accounting, side/price validity, self-trade prevention, and settlement through
  the engine. Maker/taker fees are charged by calling the engine after fill
  validation, so the matcher cannot bypass fee accounting.

contracts/perp-governance
  Stellar-native governance control plane. It queues proposal metadata with a
  minimum execution delay, records target/action/wasm hash, supports
  cancellation, and exposes a guardian emergency pause registry. The contract
  deliberately records and gates governance intent; production deployment
  scripts execute target-specific admin calls only after the timelock matures.

crates/order-types
  shared order and matched-fill models used by the off-chain matcher and the
  on-chain settlement gateway shape.

services/matcher
  deterministic in-memory CLOB core. It keeps price-time priority, produces
  gateway-compatible fills, handles cancels/replaces/market orders/expiry, and
  never touches custody or position state directly.

services/oracle-keeper
  deterministic provider quote normalization. It converts provider-native
  integer price/exponent pairs into protocol `PRECISION` units before calling
  the Soroban oracle adapter's quorum publisher path.

services/indexer-api
  deterministic event replay and API view models. It reconstructs market
  volume, fills by nonce, account positions, funding indexes, oracle state, and
  bad debt from protocol events.

services/keepers
  keeper decision engine for stale oracle publication, funding updates, and
  liquidation candidates. It is pure Rust so daemon implementations can be
  replayed and tested without network side effects.

services/monitoring
  alert evaluation for runtime and oracle risk signals, including settlement
  failures, liquidation backlog, matcher queue depth, bad debt, and stale feeds.

services/node-runtime
  operational runtime primitives. It exposes HTTP health/metrics/market routes,
  an append-only event store, deterministic RPC event replay ingestion, and a
  retry-aware transaction queue. Live deployments should replace the in-memory
  store and replay source with database and Stellar RPC adapters while keeping
  the same deterministic state transitions.
```

The rule is deliberate: protocol-critical math is pure Rust first, with Soroban
contracts acting as explicit authentication and storage boundaries.

## Soroban-Native Design Principles

- Use Stellar account authorization directly through `Address::require_auth`.
- Keep hot storage keyed and bounded; avoid market-wide scans in contract paths.
- Prefer pure calculation crates that can be fuzzed outside the host.
- Treat transaction simulation as a first-class preflight, not a security layer.
- Use Stellar assets through SEP-41 token contracts and reconcile internal
  accounting against actual token custody.
- Minimize cross-contract call depth on liquidation and withdrawal paths.

## Target Production Modules

```text
contracts/
  perp-account/      account state, deposits, withdrawals, subaccounts
  perp-governance/   timelock registry and emergency pause control
  perp-engine/       market config, OI, position ledger, settlement
  perp-insurance/    reward funding, bad debt, backstop accounting
  perp-liquidation/  account-health liquidation execution
  perp-order-gateway/ signed order settlement and replay protection
  perp-risk/         account health, withdrawals, liquidation planning
  perp-oracle-adapter/ normalized Reflector/Pyth/quorum snapshots and circuit breakers
  perp-vault/        collateral custody, risk-gated withdrawals, vault reconciliation
  perp-settlement/   PnL, fees, SLP/insurance waterfall

services/
  matcher/           off-chain order matching with on-chain verification
  liquidator/        account scanner with deterministic liquidation hints
  matcher-api/       API/WebSocket wrapper around services/matcher with
                     persistence and settlement submission
  oracle-keeper/     quorum price publisher and stale-feed alerts
  keepers/           funding, liquidation, and oracle keeper decisions
  indexer/           event sink, state reconstruction, API
  monitoring/        metrics and alert evaluation
  node-runtime/      HTTP/API routes, RPC ingestion, tx queue, persistence adapters

sdk/
  rust/
  typescript/
```

This rebuild now has the shared core, pure risk engine, risk contract boundary,
quorum-capable guarded oracle adapter, collateral vault, fee/funding-aware
position engine, insurance fund, liquidation executor, on-chain matched-order
settlement gateway, governance timelock registry, deterministic matcher core,
oracle quote normalization service, indexer/API state views, keeper decision
logic, monitoring alerts, node runtime primitives, deployment manifests,
load/chaos simulations, and executable hardening checks. Production daemon
processes still need live Stellar RPC, database, signer, and process-manager
adapters for the target environment.
