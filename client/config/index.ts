// Contract addresses and network config. Testnet is the local/dev default.
// Mainnet deployments must set NEXT_PUBLIC_STELLAR_NETWORK=mainnet plus every
// NEXT_PUBLIC_* contract/asset address below; otherwise the app fails fast.

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet";
const IS_MAINNET = STELLAR_NETWORK === "mainnet";

function envOrDefault(key: string, fallback: string): string {
  const value = process.env[key];
  if (IS_MAINNET && !value) {
    throw new Error(`Missing ${key} for mainnet deployment`);
  }
  return value ?? fallback;
}

export const NETWORK = {
  name: STELLAR_NETWORK,
  rpcUrl: envOrDefault(
    "NEXT_PUBLIC_STELLAR_RPC_URL",
    IS_MAINNET ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org"
  ),
  passphrase: envOrDefault(
    "NEXT_PUBLIC_STELLAR_PASSPHRASE",
    IS_MAINNET ? "Public Global Stellar Network ; September 2015" : "Test SDF Network ; September 2015"
  ),
  horizonUrl: envOrDefault(
    "NEXT_PUBLIC_STELLAR_HORIZON_URL",
    IS_MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"
  ),
} as const;

export const CONTRACTS = {
  governance: envOrDefault("NEXT_PUBLIC_CONTRACT_GOVERNANCE", "CCRI6YJYXHFTGALTDPYRNFSDFWMZRVSJ6WNC3NV5ECE3E7DG4SZ3TBQ5"),
  oracleAdapter: envOrDefault("NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER", "CDC342E2GSLQKPHNWOWYUKNMSBES2OOTRHKA7YZO77SCZEN6XDQ334MD"),
  vault: envOrDefault("NEXT_PUBLIC_CONTRACT_VAULT", "CAZV547ZY7S5IGGMYHDQWYM2TWAZ4MEJ6FJHWIJM7VF6GGXU3EUZ5ZOS"),
  engine: envOrDefault("NEXT_PUBLIC_CONTRACT_ENGINE", "CCH7M3XXFEIR72YXKBXEQ2R3UCIJR7BWYQEI5VTKLE4YMZD5RJTBJ7PW"),
  orderGateway: envOrDefault("NEXT_PUBLIC_CONTRACT_ORDER_GATEWAY", "CAJBG4UXO35MXA2CZ4RZ6M32PHMEWBLQ4V2BBHD7XMKLKEQA56C5TAW4"),
  insurance: envOrDefault("NEXT_PUBLIC_CONTRACT_INSURANCE", "CD45VRVGRW6BWMTG4HYKVKFMTOCOHMFGUU226G4363HPIUSPLKPM54KT"),
  liquidation: envOrDefault("NEXT_PUBLIC_CONTRACT_LIQUIDATION", "CCIDLNMNP5AZL6IF5TJ75J3DXXVIONHHFVHLT36HHDCOZI24BK2VNRWK"),
  risk: envOrDefault("NEXT_PUBLIC_CONTRACT_RISK", "CAHTRWX72D26VEVJFU3KKIVFVHQ2EV24UGU3LBO2DIQPBTCYG6G6LSW7"),
} as const;

export const ASSETS = {
  nativeXlm: envOrDefault("NEXT_PUBLIC_ASSET_NATIVE_XLM", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"),
  usdc: envOrDefault("NEXT_PUBLIC_ASSET_USDC", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"),
  usdcIssuer: envOrDefault("NEXT_PUBLIC_USDC_ISSUER", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
} as const;

export const MARKETS: Record<string, MarketConfig> = {
  "XLM-PERP": {
    marketId: 1,
    symbol: "XLM-PERP",
    displayName: "XLM-PERP",
    baseAsset: "XLM",
    quoteAsset: "USDC",
    oracleSymbol: "XLM",
    priceSourceSymbol: "XLMUSDT",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "COINBASE:XLMUSD",
    maxLeverageBps: 2000000, // 200x
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
    oracleSymbol: "BTC",
    priceSourceSymbol: "BTCUSDT",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "COINBASE:BTCUSD",
    maxLeverageBps: 2000000, // 200x
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
    oracleSymbol: "ETH",
    priceSourceSymbol: "ETHUSDT",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "COINBASE:ETHUSD",
    maxLeverageBps: 2000000, // 200x
    initialMarginBps: 500,   // 5%
    maintenanceMarginBps: 250, // 2.5%
    liquidationFeeBps: 35,
  },
};

function parseActiveMarketSymbols(raw: string | undefined): string[] {
  const symbols = (raw ?? "XLM-PERP")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  const unique = Array.from(new Set(symbols));
  const unknown = unique.filter((symbol) => !(symbol in MARKETS));
  if (unknown.length > 0) {
    throw new Error(`Unknown active market(s): ${unknown.join(", ")}`);
  }
  if (unique.length === 0) {
    throw new Error("NEXT_PUBLIC_ACTIVE_MARKETS must include at least one market");
  }
  return unique;
}

export const ACTIVE_MARKET_SYMBOLS = parseActiveMarketSymbols(process.env.NEXT_PUBLIC_ACTIVE_MARKETS);

export const ACTIVE_MARKETS: Record<string, MarketConfig> = Object.fromEntries(
  ACTIVE_MARKET_SYMBOLS.map((symbol) => [symbol, MARKETS[symbol]])
);
export const DEFAULT_MARKET_SYMBOL = ACTIVE_MARKET_SYMBOLS[0];
export const DEFAULT_MARKET = ACTIVE_MARKETS[DEFAULT_MARKET_SYMBOL];

export interface MarketConfig {
  marketId: number;
  symbol: string;
  displayName: string;
  baseAsset: string;
  quoteAsset: string;
  oracleSymbol: string;
  priceSourceSymbol: string;
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

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "";

export const STELLAR_EXPERT_URL =
  IS_MAINNET ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
