import { Keypair, hash } from "@stellar/stellar-sdk";
export {
  assertU64,
  cancelSigningMessage,
  orderSigningMessage,
  type SignedCancelPayload,
  type SignedOrderPayload,
} from "./signing-message";

// SEP-53 message-signing prefix. Freighter (and other SEP-53 wallets) sign
// sha256(SEP53_PREFIX || message) rather than the raw message bytes.
const SEP53_PREFIX = "Stellar Signed Message:\n";

function decodeSignature(signature: string): Buffer | null {
  const s = signature.trim();
  try {
    // base64 first — Freighter returns the 64-byte signature as base64. Only
    // treat as hex when it can't be valid base64 of a 64-byte sig (128 hex
    // chars) to avoid a base64 string that happens to be all hex chars.
    if (/^[0-9a-fA-F]{128}$/.test(s)) {
      return Buffer.from(s, "hex");
    }
    return Buffer.from(s, "base64");
  } catch {
    return null;
  }
}

/**
 * Verify an ed25519 message signature against the owner's public key.
 *
 * Accepts the three encodings we actually produce:
 *   1. raw message bytes      — CLI test scripts call `keypair.sign(msg)` directly
 *   2. sha256(message)        — defensive fallback for non-SEP-53 signers
 *   3. SEP-53: sha256(prefix + message) — Freighter / browser wallets
 */
export function verifySignedMessage(owner: string, message: string, signature: string): boolean {
  const sig = decodeSignature(signature);
  if (!sig || sig.length !== 64) {
    console.warn(
      `verifySignedMessage: bad signature length (got ${sig ? sig.length : "null"}, expected 64)`
    );
    return false;
  }

  let kp: Keypair;
  try {
    kp = Keypair.fromPublicKey(owner);
  } catch {
    return false;
  }

  const rawBytes = Buffer.from(message, "utf8");
  const candidates: Array<[string, Buffer]> = [
    ["raw", rawBytes],
    ["sha256", hash(rawBytes)],
    ["sep53", hash(Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), rawBytes]))],
  ];

  for (const [, payload] of candidates) {
    if (kp.verify(payload, sig)) return true;
  }

  console.warn(
    `verifySignedMessage: no scheme matched for ${owner.slice(0, 8)}… ` +
      `(sigLen=${sig.length}, msgLen=${rawBytes.length})`
  );
  return false;
}
