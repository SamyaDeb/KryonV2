import { xdr, Address, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

export function addressToScVal(addr: string): xdr.ScVal {
  return Address.fromString(addr).toScVal();
}

export function u32ToScVal(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "u32" });
}

export function u64ToScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

export function i128ToScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

export function boolToScVal(b: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(b);
}

export function scValToI128(val: xdr.ScVal): bigint {
  return BigInt(scValToNative(val) as string | number | bigint);
}

export function scValToU32(val: xdr.ScVal): number {
  return Number(scValToNative(val));
}

export function scValToAddress(val: xdr.ScVal): string {
  return Address.fromScVal(val).toString();
}

export function scValToBool(val: xdr.ScVal): boolean {
  return Boolean(scValToNative(val));
}
