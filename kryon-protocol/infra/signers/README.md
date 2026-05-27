# Managed Signers

No production service should hold a raw Stellar secret key in process memory.

Supported signer boundary in `services/node-runtime`:

- `Kms`
- `Vault`
- `Fireblocks`
- `LocalDev`

Production rules:

- `LocalDev` is only for local/testnet smoke runs.
- Keeper, oracle publisher, deployer, and governance signers must be separate.
- Transaction payloads must be signed with explicit network passphrase binding.
- Every submitted payload must be recorded in `TxJob` before signing.
- Failed submissions must remain queryable for incident review.

Required environment:

```bash
SIGNER_PROVIDER="kms"
SIGNER_ACCOUNT="G..."
KMS_KEY_ID="..."
```

Alternative providers can use:

```bash
VAULT_TRANSIT_KEY="..."
FIREBLOCKS_VAULT_ACCOUNT_ID="..."
```
