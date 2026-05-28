// Server-side only (Node.js / Next.js server components) — NOT "use client"
// Builds and simulates the settle_fill transaction, extracts auth entries.

import {
  Keypair,
  Account,
  Contract,
  TransactionBuilder,
  Transaction,
  Address,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK } from "../config";

const FEE = "500000";

// ── ScVal helpers for #[contracttype] structs ──────────────────────────────
// Soroban encodes contracttype structs as sorted ScvMap (alphabetical key order).

function mapEntry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

function i128Val(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function u64Val(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

function u32Val(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "u32" });
}

function boolVal(b: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(b);
}

function addrVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

// Order struct (alphabetical field order: expiry_ts, is_long, limit_price,
//               market_id, nonce, owner, reduce_only, size)
function orderToScVal(o: {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
}): xdr.ScVal {
  return xdr.ScVal.scvMap([
    mapEntry("expiry_ts",   u64Val(o.expiryTs)),
    mapEntry("is_long",     boolVal(o.isLong)),
    mapEntry("limit_price", i128Val(o.limitPrice)),
    mapEntry("market_id",   u32Val(o.marketId)),
    mapEntry("nonce",       u64Val(o.nonce)),
    mapEntry("owner",       addrVal(o.owner)),
    mapEntry("reduce_only", boolVal(o.reduceOnly)),
    mapEntry("size",        i128Val(o.size)),
  ]);
}

// MatchedFill struct (alphabetical: fill_price, fill_size, maker, taker)
function matchedFillToScVal(fill: {
  maker: Parameters<typeof orderToScVal>[0];
  taker: Parameters<typeof orderToScVal>[0];
  fillSize: bigint;
  fillPrice: bigint;
}): xdr.ScVal {
  return xdr.ScVal.scvMap([
    mapEntry("fill_price", i128Val(fill.fillPrice)),
    mapEntry("fill_size",  i128Val(fill.fillSize)),
    mapEntry("maker",      orderToScVal(fill.maker)),
    mapEntry("taker",      orderToScVal(fill.taker)),
  ]);
}

// ── Settlement simulation ──────────────────────────────────────────────────

export interface PendingSettlement {
  fillHash:         string;
  makerAddress:     string;
  takerAddress:     string;
  /** Base64 XDR of the unsigned maker SorobanAuthorizationEntry */
  makerAuthXdr:     string;
  /** Base64 XDR of the unsigned taker SorobanAuthorizationEntry */
  takerAuthXdr:     string;
  /** Base64 XDR of the assembled (soroban-data-set) unsigned transaction */
  assembledTxXdr:   string;
  fillPrice:        string;
  fillSize:         string;
  marketId:         number;
}

export async function simulateSettleFill(fill: {
  maker: {
    owner: string; marketId: number; isLong: boolean;
    size: bigint; limitPrice: bigint; reduceOnly: boolean;
    nonce: bigint; expiryTs: bigint;
  };
  taker: {
    owner: string; marketId: number; isLong: boolean;
    size: bigint; limitPrice: bigint; reduceOnly: boolean;
    nonce: bigint; expiryTs: bigint;
  };
  fillSize: bigint;
  fillPrice: bigint;
  fillHash: string;
  feePayerSecret: string;
}): Promise<PendingSettlement | null> {
  try {
    const server   = new sorobanRpc.Server(NETWORK.rpcUrl);
    const feeKp    = Keypair.fromSecret(fill.feePayerSecret);
    const account  = await server.getAccount(feeKp.publicKey());
    const contract = new Contract(CONTRACTS.orderGateway);

    const fillArg = matchedFillToScVal(fill);

    const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
      .addOperation(contract.call("settle_fill", fillArg))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      console.error("settle_fill sim error:", (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error?.slice(0, 200));
      return null;
    }

    const success = sim as sorobanRpc.Api.SimulateTransactionSuccessResponse;
    const authEntries = success.result?.auth ?? [];

    if (authEntries.length < 2) {
      console.error(`settle_fill sim: expected 2 auth entries, got ${authEntries.length}`);
      return null;
    }

    // Determine which entry belongs to maker vs taker by inspecting the
    // credentials address field
    let makerEntry: xdr.SorobanAuthorizationEntry | null = null;
    let takerEntry: xdr.SorobanAuthorizationEntry | null = null;

    for (const entry of authEntries) {
      try {
        const creds = entry.credentials();
        if (creds.switch().name !== "sorobanCredentialsAddress") continue;
        const addr = Address.fromScAddress(
          creds.address().address()
        ).toString();
        if (addr === fill.maker.owner) makerEntry = entry;
        else if (addr === fill.taker.owner) takerEntry = entry;
      } catch { /* skip */ }
    }

    if (!makerEntry || !takerEntry) {
      // Fallback: assign by position
      makerEntry = authEntries[0];
      takerEntry = authEntries[1];
    }

    // Assemble the tx to get the correct soroban resource fee + footprint
    const assembled = sorobanRpc.assembleTransaction(tx, sim).build();

    return {
      fillHash:       fill.fillHash,
      makerAddress:   fill.maker.owner,
      takerAddress:   fill.taker.owner,
      makerAuthXdr:   makerEntry.toXDR("base64"),
      takerAuthXdr:   takerEntry.toXDR("base64"),
      assembledTxXdr: assembled.toXDR(),
      fillPrice:      fill.fillPrice.toString(),
      fillSize:       fill.fillSize.toString(),
      marketId:       fill.maker.marketId,
    };
  } catch (e) {
    console.error("simulateSettleFill error:", (e as Error).message?.slice(0, 200));
    return null;
  }
}

// ── Direct settlement submission (source-account auth only) ───────────────
//
// The order-gateway's settle_fill function uses SOROBAN_CREDENTIALS_SOURCE_ACCOUNT
// auth, meaning only the fee-payer's transaction signature is needed.
// No individual maker/taker Freighter auth entries are required.

export async function submitSettleFillDirect(fill: {
  maker: {
    owner: string; marketId: number; isLong: boolean;
    size: bigint; limitPrice: bigint; reduceOnly: boolean;
    nonce: bigint; expiryTs: bigint;
  };
  taker: {
    owner: string; marketId: number; isLong: boolean;
    size: bigint; limitPrice: bigint; reduceOnly: boolean;
    nonce: bigint; expiryTs: bigint;
  };
  fillSize: bigint;
  fillPrice: bigint;
  feePayerSecret: string;
}): Promise<{ hash: string } | { error: string }> {
  try {
    const server  = new sorobanRpc.Server(NETWORK.rpcUrl);
    const feeKp   = Keypair.fromSecret(fill.feePayerSecret);
    const account = await server.getAccount(feeKp.publicKey());
    const contract = new Contract(CONTRACTS.orderGateway);

    const fillArg = matchedFillToScVal(fill);

    const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
      .addOperation(contract.call("settle_fill", fillArg))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      const errMsg = (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error ?? "sim failed";
      return { error: errMsg.slice(0, 200) };
    }

    const assembled = sorobanRpc.assembleTransaction(tx, sim).build();
    assembled.sign(feeKp);

    const send = await server.sendTransaction(assembled);
    if (send.status === "ERROR") {
      return { error: send.errorResult?.toXDR("base64") ?? "submit error" };
    }

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") return { hash: send.hash };
      if (poll.status === "FAILED") return { error: "tx failed on-chain" };
    }
    return { error: "timeout waiting for confirmation" };
  } catch (e) {
    return { error: (e as Error).message?.slice(0, 200) ?? "unknown" };
  }
}
