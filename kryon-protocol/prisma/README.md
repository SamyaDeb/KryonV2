# Prisma / Postgres Persistence

This schema is the production persistence boundary for the matcher, indexer,
keepers, deployment registry, transaction queue, and audit package.

Amounts use strings instead of JavaScript `number` or database floats. That is
intentional: protocol values are signed fixed-point integers and must round-trip
exactly with 18-decimal precision.

## Neon Setup

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` and `DIRECT_URL` to your Neon Postgres connection string.
3. Run:

```bash
npm install
npm run db:generate
npm run db:migrate:deploy
```

For local schema iteration, use `npm run db:migrate:dev`. For early testnet
without migrations, `npm run db:push` is acceptable, but do not use `db push`
for mainnet schema changes.

## Operational Rules

- `ProtocolEvent.replayKey` must be deterministic and unique per
  `(network, ledger, tx_hash, topic, event_index)`.
- `LedgerCursor` updates must happen in the same database transaction as event
  inserts.
- `TxJob` rows are idempotent by `(network, kind, payloadHash)`.
- Do not store private keys, seeds, KMS plaintext material, or bearer tokens.
