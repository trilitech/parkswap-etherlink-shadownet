import { getAddress, isAddress } from "ethers";

/**
 * Default deployment: Etherlink Shadownet.
 * Override any value with `NEXT_PUBLIC_*` — see `.env.example`.
 */

function envTrim(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

function parseAddressEnv(key: string, fallback: string): `0x${string}` {
  const raw = envTrim(key);
  if (raw && isAddress(raw)) return getAddress(raw) as `0x${string}`;
  return getAddress(fallback) as `0x${string}`;
}

function parseOptionalAddressEnv(key: string): `0x${string}` | null {
  const raw = envTrim(key);
  if (!raw || !isAddress(raw)) return null;
  return getAddress(raw) as `0x${string}`;
}

function parsePositiveIntEnv(key: string, fallback: number): number {
  const raw = envTrim(key);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseChainId(): number {
  return parsePositiveIntEnv("NEXT_PUBLIC_CHAIN_ID", 127823);
}

function chainIdToHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

/** Etherlink Shadownet defaults for this standalone deployment. */
const DEFAULT_SWAP_ROUTER = "0xEF1d06d1dA6074136b3fA588D16265aB3e328823";
const DEFAULT_QUOTER_V2 = "0x8DE864210ebD4aD09B5D70d5992F7Ab79fb8D031";
const DEFAULT_POSITION_MANAGER = "0x9d6e607fdcdf1c31df6C5dA59fC3786Cbe474EaD";
const DEFAULT_FACTORY = "0xE40476E6ED2B62ecBDac9e2e5EEc8b402c24Bd15";

const DEFAULT_USDC = "0xE5131B396a18aB7d3D9716A06114cEC9EDEF9879";
const DEFAULT_XU3O8 = "0x556172039d9D854FE3B900267375DBebf48A1bf0";
const DEFAULT_VNXAU = "0xFABF9A6DbD6548958E93fe94dfAA2fd6e009cD82";

const DEFAULT_BLOCK_EXPLORER = "https://shadownet.explorer.etherlink.com";
const DEFAULT_RPC = "https://node.shadownet.etherlink.com";

const DEFAULT_FEATURED_POOL = "0x1c97bFFf8CCD5576a87C826f1845c0806Ac3Ae7E";
const DEFAULT_POOL_USDC_XU3O8 = "0x1c97bFFf8CCD5576a87C826f1845c0806Ac3Ae7E";
const DEFAULT_POOL_USDC_VNXAU = "0x613FF83eA2303f4226F188d796cbFFc9b2562506";

export type DexChainErc20Meta = {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
};

export type DexChainConfig = {
  chainId: number;
  chainIdHex: string;
  rpcUrl: string;
  blockExplorerDefaultUrl: string;
  /** Shown when the wallet chain matches `chainId` (header, labels). */
  networkDisplayName: string;
  /** `chainName` passed to `wallet_addEthereumChain`. */
  walletAddEthereumChainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  contracts: {
    swapRouter: `0x${string}`;
    quoterV2: `0x${string}`;
    positionManager: `0x${string}`;
    factory: `0x${string}`;
  };
  tokens: {
    usdc: DexChainErc20Meta;
    xu3o8: DexChainErc20Meta;
    vnxau: DexChainErc20Meta | null;
  };
  pools: Array<{
    key: string;
    label: string;
    poolAddress: `0x${string}`;
    tokenA: DexChainErc20Meta;
    tokenB: DexChainErc20Meta;
  }>;
  /** Optional pinned pool for dashboard price + `getFeaturedPool` shortcut; omit on new chains until deployed. */
  featuredPoolAddress: `0x${string}` | null;
};

function buildDexChainConfig(): DexChainConfig {
  const chainId = parseChainId();
  const chainIdHex = envTrim("NEXT_PUBLIC_CHAIN_ID_HEX") ?? chainIdToHex(chainId);

  const usdcDecimals = parsePositiveIntEnv("NEXT_PUBLIC_TOKEN_USDC_DECIMALS", 6);
  const xu3o8Decimals = parsePositiveIntEnv("NEXT_PUBLIC_TOKEN_XU3O8_DECIMALS", 18);
  const vnxauDecimals = parsePositiveIntEnv("NEXT_PUBLIC_TOKEN_VNXAU_DECIMALS", 18);
  const explicitVnxauAddr =
    parseOptionalAddressEnv("NEXT_PUBLIC_VNXAU_TOKEN_ADDRESS") ??
    parseOptionalAddressEnv("NEXT_PUBLIC_TOKEN_VNXAU_ADDRESS");
  const vnxauAddr = explicitVnxauAddr ?? (getAddress(DEFAULT_VNXAU) as `0x${string}`);

  const explicitPool =
    parseOptionalAddressEnv("NEXT_PUBLIC_FEATURED_POOL_ADDRESS") ??
    parseOptionalAddressEnv("NEXT_PUBLIC_DASHBOARD_POOL_ADDRESS");
  const featuredPool: `0x${string}` | null =
    explicitPool ?? (getAddress(DEFAULT_FEATURED_POOL) as `0x${string}`);

  const usdcToken = {
    address: parseAddressEnv("NEXT_PUBLIC_TOKEN_USDC_ADDRESS", DEFAULT_USDC),
    symbol: envTrim("NEXT_PUBLIC_TOKEN_USDC_SYMBOL") ?? "USDC",
    name: envTrim("NEXT_PUBLIC_TOKEN_USDC_NAME") ?? "USD Coin",
    decimals: usdcDecimals,
  } satisfies DexChainErc20Meta;

  const xu3o8Token = {
    address: parseAddressEnv("NEXT_PUBLIC_TOKEN_XU3O8_ADDRESS", DEFAULT_XU3O8),
    symbol: envTrim("NEXT_PUBLIC_TOKEN_XU3O8_SYMBOL") ?? "xU3O8",
    name: envTrim("NEXT_PUBLIC_TOKEN_XU3O8_NAME") ?? "xU3O8",
    decimals: xu3o8Decimals,
  } satisfies DexChainErc20Meta;

  const vnxauToken = vnxauAddr
    ? ({
        address: vnxauAddr,
        symbol: envTrim("NEXT_PUBLIC_TOKEN_VNXAU_SYMBOL") ?? "VNXAU",
        name: envTrim("NEXT_PUBLIC_TOKEN_VNXAU_NAME") ?? "VNX Gold",
        decimals: vnxauDecimals,
      } satisfies DexChainErc20Meta)
    : null;

  const configuredPools: DexChainConfig["pools"] = [];
  const poolUsdcXu3o8 =
    parseOptionalAddressEnv("NEXT_PUBLIC_POOL_USDC_XU3O8_ADDRESS") ??
    featuredPool ??
    (getAddress(DEFAULT_POOL_USDC_XU3O8) as `0x${string}`);
  if (poolUsdcXu3o8) {
    configuredPools.push({
      key: "usdc-xu3o8",
      label: `${usdcToken.symbol} / ${xu3o8Token.symbol}`,
      poolAddress: poolUsdcXu3o8,
      tokenA: usdcToken,
      tokenB: xu3o8Token,
    });
  }
  const poolUsdcVnxau =
    parseOptionalAddressEnv("NEXT_PUBLIC_POOL_USDC_VNXAU_ADDRESS") ??
    (getAddress(DEFAULT_POOL_USDC_VNXAU) as `0x${string}`);
  if (poolUsdcVnxau && vnxauToken) {
    configuredPools.push({
      key: "usdc-vnxau",
      label: `${usdcToken.symbol} / ${vnxauToken.symbol}`,
      poolAddress: poolUsdcVnxau,
      tokenA: usdcToken,
      tokenB: vnxauToken,
    });
  }

  return {
    chainId,
    chainIdHex,
    rpcUrl: envTrim("NEXT_PUBLIC_RPC_URL") ?? DEFAULT_RPC,
    blockExplorerDefaultUrl: envTrim("NEXT_PUBLIC_BLOCK_EXPLORER_URL") ?? DEFAULT_BLOCK_EXPLORER,
    networkDisplayName: envTrim("NEXT_PUBLIC_NETWORK_DISPLAY_NAME") ?? "Etherlink Shadownet",
    walletAddEthereumChainName: envTrim("NEXT_PUBLIC_WALLET_CHAIN_NAME") ?? "ParkSwap",
    nativeCurrency: {
      name: envTrim("NEXT_PUBLIC_NATIVE_CURRENCY_NAME") ?? "TXP",
      symbol: envTrim("NEXT_PUBLIC_NATIVE_CURRENCY_SYMBOL") ?? "TXP",
      decimals: parsePositiveIntEnv("NEXT_PUBLIC_NATIVE_CURRENCY_DECIMALS", 18),
    },
    contracts: {
      swapRouter: parseAddressEnv("NEXT_PUBLIC_SWAP_ROUTER_ADDRESS", DEFAULT_SWAP_ROUTER),
      quoterV2: parseAddressEnv("NEXT_PUBLIC_QUOTER_V2_ADDRESS", DEFAULT_QUOTER_V2),
      positionManager: parseAddressEnv("NEXT_PUBLIC_POSITION_MANAGER_ADDRESS", DEFAULT_POSITION_MANAGER),
      factory: parseAddressEnv("NEXT_PUBLIC_V3_FACTORY_ADDRESS", DEFAULT_FACTORY),
    },
    tokens: {
      usdc: usdcToken,
      xu3o8: xu3o8Token,
      vnxau: vnxauToken,
    },
    pools: configuredPools,
    featuredPoolAddress: featuredPool,
  };
}

export const dexChainConfig: DexChainConfig = buildDexChainConfig();

export function walletChainLabel(chainId: number | null): string {
  if (chainId === null) return "Unknown";
  if (chainId === dexChainConfig.chainId) return dexChainConfig.networkDisplayName;
  return `Chain ${chainId}`;
}

export function configuredNetworkMismatchMessage(): string {
  return `Could not switch to ${dexChainConfig.networkDisplayName}. Please change network in your wallet.`;
}
