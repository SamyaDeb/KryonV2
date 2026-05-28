import { simulateSettleFill } from "@/lib/stellar/settlement";
const now = BigInt(Math.floor(Date.now()/1000));
simulateSettleFill({
  maker: { owner:"GA3SSO6D4YL5W6NDCO5V72BN5PHXC3SOBRAFMDSMUOM7OTXY2S6UAUHF", marketId:1, isLong:true, size:100000000n, limitPrice:210000000000000000n, reduceOnly:false, nonce:BigInt(Date.now()), expiryTs:now+3600n },
  taker: { owner:"GBTL7SKBHYAROO5CYGTQ4ITTEPTUUPIXDFDYZNDNAYQJ4J5XENX4TGDI", marketId:1, isLong:false, size:100000000n, limitPrice:209500000000000000n, reduceOnly:false, nonce:BigInt(Date.now()+1), expiryTs:now+3600n },
  fillSize:100000000n, fillPrice:210000000000000000n,
  fillHash:"test-sim-hash-001",
  feePayerSecret:process.env.ORACLE_PUBLISHER_SECRET!
}).then(r => {
  if (r) { console.log("✓ SUCCESS makerAuth:", r.makerAuthXdr.slice(0,20)+"..."); }
  else { console.log("✗ returned null"); }
  process.exit(0);
}).catch(e => { console.error("ERROR:", e.message); process.exit(1); });
