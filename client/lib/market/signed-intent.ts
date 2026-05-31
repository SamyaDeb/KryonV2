import { Keypair } from "@stellar/stellar-sdk";
export {
  assertU64,
  cancelSigningMessage,
  orderSigningMessage,
  type SignedCancelPayload,
  type SignedOrderPayload,
} from "./signing-message";

function decodeSignature(signature: string): Buffer | null {
  const s = signature.trim();
  try {
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
      return Buffer.from(s, "hex");
    }
    return Buffer.from(s, "base64");
  } catch {
    return null;
  }
}

export function verifySignedMessage(owner: string, message: string, signature: string): boolean {
  const sig = decodeSignature(signature);
  if (!sig || sig.length !== 64) return false;
  return Keypair.fromPublicKey(owner).verify(Buffer.from(message, "utf8"), sig);
}
