// Contract addresses and network config — mirrors kryon-protocol/infra/deploy/environments/testnet.toml

export const NETWORK = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
  horizonUrl: "https://horizon-testnet.stellar.org",
} as const;

export const CONTRACTS = {
  governance: "CCRI6YJYXHFTGALTDPYRNFSDFWMZRVSJ6WNC3NV5ECE3E7DG4SZ3TBQ5",
  oracleAdapter: "CDC342E2GSLQKPHNWOWYUKNMSBES2OOTRHKA7YZO77SCZEN6XDQ334MD",
  vault: "CAZV547ZY7S5IGGMYHDQWYM2TWAZ4MEJ6FJHWIJM7VF6GGXU3EUZ5ZOS",
  engine: "CCH7M3XXFEIR72YXKBXEQ2R3UCIJR7BWYQEI5VTKLE4YMZD5RJTBJ7PW",
  orderGateway: "CBEYHRUGPXI2E4BXCIBBSHKC2NZHARHCA52RCPKMSRK2QBADWUHDWUI3",
  insurance: "CD45VRVGRW6BWMTG4HYKVKFMTOCOHMFGUU226G4363HPIUSPLKPM54KT",
  liquidation: "CCIDLNMNP5AZL6IF5TJ75J3DXXVIONHHFVHLT36HHDCOZI24BK2VNRWK",
  risk: "CAHTRWX72D26VEVJFU3KKIVFVHQ2EV24UGU3LBO2DIQPBTCYG6G6LSW7",
} as const;

export const ASSETS = {
  nativeXlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
} as const;

export const MARKETS: Record<string, MarketConfig> = {
  "XLM-PERP": {
    marketId: 1,
    symbol: "XLM-PERP",
    displayName: "XLM-PERP",
    baseAsset: "XLM",
    quoteAsset: "USDC",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "COINBASE:XLMUSD",
    maxLeverageBps: 100000, // 10x
    initialMarginBps: 1000,  // 10%
    maintenanceMarginBps: 500, // 5%
    liquidationFeeBps: 50,
  },
  "BTC-PERP": {
    marketId: 2,
    symbol: "BTC-PERP",
    displayName: "BTC-PERP",
    baseAsset: "BTC",
    quoteAsset: "USDC",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "COINBASE:BTCUSD",
    maxLeverageBps: 500000, // 50x
    initialMarginBps: 200,   // 2%
    maintenanceMarginBps: 100, // 1%
    liquidationFeeBps: 25,
  },
  "ETH-PERP": {
    marketId: 3,
    symbol: "ETH-PERP",
    displayName: "ETH-PERP",
    baseAsset: "ETH",
    quoteAsset: "USDC",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "COINBASE:ETHUSD",
    maxLeverageBps: 200000, // 20x
    initialMarginBps: 500,   // 5%
    maintenanceMarginBps: 250, // 2.5%
    liquidationFeeBps: 35,
  },
};

export interface MarketConfig {
  marketId: number;
  symbol: string;
  displayName: string;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string;
  tvSymbol: string;
  maxLeverageBps: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  liquidationFeeBps: number;
}

// Precision: oracle prices and PnL values use 1e18 scale; USDC amounts use 1e7 (Stellar stroop-equivalent)
export const PRICE_PRECISION = BigInt("1000000000000000000"); // 1e18
export const AMOUNT_PRECISION = BigInt("10000000"); // 1e7 (Stellar 7 decimal places)
export const BPS_PRECISION = 10000;

export const MATCHER_URL =
  process.env.NEXT_PUBLIC_MATCHER_URL ?? "";

export const INDEXER_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL ?? "";

export const STELLAR_EXPERT_URL =
  "https://stellar.expert/explorer/testnet";
