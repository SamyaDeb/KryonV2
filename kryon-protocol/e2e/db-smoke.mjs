import { PrismaClient } from "@prisma/client";
import { loadEnv, requiredEnv } from "./env.mjs";

loadEnv();
requiredEnv("DATABASE_URL");

const prisma = new PrismaClient();
const runId = `e2e-${Date.now()}`;
const marketId = 1;
const maker = `${runId}-maker`;
const taker = `${runId}-taker`;

async function main() {
  await prisma.$transaction(async (tx) => {
    await tx.market.upsert({
      where: { id: marketId },
      update: {
        symbol: "XLM-PERP",
        settlementAsset: "USDC",
        active: false,
      },
      create: {
        id: marketId,
        symbol: "XLM-PERP",
        settlementAsset: "USDC",
        active: false,
      },
    });

    await tx.account.createMany({
      data: [
        { address: maker, collateral: { USDC: "1000000000000000000000" } },
        { address: taker, collateral: { USDC: "1000000000000000000000" } },
      ],
      skipDuplicates: true,
    });

    await tx.ledgerCursor.upsert({
      where: {
        network_contractId: {
          network: "testnet-e2e",
          contractId: "e2e",
        },
      },
      update: {
        ledger: 1,
        cursor: runId,
      },
      create: {
        id: runId,
        network: "testnet-e2e",
        contractId: "e2e",
        ledger: 1,
        cursor: runId,
      },
    });

    await tx.protocolEvent.create({
      data: {
        network: "testnet-e2e",
        ledger: 1,
        txHash: runId,
        topic: "e2e.fill",
        replayKey: `${runId}:fill:0`,
        payload: {
          marketId,
          maker,
          taker,
          fillSize: "1000000000000000000",
          fillPrice: "100000000000000000000",
        },
      },
    });

    await tx.fill.create({
      data: {
        network: "testnet-e2e",
        marketId,
        maker,
        makerNonce: BigInt(1),
        taker,
        takerNonce: BigInt(2),
        fillSize: "1000000000000000000",
        fillPrice: "100000000000000000000",
        txHash: runId,
        ledger: 1,
      },
    });

    await tx.txJob.create({
      data: {
        network: "testnet-e2e",
        kind: "e2e-smoke",
        payloadHash: runId,
        status: "QUEUED",
      },
    });
  });

  const event = await prisma.protocolEvent.findUnique({
    where: { replayKey: `${runId}:fill:0` },
  });
  if (!event) {
    throw new Error("E2E protocol event did not round-trip");
  }

  const fill = await prisma.fill.findFirst({
    where: { txHash: runId, marketId },
  });
  if (!fill || fill.fillSize !== "1000000000000000000") {
    throw new Error("E2E fill did not round-trip with exact fixed-point string");
  }

  console.log(`db-smoke ok: ${runId}`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
