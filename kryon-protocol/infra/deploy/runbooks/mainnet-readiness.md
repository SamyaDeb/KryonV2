# Mainnet Readiness Runbook

## Required Gates

- All contracts built with `cargo build --workspace --release`.
- `cargo test --workspace` passes.
- `cargo clippy --workspace --all-targets -- -D warnings` passes.
- Wasm hashes match `infra/deploy/manifest.example.toml`.
- Governance admin is a multisig, not an individual hot key.
- Guardian key is separate from governance admin.
- Oracle quorum publishers are independent operators.
- Keeper dry run shows no missed funding or liquidation jobs.
- Monitoring canary confirms stale oracle and bad debt alerts fire.
- External audit issues are either fixed or explicitly accepted by governance.

## Launch Sequence

1. Upload contract Wasm.
2. Deploy governance.
3. Deploy oracle, vault, engine, insurance, liquidation, gateway, and risk contracts.
4. Initialize contracts with the approved deployment signer, nominate governance as pending admin on every contract, and accept admin from the governance-controlled signer before enabling markets.
5. Wire contract addresses.
6. Configure collateral, markets, oracle publishers, fee recipient, and funding config.
7. Transfer operational authority to governance.
8. Queue first governance no-op proposal to validate timelock operation.
9. Start indexer in replay-only mode.
10. Start oracle, funding, and liquidation keepers with transaction submission disabled.
11. Enable transaction submission after simulated state matches RPC state.

## Abort Conditions

- Any stale oracle alert during launch.
- Any account health mismatch between indexer and contract state.
- Any failed settlement transaction outside expected duplicate/replay protection.
- Any bad debt before public launch.
- Any contract footprint regression above the approved budget.
