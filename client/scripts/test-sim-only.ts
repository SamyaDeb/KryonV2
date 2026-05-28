import { simulateSettleFill } from "@/lib/stellar/settlement";
const now = BigInt(Math.floor(Date.now()/1000));
simulateSettleFill({
  maker: { owner:"GA3SSO6D4YL5W6NDCO5V72BN5PHXC3SOBRAFMDSMUOM7OTXY2S6UAUHF", marketId:1, isLong:true, size:10000000n, limitPrice:210000000000000000n, reduceOnly:false, nonce:BigInt(Date.now()), expiryTs:now+3600n },
  taker: { owner:"GB325VGSL6L6SCQDZOSRJPCD63HYJ6M5WD7K45Y6CSKZONUXKYYENQHR", marketId:1, isLong:false, size:10000000n, limitPrice:209500000000000000n, reduceOnly:false, nonce:BigInt(Date.now()+1), expiryTs:now+3600n },
  fillSize: 10000000n, fillPrice: 210000000000000000n,
  fillHash: "usdc-sim-final",
  feePayerSecret: process.env.ORACLE_PUBLISHER_SECRET!,
}).then(r => {
  if (r) {
    console.log("✅  settle_fill simulation SUCCEEDED — USDC settlement confirmed");
    console.log("    makerAuthXdr:", r.makerAuthXdr.slice(0,60)+"...");
    console.log("    takerAuthXdr:", r.takerAuthXdr.slice(0,60)+"...");
    console.log("    assembledTx :", r.assembledTxXdr.slice(0,50)+"...");
    console.log("\n    Both Freighter auth entries are generated and ready to sign.");
  } else {
    console.log("✗ null");
  }
  process.exit(0);
}).catch(e => { console.error("❌", e.message); process.exit(1); });
