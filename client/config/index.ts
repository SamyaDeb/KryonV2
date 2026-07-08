// Contract addresses and network config. Testnet is the local/dev default.
// Mainnet deployments must set NEXT_PUBLIC_STELLAR_NETWORK=mainnet plus every
// NEXT_PUBLIC_* contract/asset address below; otherwise the app fails fast.

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet";
const IS_MAINNET = STELLAR_NETWORK === "mainnet";

// Every NEXT_PUBLIC_* access below MUST be written as a literal
// `process.env.NEXT_PUBLIC_X` expression, not a parameterized/dynamic lookup
// (e.g. `process.env[key]`). Next.js's client-bundle inlining only replaces
// statically-analyzable literal expressions with their build-time value — a
// dynamic key defeats that, silently leaving `undefined` in the browser and
// falling through to the fallback regardless of what's actually configured.
// (Discovered 2026-07-08: the compiled client chunk still contained the
// testnet vault address after every Vercel-side env var was independently
// confirmed correct — the previous `envOrDefault(key, fallback)` helper used
// `process.env[key]`, which is exactly this anti-pattern.)
function assertPresentOnMainnet(key: string, value: string | undefined): void {
  if (IS_MAINNET && !value) throw new Error(`Missing ${key} for mainnet deployment`);
}

assertPresentOnMainnet("NEXT_PUBLIC_STELLAR_RPC_URL", process.env.NEXT_PUBLIC_STELLAR_RPC_URL);
assertPresentOnMainnet("NEXT_PUBLIC_STELLAR_PASSPHRASE", process.env.NEXT_PUBLIC_STELLAR_PASSPHRASE);
assertPresentOnMainnet("NEXT_PUBLIC_STELLAR_HORIZON_URL", process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL);
assertPresentOnMainnet("NEXT_PUBLIC_CONTRACT_GOVERNANCE", process.env.NEXT_PUBLIC_CONTRACT_GOVERNANCE);
assertPresentOnMainnet("NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER", process.env.NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER);
assertPresentOnMainnet("NEXT_PUBLIC_CONTRACT_VAULT", process.env.NEXT_PUBLIC_CONTRACT_VAULT);
assertPresentOnMainnet("NEXT_PUBLIC_CONTRACT_ENGINE", process.env.NEXT_PUBLIC_CONTRACT_ENGINE);
assertPresentOnMainnet("NEXT_PUBLIC_CONTRACT_ORDER_GATEWAY", process.env.NEXT_PUBLIC_CONTRACT_ORDER_GATEWAY);
assertPresentOnMainnet("NEXT_PUBLIC_CONTRACT_INSURANCE", process.env.NEXT_PUBLIC_CONTRACT_INSURANCE);
assertPresentOnMainnet("NEXT_PUBLIC_CONTRACT_LIQUIDATION", process.env.NEXT_PUBLIC_CONTRACT_LIQUIDATION);
assertPresentOnMainnet("NEXT_PUBLIC_CONTRACT_RISK", process.env.NEXT_PUBLIC_CONTRACT_RISK);
assertPresentOnMainnet("NEXT_PUBLIC_ASSET_NATIVE_XLM", process.env.NEXT_PUBLIC_ASSET_NATIVE_XLM);
assertPresentOnMainnet("NEXT_PUBLIC_ASSET_USDC", process.env.NEXT_PUBLIC_ASSET_USDC);
assertPresentOnMainnet("NEXT_PUBLIC_USDC_ISSUER", process.env.NEXT_PUBLIC_USDC_ISSUER);

export const NETWORK = {
  name: STELLAR_NETWORK,
  rpcUrl:
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL ??
    (IS_MAINNET ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org"),
  passphrase:
    process.env.NEXT_PUBLIC_STELLAR_PASSPHRASE ??
    (IS_MAINNET ? "Public Global Stellar Network ; September 2015" : "Test SDF Network ; September 2015"),
  horizonUrl:
    process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
    (IS_MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"),
} as const;

export const CONTRACTS = {
  governance: process.env.NEXT_PUBLIC_CONTRACT_GOVERNANCE ?? "CBZT5HUXI42TD55GGB5Y7OZZ72IT5SN64ONOGDYS2PFQCOWIT4XOA6MU",
  oracleAdapter: process.env.NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER ?? "CARSV4BT3II5QONUAOP4D363OUNTTSSZCXSKNNXKZCBJM7Z6UXSNZ3LP",
  vault: process.env.NEXT_PUBLIC_CONTRACT_VAULT ?? "CBQ6634Z3UPXFVVHHV2JNSGXHQOZZK62Z65HCAQTINBGXS3IDXKRTRYK",
  engine: process.env.NEXT_PUBLIC_CONTRACT_ENGINE ?? "CBSUYAO2EYAQVFISJQKG4TNMJPCDCPPFGI25Q3SW2BJPFSKQ45GRGTXN",
  orderGateway: process.env.NEXT_PUBLIC_CONTRACT_ORDER_GATEWAY ?? "CAJGC2SIV6DFJETJ6ATG5MR6RPNX5HQ26LYA4RGSHF2QPTBS6OJWONL3",
  insurance: process.env.NEXT_PUBLIC_CONTRACT_INSURANCE ?? "CA3VD55APWCYLVN7PYGJ7NPKSQBE3VU4MWVCSKLOYAZI5RFWWR76G2CL",
  liquidation: process.env.NEXT_PUBLIC_CONTRACT_LIQUIDATION ?? "CDCRNKXTTTOO7IRVC66KZR5QMVGGZIOF2QPJSVELLD7G7F4IVLM2DCMG",
  risk: process.env.NEXT_PUBLIC_CONTRACT_RISK ?? "CAVCW7XCQRA6VYWBKFDABYZGDNUJYHEYKHR4TT6BQBHS6QPDGFJVYBDS",
} as const;

export const ASSETS = {
  nativeXlm: process.env.NEXT_PUBLIC_ASSET_NATIVE_XLM ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  usdc: process.env.NEXT_PUBLIC_ASSET_USDC ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  usdcIssuer: process.env.NEXT_PUBLIC_USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
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
    maxLeverageBps: 100000, // 10x — 1/initialMarginBps; matches on-chain engine max_leverage_bps
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
    maxLeverageBps: 500000, // 50x — 1/initialMarginBps
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
    maxLeverageBps: 200000, // 20x — 1/initialMarginBps
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
