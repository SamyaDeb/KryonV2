# E2E Tests

These tests run against production-shaped infrastructure:

- `db-smoke.mjs` verifies Prisma/Postgres persistence, exact fixed-point string
  round-trips, ledger cursors, protocol events, fills, and tx jobs.
- `testnet-preflight.mjs` verifies Stellar testnet RPC reachability and refuses
  to run with a non-testnet passphrase.

Run:

```bash
npm run e2e
```

Required environment:

```bash
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."
STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

The tests intentionally do not delete rows. E2E records are tagged with
`testnet-e2e` and unique `e2e-*` identifiers so they remain auditable.
