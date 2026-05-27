# Fuzz Testing Plan

Fuzz targets to add after the core state transition contracts land:

- fixed-point arithmetic boundary values
- account health over random collateral and position portfolios
- withdrawal attempts after adversarial price moves
- liquidation plan monotonicity
- funding index updates under skew oscillation
- CLOB fill validation against oracle bands

The pure crates are intentionally no-IO so they can be fuzzed outside Soroban.

Implemented adjacent coverage:

- `testing/hardening` has executable deterministic invariant checks.
- `testing/load-chaos` has replay/load and failure-mode simulations.

Next upgrade is adding `proptest` or coverage-guided fuzz targets once
dependency installation is available in the environment.
