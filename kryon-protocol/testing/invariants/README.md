# Invariant Test Plan

The invariant suite must run against pure crates and Soroban contract tests.

Required invariants:

- post-withdraw equity is never below initial margin
- liquidatable accounts always have equity below maintenance
- non-liquidatable accounts cannot produce liquidation plans
- total realized PnL equals trader balance deltas plus SLP/insurance deltas
- funding payments are antisymmetric between long and short sides
- oracle stale/confidence violations reject state transitions
- no account can create negative collateral through rounding

The first executable invariant lives in `risk-engine` tests:
`withdrawal_uses_unrealized_loss_not_locked_margin`.

Additional executable coverage now lives in `testing/hardening`:

- deterministic replay produces identical reconstructed API state
- stale oracle keeper decisions align with monitoring alerts
- funding keepers respect minimum update intervals
- invalid negative bad-debt metrics are rejected

Remaining mainnet-grade hardening work:

- add property-based tests for arbitrary order/fill streams
- add Soroban budget/footprint regression tests for every contract path
- add multi-account liquidation simulations under fast price moves
- add chaos tests for stale oracle, failed settlement submission, and keeper restarts

`testing/load-chaos` now covers deterministic 512-event replay, over-retried
transaction submission, and alert storms. It is intentionally deterministic so
CI failures can be reproduced exactly.
