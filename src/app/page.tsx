"use client";

import { BrowserProvider, Contract, ContractFactory, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AttributionBanner } from "@/components/AttributionBanner";
import { CryptoIconPicker } from "@/components/CryptoIconPicker";
import { LiquiditySection } from "@/components/LiquiditySection";
import { ParkSwapLogo } from "@/components/ParkSwapLogo";
import { SwapPanel } from "@/components/SwapPanel";
import { WalletTokenIcon } from "@/components/WalletTokenIcon";
import { cryptoIconSvgUrl } from "@/lib/cryptoicons";
import { ETHERLINK_SHADOWNET_FAUCET_URL } from "@/lib/site-metadata";
import { configurableTokenArtifact } from "@/lib/configurable-token-artifact";
import {
  FEATURED_TOKENS,
  TXPARK_CHAIN_ID,
  TXPARK_HEX_CHAIN_ID,
  TXPARK_RPC_URL,
  configuredNetworkMismatchMessage,
  dexChainConfig,
  txparkExplorerTxUrl,
  erc20Abi,
  normalizeAddress,
  poolAbi,
  sameAddress,
  txparkExplorerAddressUrl,
  type TokenConfig,
  type WriteAction,
} from "@/lib/txpark";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type WalletState = {
  account: string | null;
  chainId: number | null;
  isCorrectNetwork: boolean;
};

type PoolState = {
  key: string;
  label: string;
  poolAddress: string;
  tokenA: TokenConfig;
  tokenB: TokenConfig;
  primaryPrice: number | null;
  inversePrice: number | null;
  displayBaseSymbol: string;
  displayQuoteSymbol: string;
  displayPrice: number | null;
  liquidity: string | null;
  tokenABalance: bigint | null;
  tokenBBalance: bigint | null;
};

type DeployedTokenRecord = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: string;
  iconName: string;
  /** Contract creation transaction. */
  txHash: string | null;
};

const publicProvider = new JsonRpcProvider(TXPARK_RPC_URL, TXPARK_CHAIN_ID, {
  batchMaxCount: 1,
  staticNetwork: true,
});

const DEPLOYED_TOKENS_STORAGE_KEY = "parkswap-deployed-tokens-v1";

function loadDeployedTokensFromStorage(): DeployedTokenRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(DEPLOYED_TOKENS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is DeployedTokenRecord =>
          Boolean(x) &&
          typeof x === "object" &&
          typeof (x as DeployedTokenRecord).address === "string" &&
          typeof (x as DeployedTokenRecord).symbol === "string" &&
          typeof (x as DeployedTokenRecord).name === "string",
      )
      .map((x) => ({
        ...x,
        txHash: typeof x.txHash === "string" ? x.txHash : null,
      }));
  } catch {
    return [];
  }
}

function persistDeployedTokens(tokens: DeployedTokenRecord[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DEPLOYED_TOKENS_STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    /* ignore quota */
  }
}

function deployedRecordToTokenConfig(record: DeployedTokenRecord): TokenConfig {
  const address = normalizeAddress(record.address);
  return {
    key: address.toLowerCase(),
    address,
    symbol: record.symbol,
    name: record.name,
    decimals: record.decimals,
    isImported: true,
  };
}
function getEthereumProvider() {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as Window & { ethereum?: EthereumProvider }).ethereum ?? null;
}

function shortenAddress(value: string | null) {
  if (!value) return "Not connected";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortenTxHash(hash: string) {
  if (!hash || hash.length < 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function formatBalance(value: bigint | null, decimals: number, fractionDigits = 4) {
  if (value === null) return "0";
  const formatted = Number(formatUnits(value, decimals));
  if (!Number.isFinite(formatted)) return "0";
  return formatted.toLocaleString(undefined, {
    maximumFractionDigits: fractionDigits,
  });
}

function formatPoolMetric(value: number | null, fractionDigits = 6) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "--";
  if (value < 10 ** -fractionDigits) {
    return `< ${Number(10 ** -fractionDigits).toFixed(fractionDigits)}`;
  }
  return value.toLocaleString(undefined, {
    maximumFractionDigits: fractionDigits,
  });
}

function getPairPriceFromSqrtPrice(sqrtPriceX96: bigint, tokenA: TokenConfig, tokenB: TokenConfig) {
  const q192 = 2n ** 192n;
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96;
  const rawRatio = Number(ratioX192) / Number(q192);
  const [token0, token1] = tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  const token1PerToken0 = rawRatio * 10 ** (token0.decimals - token1.decimals);
  if (!Number.isFinite(token1PerToken0) || token1PerToken0 <= 0) {
    return { primaryPrice: null, inversePrice: null };
  }

  const tokenBPerTokenA =
    tokenA.address.toLowerCase() === token0.address.toLowerCase() ? token1PerToken0 : 1 / token1PerToken0;
  if (!Number.isFinite(tokenBPerTokenA) || tokenBPerTokenA <= 0) {
    return { primaryPrice: null, inversePrice: null };
  }

  return {
    primaryPrice: tokenBPerTokenA,
    inversePrice: 1 / tokenBPerTokenA,
  };
}

function getReadablePoolQuote(tokenA: TokenConfig, tokenB: TokenConfig, primaryPrice: number | null, inversePrice: number | null) {
  if (primaryPrice === null || inversePrice === null) {
    return {
      displayBaseSymbol: tokenB.symbol,
      displayQuoteSymbol: tokenA.symbol,
      displayPrice: null,
    };
  }

  // For USDC-paired pools, show the asset price in USDC.
  if (tokenA.symbol === "USDC") {
    return {
      displayBaseSymbol: tokenB.symbol,
      displayQuoteSymbol: tokenA.symbol,
      displayPrice: inversePrice,
    };
  }

  if (tokenB.symbol === "USDC") {
    return {
      displayBaseSymbol: tokenA.symbol,
      displayQuoteSymbol: tokenB.symbol,
      displayPrice: primaryPrice,
    };
  }

  if (primaryPrice >= 1 || inversePrice < 1) {
    return {
      displayBaseSymbol: tokenB.symbol,
      displayQuoteSymbol: tokenA.symbol,
      displayPrice: primaryPrice,
    };
  }

  return {
    displayBaseSymbol: tokenA.symbol,
    displayQuoteSymbol: tokenB.symbol,
    displayPrice: inversePrice,
  };
}

const configuredPools = dexChainConfig.pools.map((pool) => ({
  key: pool.key,
  label: pool.label,
  poolAddress: pool.poolAddress,
  tokenA: {
    key: pool.tokenA.symbol.toLowerCase(),
    address: pool.tokenA.address,
    symbol: pool.tokenA.symbol,
    name: pool.tokenA.name,
    decimals: pool.tokenA.decimals,
  } satisfies TokenConfig,
  tokenB: {
    key: pool.tokenB.symbol.toLowerCase(),
    address: pool.tokenB.address,
    symbol: pool.tokenB.symbol,
    name: pool.tokenB.name,
    decimals: pool.tokenB.decimals,
  } satisfies TokenConfig,
}));

function getReadableErrorMessage(error: unknown) {
  if (!error) {
    return "Something went wrong. Please try again.";
  }

  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message)
      : "";

  if (code === "4001" || code === "ACTION_REJECTED" || /user denied|user rejected|rejected/i.test(message)) {
    return "Transaction cancelled in wallet.";
  }

  if (/insufficient funds/i.test(message)) {
    return "Insufficient funds for this transaction.";
  }

  if (/wallet not available/i.test(message)) {
    return "No wallet detected. Open the app in MetaMask or another injected wallet.";
  }

  if (/network switch failed/i.test(message)) {
    return configuredNetworkMismatchMessage();
  }

  return message || "Something went wrong. Please try again.";
}

async function readPoolState(poolConfig: (typeof configuredPools)[number]) {
  const pool = new Contract(poolConfig.poolAddress, poolAbi, publicProvider);
  const tokenAContract = new Contract(poolConfig.tokenA.address, erc20Abi, publicProvider);
  const tokenBContract = new Contract(poolConfig.tokenB.address, erc20Abi, publicProvider);
  const [slot0Result, liquidityResult, tokenABalanceResult, tokenBBalanceResult] = await Promise.allSettled([
    pool.slot0(),
    pool.liquidity(),
    tokenAContract.balanceOf(poolConfig.poolAddress),
    tokenBContract.balanceOf(poolConfig.poolAddress),
  ]);

  if (slot0Result.status === "rejected") {
    console.error(`Failed to read slot0 for ${poolConfig.label}`, slot0Result.reason);
  }
  if (liquidityResult.status === "rejected") {
    console.error(`Failed to read liquidity for ${poolConfig.label}`, liquidityResult.reason);
  }
  if (tokenABalanceResult.status === "rejected") {
    console.error(`Failed to read ${poolConfig.tokenA.symbol} balance for ${poolConfig.label}`, tokenABalanceResult.reason);
  }
  if (tokenBBalanceResult.status === "rejected") {
    console.error(`Failed to read ${poolConfig.tokenB.symbol} balance for ${poolConfig.label}`, tokenBBalanceResult.reason);
  }

  const price =
    slot0Result.status === "fulfilled"
      ? getPairPriceFromSqrtPrice(slot0Result.value.sqrtPriceX96 as bigint, poolConfig.tokenA, poolConfig.tokenB)
      : { primaryPrice: null, inversePrice: null };
  const readableQuote = getReadablePoolQuote(
    poolConfig.tokenA,
    poolConfig.tokenB,
    price.primaryPrice,
    price.inversePrice,
  );

  return {
    ...poolConfig,
    primaryPrice: price.primaryPrice,
    inversePrice: price.inversePrice,
    displayBaseSymbol: readableQuote.displayBaseSymbol,
    displayQuoteSymbol: readableQuote.displayQuoteSymbol,
    displayPrice: readableQuote.displayPrice,
    liquidity: liquidityResult.status === "fulfilled" ? liquidityResult.value.toString() : null,
    tokenABalance: tokenABalanceResult.status === "fulfilled" ? (tokenABalanceResult.value as bigint) : null,
    tokenBBalance: tokenBBalanceResult.status === "fulfilled" ? (tokenBBalanceResult.value as bigint) : null,
  } satisfies PoolState;
}

async function readBalancesForMerged(account: string, tokens: TokenConfig[]) {
  const out: Record<string, bigint> = {};
  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const c = new Contract(token.address, erc20Abi, publicProvider);
      const balance = (await c.balanceOf(account)) as bigint;
      return { key: token.key, balance, address: token.address, symbol: token.symbol };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      out[result.value.key] = result.value.balance;
    } else {
      console.error("Failed to read token balance", result.reason);
    }
  }
  return out;
}

export default function Home() {
  const [activeView, setActiveView] = useState<"trade" | "wallet" | "pool" | "liquidity" | "create" | "recent-tokens" | "faucet">(
    "trade",
  );
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  const [wallet, setWallet] = useState<WalletState>({
    account: null,
    chainId: null,
    isCorrectNetwork: false,
  });
  const [balancesByKey, setBalancesByKey] = useState<Record<string, bigint | null>>({});
  const [poolStates, setPoolStates] = useState<PoolState[]>([]);
  const [createTokenName, setCreateTokenName] = useState("");
  const [createTokenSymbol, setCreateTokenSymbol] = useState("");
  const [createTokenDecimals, setCreateTokenDecimals] = useState("18");
  const [createTokenSupply, setCreateTokenSupply] = useState("1000000");
  /** Cryptofonts cryptoicons SVG basename (no `.svg`), e.g. `btc`, `eth`. */
  const [createTokenIconName, setCreateTokenIconName] = useState("xtz");
  const [importedTokens, setImportedTokens] = useState<TokenConfig[]>([]);
  const [deployedTokens, setDeployedTokens] = useState<DeployedTokenRecord[]>([]);
  const [recentlyDeployedToken, setRecentlyDeployedToken] = useState<DeployedTokenRecord | null>(null);
  const [liquidityPresetImportAddress, setLiquidityPresetImportAddress] = useState<string | null>(null);
  const [liquidityPresetPair, setLiquidityPresetPair] = useState<{
    tokenAKey: string;
    tokenBKey: string;
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<WriteAction | null>(null);
  const [faucetPending, setFaucetPending] = useState(false);
  const [faucetResult, setFaucetResult] = useState<Array<{ symbol: string; txHash: string }> | null>(null);

  const deployedAsTokenConfig = useMemo(() => deployedTokens.map(deployedRecordToTokenConfig), [deployedTokens]);

  const mergedTokens = useMemo(() => {
    const m = new Map<string, TokenConfig>();
    const featuredAddr = new Set(Object.values(FEATURED_TOKENS).map((t) => t.address.toLowerCase()));
    for (const t of Object.values(FEATURED_TOKENS)) {
      m.set(t.address.toLowerCase(), t);
    }
    for (const t of importedTokens) {
      if (featuredAddr.has(t.address.toLowerCase())) continue;
      m.set(t.address.toLowerCase(), t);
    }
    for (const t of deployedAsTokenConfig) {
      if (featuredAddr.has(t.address.toLowerCase())) continue;
      m.set(t.address.toLowerCase(), t);
    }
    return [...m.values()];
  }, [importedTokens, deployedAsTokenConfig]);

  const importedAddresses = useMemo(
    () => new Set(mergedTokens.map((t) => t.address.toLowerCase())),
    [mergedTokens],
  );

  const deployedAddresses = useMemo(
    () => new Set(deployedTokens.map((d) => d.address.toLowerCase())),
    [deployedTokens],
  );

  const refreshWalletState = useCallback(async () => {
    const ethereum = getEthereumProvider();
    if (!ethereum) return;

    const accounts = (await ethereum.request({ method: "eth_accounts" })) as string[];
    const chainIdHex = (await ethereum.request({ method: "eth_chainId" })) as string;
    const account = accounts[0] ?? null;
    const chainId = Number.parseInt(chainIdHex, 16);

    setWallet({
      account,
      chainId,
      isCorrectNetwork: chainId === TXPARK_CHAIN_ID,
    });
  }, []);

  const refreshReadState = useCallback(async (account?: string | null) => {
    const [poolResult, balancesResult] = await Promise.allSettled([
      Promise.all(configuredPools.map(readPoolState)),
      account ? readBalancesForMerged(account, mergedTokens) : Promise.resolve({} as Record<string, bigint>),
    ]);

    if (poolResult.status === "fulfilled") {
      setPoolStates(poolResult.value);
    } else {
      setPoolStates([]);
      console.error("Failed to read pool state", poolResult.reason);
    }

    if (account) {
      if (balancesResult.status === "fulfilled") {
        const withKeys: Record<string, bigint | null> = {};
        for (const t of mergedTokens) {
          withKeys[t.key] = balancesResult.value[t.key] ?? 0n;
        }
        setBalancesByKey(withKeys);
      } else {
        console.error("Failed to read token balances", balancesResult.reason);
        throw balancesResult.reason;
      }
    } else {
      setBalancesByKey({});
    }
  }, [mergedTokens]);

  async function requestConfiguredNetworkSwitch(ethereum: EthereumProvider) {
    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: TXPARK_HEX_CHAIN_ID }],
      });
      return true;
    } catch (error) {
      try {
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: TXPARK_HEX_CHAIN_ID,
              chainName: dexChainConfig.walletAddEthereumChainName,
              rpcUrls: [TXPARK_RPC_URL],
              nativeCurrency: dexChainConfig.nativeCurrency,
            },
          ],
        });
        return true;
      } catch (innerError) {
        toast.error(getReadableErrorMessage(innerError ?? error));
        return false;
      }
    }
  }

  async function connectWallet() {
    const ethereum = getEthereumProvider();
    if (!ethereum) {
      toast.error("No wallet detected. Open the app in MetaMask or Rabby.");
      return;
    }

    try {
      await ethereum.request({ method: "eth_requestAccounts" });
      const switched = await requestConfiguredNetworkSwitch(ethereum);
      await refreshWalletState();
      setAccountMenuOpen(false);
      if (!switched) return;
      toast.success(`Wallet connected to ${dexChainConfig.networkDisplayName}`);
    } catch (error) {
      toast.error(getReadableErrorMessage(error));
    }
  }

  async function disconnectWallet() {
    const ethereum = getEthereumProvider();
    if (ethereum) {
      try {
        await ethereum.request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        });
      } catch {
        // Some injected wallets don't support permission revocation; still clear local app state below.
      }
    }
    setWallet({
      account: null,
      chainId: null,
      isCorrectNetwork: false,
    });
    setBalancesByKey({});
    setAccountMenuOpen(false);
    toast.success("Wallet disconnected");
  }

  async function claimFaucet() {
    if (!wallet.account) {
      toast.error("Connect your wallet before claiming faucet tokens.");
      return;
    }
    setFaucetPending(true);
    setFaucetResult(null);
    toast.loading("Sending 5 USDC, 5 xU3O8, and 5 VNXAU...", { id: "faucet-claim" });

    try {
      const response = await fetch("/api/faucet/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet.account }),
      });

      const payload = (await response.json()) as
        | { error?: string; transfers?: Array<{ symbol: string; txHash: string }> }
        | undefined;

      if (!response.ok || !payload?.transfers) {
        throw new Error(payload?.error || "Faucet request failed.");
      }

      setFaucetResult(payload.transfers);
      await refreshReadState(wallet.account);
      toast.success("Faucet transfer confirmed.", { id: "faucet-claim" });
    } catch (error) {
      toast.error(getReadableErrorMessage(error), { id: "faucet-claim" });
    } finally {
      setFaucetPending(false);
    }
  }

  async function switchToParkSwap() {
    const ethereum = getEthereumProvider();
    if (!ethereum) return;

    const switched = await requestConfiguredNetworkSwitch(ethereum);
    if (!switched) return;

    await refreshWalletState();
    toast.success(`Switched to ${dexChainConfig.networkDisplayName}`);
  }

  async function withSigner<T>(callback: (provider: BrowserProvider) => Promise<T>) {
    const ethereum = getEthereumProvider();
    if (!ethereum) throw new Error("Wallet not available");
    const browserProvider = new BrowserProvider(ethereum);
    return callback(browserProvider);
  }

  async function handleCreateToken() {
    if (!wallet.isCorrectNetwork) {
      toast.error(`Switch to ${dexChainConfig.networkDisplayName} before creating a token.`);
      return;
    }

    const trimmedName = createTokenName.trim();
    const trimmedSymbol = createTokenSymbol.trim();
    const decimals = Number(createTokenDecimals);

    if (!trimmedName || !trimmedSymbol) {
      toast.error("Enter a token name and symbol.");
      return;
    }

    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      toast.error("Decimals must be a whole number between 0 and 18.");
      return;
    }

    let initialSupply;
    try {
      initialSupply = parseUnits(createTokenSupply || "0", decimals);
    } catch {
      toast.error("Enter a valid initial supply.");
      return;
    }

    setPendingAction("create-token");
    toast.loading(`Deploying ${trimmedSymbol}...`, { id: "create-token" });

    try {
      let deployedAddress = "";
      let deployTxHash: string | null = null;
      await withSigner(async (browserProvider) => {
        const signer = await browserProvider.getSigner();
        const owner = await signer.getAddress();
        const factory = new ContractFactory(
          configurableTokenArtifact.abi,
          configurableTokenArtifact.bytecode,
          signer,
        );
        const contract = await factory.deploy(trimmedName, trimmedSymbol, decimals, initialSupply, owner);
        deployTxHash = contract.deploymentTransaction()?.hash ?? null;
        await contract.waitForDeployment();
        deployedAddress = await contract.getAddress();
      });

      const deployedToken: DeployedTokenRecord = {
        address: deployedAddress,
        name: trimmedName,
        symbol: trimmedSymbol,
        decimals,
        supply: createTokenSupply,
        iconName: createTokenIconName,
        txHash: deployTxHash,
      };

      setDeployedTokens((current) => {
        const deduped = current.filter((t) => t.address.toLowerCase() !== deployedToken.address.toLowerCase());
        const next = [deployedToken, ...deduped];
        persistDeployedTokens(next);
        return next;
      });
      setRecentlyDeployedToken(deployedToken);
      setCreateTokenName("");
      setCreateTokenSymbol("");
      setCreateTokenDecimals("18");
      setCreateTokenSupply("1000000");
      setCreateTokenIconName("xtz");
      toast.success(`${trimmedSymbol} deployed`, { id: "create-token" });
    } catch (error) {
      toast.error(getReadableErrorMessage(error), { id: "create-token" });
    } finally {
      setPendingAction(null);
    }
  }

  useEffect(() => {
    setDeployedTokens(loadDeployedTokensFromStorage());
  }, []);

  useEffect(() => {
    refreshWalletState().catch(() => undefined);
    refreshReadState(null).catch(() => undefined);

    const ethereum = getEthereumProvider();
    if (!ethereum?.on) return;

    const handleAccountsChanged = () => {
      refreshWalletState().catch(() => undefined);
    };
    const handleChainChanged = () => {
      refreshWalletState().catch(() => undefined);
    };

    ethereum.on("accountsChanged", handleAccountsChanged);
    ethereum.on("chainChanged", handleChainChanged);

    return () => {
      ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
      ethereum.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [refreshReadState, refreshWalletState]);

  useEffect(() => {
    if (!wallet.account) {
      setBalancesByKey({});
      setAccountMenuOpen(false);
      return;
    }

    refreshReadState(wallet.account).catch((error) => {
      toast.error(getReadableErrorMessage(error));
    });
  }, [refreshReadState, wallet.account, wallet.chainId, mergedTokens]);

  useEffect(() => {
    if (!accountMenuOpen && !moreMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (accountMenuOpen && accountMenuRef.current && !accountMenuRef.current.contains(target)) {
        setAccountMenuOpen(false);
      }
      if (moreMenuOpen && moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [accountMenuOpen, moreMenuOpen]);

  return (
    <main className="min-h-screen bg-[#131313] text-white">
      <AttributionBanner />
      <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col px-5 py-4">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <ParkSwapLogo className="h-10 w-10 shrink-0" size={40} />
              <p className="text-3xl font-semibold tracking-tight text-white">ParkSwap</p>
            </div>
            <nav className="flex flex-wrap items-center gap-2 text-sm text-white/65">
              {[
                { key: "trade", label: "Trade" },
                { key: "wallet", label: "Wallet" },
                { key: "pool", label: "Pool" },
                { key: "liquidity", label: "Liquidity" },
                { key: "create", label: "Create Token" },
                { key: "recent-tokens", label: "Recent Tokens" },
                { key: "faucet", label: "Faucet" },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveView(item.key as typeof activeView)}
                  className={`rounded-full px-3 py-2 ${
                    activeView === item.key ? "text-white" : "text-white/65 hover:text-white"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <div ref={moreMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setMoreMenuOpen((open) => !open)}
                className={`rounded-full p-2 text-xl text-white/65 hover:bg-white/6 hover:text-white ${moreMenuOpen ? "bg-white/8 text-white" : ""}`}
                aria-expanded={moreMenuOpen}
                aria-haspopup="menu"
                aria-label="App menu"
              >
                ⋯
              </button>
              {moreMenuOpen && (
                <div className="absolute right-0 z-30 mt-2 w-[min(100vw-2rem,320px)] rounded-2xl border border-white/10 bg-[#1b1b1b] p-3 shadow-2xl">
                  <div className="space-y-3 rounded-xl border border-white/8 bg-[#202020] p-3 text-sm text-white/75">
                    <div className="flex items-start justify-between gap-3">
                      <span className="shrink-0 text-white/55">Connected account</span>
                      <span className="break-all text-right font-mono text-xs text-white/85">{shortenAddress(wallet.account)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-white/55">Network</span>
                      <span className="text-right text-xs text-white/85">
                        {wallet.account
                          ? wallet.isCorrectNetwork
                            ? dexChainConfig.networkDisplayName
                            : wallet.chainId
                              ? `Chain ${wallet.chainId}`
                              : "Unknown"
                          : "Not connected"}
                      </span>
                    </div>
                    <a
                      href={ETHERLINK_SHADOWNET_FAUCET_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex w-full items-center justify-center rounded-xl bg-white/10 px-3 py-2.5 text-sm font-semibold text-white hover:bg-white/15"
                    >
                      Get XTZ
                    </a>
                  </div>
                </div>
              )}
            </div>
            {wallet.account ? (
              <div ref={accountMenuRef} className="relative">
                <button
                  type="button"
                  onClick={wallet.isCorrectNetwork ? () => setAccountMenuOpen((open) => !open) : switchToParkSwap}
                  className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/85"
                >
                  {wallet.isCorrectNetwork ? shortenAddress(wallet.account) : `Switch to ${dexChainConfig.networkDisplayName}`}
                </button>
                {wallet.isCorrectNetwork && accountMenuOpen && (
                  <div className="absolute right-0 z-30 mt-2 min-w-[220px] rounded-2xl border border-white/10 bg-[#1b1b1b] p-2 shadow-2xl">
                    <div className="rounded-xl px-3 py-2 text-xs text-white/45">Connected account</div>
                    <div className="rounded-xl px-3 py-2 font-mono text-xs text-white/80">{wallet.account}</div>
                    <button
                      type="button"
                      onClick={disconnectWallet}
                      className="mt-1 w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-red-400 hover:bg-red-500/15 hover:text-red-300"
                    >
                      Disconnect wallet
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={connectWallet}
                className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/85"
              >
                Connect wallet
              </button>
            )}
          </div>
        </header>

        <section className="flex-1">
          <div className="flex min-h-[720px] items-start justify-center pt-6">
            {activeView === "trade" && (
              <div className="w-full max-w-[500px]">
                <div className="mb-3 flex items-center justify-between px-2">
                  <div className="flex items-center gap-2 rounded-full bg-[#232323] p-1 text-sm">
                    {["Swap", "Limit", "Buy", "Sell"].map((label, index) => (
                      <button
                        key={label}
                        type="button"
                        className={`rounded-full px-4 py-2 ${index === 0 ? "bg-[#3a3a3a] text-white" : "text-white/55"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <SwapPanel
                  wallet={wallet}
                  mergedTokens={mergedTokens}
                  deployedAddresses={deployedAddresses}
                  deployedTokensOrdered={deployedAsTokenConfig}
                  importedAddresses={importedAddresses}
                  balancesByKey={balancesByKey}
                  onAddImportedToken={(token) => {
                    setImportedTokens((current) => {
                      if (current.some((existing) => sameAddress(existing.address, token.address))) return current;
                      return [...current, token];
                    });
                  }}
                  onOpenLiquidityWithPair={(args) => {
                    setLiquidityPresetPair(args);
                    setActiveView("liquidity");
                  }}
                  onRefreshBalances={() => refreshReadState(wallet.account)}
                />
              </div>
            )}

            {activeView === "wallet" && (
              <div className="w-full max-w-[500px] rounded-[30px] bg-[#191919] p-5">
                <p className="text-sm text-white/55">Wallet</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">Balances</h3>

                <div className="mt-5 space-y-3">
                  {mergedTokens.map((token) => (
                    <div key={token.key} className="rounded-[24px] border border-white/10 bg-black/25 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <WalletTokenIcon
                            token={token}
                            cryptoIconSlug={
                              deployedTokens.find((d) => sameAddress(d.address, token.address))?.iconName ?? null
                            }
                          />
                          <div className="min-w-0">
                            <p className="text-base font-semibold">{token.symbol}</p>
                            <p className="text-sm text-white/45">{token.name}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-base font-semibold">
                            {wallet.account ? formatBalance(balancesByKey[token.key] ?? null, token.decimals) : "0"}
                          </p>
                          <p className="text-sm text-white/45">{wallet.account ? "Wallet balance" : "Connect to load"}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeView === "pool" && (
              <div className="w-full max-w-5xl rounded-[30px] bg-[#191919] p-5">
                <p className="text-sm text-white/55">Pool</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">Configured pools</h3>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  {poolStates.map((pool) => (
                    <div key={pool.key} className="rounded-[24px] bg-black/20 p-4">
                      <p className="text-sm text-white/55">Pool</p>
                      <h4 className="mt-1 text-lg font-semibold tracking-tight">{pool.label}</h4>

                      <div className="mt-4 grid gap-3">
                        <div className="rounded-[20px] bg-black/20 p-4">
                          <p className="text-sm text-white/45">
                            1 {pool.displayBaseSymbol} in {pool.displayQuoteSymbol}
                          </p>
                          <p className="mt-2 text-[2rem] font-semibold tracking-tight">
                            {formatPoolMetric(pool.displayPrice, 4)}
                          </p>
                        </div>
                        <div className="rounded-[20px] bg-black/20 p-4">
                          <p className="text-sm text-white/45">Pool address</p>
                          <p className="mt-2 break-all font-mono text-sm font-medium leading-6 text-white/75">
                            {pool.poolAddress}
                          </p>
                        </div>
                        <div className="rounded-[20px] bg-black/20 p-4">
                          <p className="text-sm text-white/45">Current tokens in pool</p>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-[18px] border border-white/8 bg-black/20 p-3">
                              <p className="text-xs uppercase tracking-[0.18em] text-white/35">{pool.tokenA.symbol}</p>
                              <p className="mt-2 text-xl font-semibold">
                                {formatBalance(pool.tokenABalance, pool.tokenA.decimals, 4)}
                              </p>
                            </div>
                            <div className="rounded-[18px] border border-white/8 bg-black/20 p-3">
                              <p className="text-xs uppercase tracking-[0.18em] text-white/35">{pool.tokenB.symbol}</p>
                              <p className="mt-2 text-xl font-semibold">
                                {formatBalance(pool.tokenBBalance, pool.tokenB.decimals, 4)}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}

                  {poolStates.length === 0 && (
                    <div className="rounded-[24px] bg-black/20 p-4 text-sm text-white/45">
                      Add pool addresses in `.env.local` to show them here.
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeView === "liquidity" && (
              <div className="w-full max-w-[560px] rounded-[30px] bg-[#191919] p-5">
                <p className="text-sm text-white/55">Liquidity</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">Add or create liquidity</h3>
                <p className="mt-2 text-sm text-white/45">
                  Pick two tokens (pools use a fixed 0.25% fee). If no pool exists yet, you can{" "}
                  <button
                    type="button"
                    onClick={() => setActiveView("create")}
                    className="font-semibold text-white underline decoration-white/30 underline-offset-2 hover:decoration-white/60"
                  >
                    create one
                  </button>
                  , set the starting price, and deposit the first liquidity in one flow.
                </p>

                <div className="mt-6">
                  <LiquiditySection
                    wallet={{ account: wallet.account, isCorrectNetwork: wallet.isCorrectNetwork }}
                    importedTokens={importedTokens}
                    onAddImportedToken={(token) => {
                      setImportedTokens((current) => {
                        if (current.some((existing) => sameAddress(existing.address, token.address))) return current;
                        return [...current, token];
                      });
                    }}
                    presetImportAddress={liquidityPresetImportAddress}
                    onConsumedPresetImportAddress={() => setLiquidityPresetImportAddress(null)}
                    presetPairFromNav={liquidityPresetPair}
                    onConsumedPresetPairFromNav={() => setLiquidityPresetPair(null)}
                    onRefreshBalances={() => refreshReadState(wallet.account)}
                  />
                </div>
              </div>
            )}

            {activeView === "create" && (
              <div className="flex w-full max-w-5xl flex-col gap-10 lg:flex-row lg:items-start lg:justify-between">
                <div className="w-full min-w-0 max-w-[560px] rounded-[30px] bg-[#191919] p-5">
                  <p className="text-sm text-white/55">Create Token</p>
                  <h3 className="mt-1 text-xl font-semibold tracking-tight">
                    Deploy a new ERC-20 on {dexChainConfig.networkDisplayName}
                  </h3>
                  <p className="mt-2 text-sm text-white/45">
                    Create a token from your connected wallet with configurable name, symbol, decimals, supply, and app
                    icon.
                  </p>

                  <div className="mt-5 grid gap-4">
                    <label className="flex flex-col gap-2 text-sm text-white/70">
                      <span>Name</span>
                      <input
                        value={createTokenName}
                        onChange={(event) => setCreateTokenName(event.target.value)}
                        placeholder="Gold Token"
                        className="rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-white outline-none placeholder:text-white/25"
                      />
                    </label>

                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="flex flex-col gap-2 text-sm text-white/70">
                        <span>Symbol</span>
                        <input
                          value={createTokenSymbol}
                          onChange={(event) => setCreateTokenSymbol(event.target.value.toUpperCase())}
                          placeholder="GOLD"
                          className="rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-white outline-none placeholder:text-white/25"
                        />
                      </label>

                      <label className="flex flex-col gap-2 text-sm text-white/70">
                        <span>Decimals</span>
                        <input
                          value={createTokenDecimals}
                          onChange={(event) => setCreateTokenDecimals(event.target.value)}
                          inputMode="numeric"
                          className="rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-white outline-none placeholder:text-white/25"
                        />
                      </label>
                    </div>

                    <label className="flex flex-col gap-2 text-sm text-white/70">
                      <span>Initial supply</span>
                      <input
                        value={createTokenSupply}
                        onChange={(event) => setCreateTokenSupply(event.target.value)}
                        inputMode="decimal"
                        className="rounded-2xl border border-white/10 bg-[#222222] px-4 py-3 text-white outline-none placeholder:text-white/25"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm text-white/70">
                      <span>Select an Icon</span>
                      <p className="text-xs italic text-white/45">
                        Icons sourced from{" "}
                        <a
                          href="https://github.com/Cryptofonts/cryptoicons/tree/master/SVG"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white/55 underline decoration-white/20 underline-offset-2 hover:text-white/80"
                        >
                          Cryptoicons
                        </a>
                        .
                      </p>
                      <CryptoIconPicker value={createTokenIconName} onChange={setCreateTokenIconName} />
                    </label>
                  </div>

                  <div className="mt-6 rounded-[24px] border border-white/10 bg-black/20 p-4 text-sm text-white/70">
                    <p>
                      <span className="text-white/40">Name:</span> {createTokenName || "—"}
                    </p>
                    <p className="mt-2">
                      <span className="text-white/40">Symbol:</span> {createTokenSymbol || "—"}
                    </p>
                    <p className="mt-2">
                      <span className="text-white/40">Decimals:</span> {createTokenDecimals || "—"}
                    </p>
                    <p className="mt-2">
                      <span className="text-white/40">Initial supply:</span> {createTokenSupply || "—"}
                    </p>
                    <p className="mt-2 flex items-center gap-2">
                      <span className="text-white/40">Icon:</span>
                      {createTokenIconName ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={cryptoIconSvgUrl(createTokenIconName)}
                          alt=""
                          className="h-7 w-7 rounded-lg bg-white/10 object-contain p-0.5"
                        />
                      ) : null}
                      <span className="font-mono text-white/85">{createTokenIconName || "—"}</span>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleCreateToken}
                    disabled={!wallet.account || !wallet.isCorrectNetwork || pendingAction !== null}
                    className="mt-6 w-full rounded-[22px] bg-white px-4 py-4 text-base font-semibold text-black enabled:hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pendingAction === "create-token" ? "Deploying..." : "Create Token"}
                  </button>
                </div>

                {recentlyDeployedToken ? (
                  <aside className="flex w-full shrink-0 flex-col items-stretch lg:ml-auto lg:w-[min(100%,380px)] lg:items-end">
                    <div className="relative w-full max-w-[380px] rounded-[24px] border border-emerald-400/20 bg-emerald-400/10 p-5 pr-20">
                      {recentlyDeployedToken.iconName ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={cryptoIconSvgUrl(recentlyDeployedToken.iconName)}
                          alt=""
                          className="absolute right-4 top-4 h-12 w-12 rounded-xl bg-emerald-950/40 object-contain p-1"
                        />
                      ) : null}
                      <p className="text-sm font-medium text-emerald-100">Token deployed</p>
                      <p className="mt-3 text-lg font-semibold tracking-tight text-emerald-50">
                        {recentlyDeployedToken.symbol}
                      </p>
                      <p className="mt-1 text-sm text-emerald-50/85">{recentlyDeployedToken.name}</p>
                      <a
                        href={txparkExplorerAddressUrl(recentlyDeployedToken.address)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-block font-mono text-xs text-emerald-200/95 underline decoration-emerald-400/40 underline-offset-2 hover:text-emerald-100"
                      >
                        Contract on explorer
                      </a>
                      {recentlyDeployedToken.txHash ? (
                        <p className="mt-2">
                          <a
                            href={txparkExplorerTxUrl(recentlyDeployedToken.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-[11px] text-emerald-200/75 underline decoration-emerald-400/30 underline-offset-2 hover:text-emerald-100"
                          >
                            Deployment tx · {shortenTxHash(recentlyDeployedToken.txHash)}
                          </a>
                        </p>
                      ) : null}
                      <div className="mt-5 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            const t = deployedRecordToTokenConfig(recentlyDeployedToken);
                            setImportedTokens((current) => {
                              if (current.some((x) => sameAddress(x.address, t.address))) return current;
                              return [...current, t];
                            });
                            setLiquidityPresetImportAddress(recentlyDeployedToken.address);
                            setActiveView("liquidity");
                          }}
                          className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-black hover:bg-white/85"
                        >
                          Import token
                        </button>
                        <button
                          type="button"
                          onClick={() => setRecentlyDeployedToken(null)}
                          className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-medium text-white/75 hover:bg-white/5 hover:text-white"
                        >
                          Not now
                        </button>
                      </div>
                    </div>
                  </aside>
                ) : null}
              </div>
            )}

            {activeView === "faucet" && (
              <div className="w-full max-w-[560px] rounded-[30px] bg-[#191919] p-5">
                <p className="text-sm text-white/55">Faucet</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">Claim test tokens</h3>
                <p className="mt-2 text-sm text-white/45">
                  A connected wallet can receive an airdrop of <span className="font-semibold text-white">5 USDC</span>,{" "}
                  <span className="font-semibold text-white">5 xU3O8</span>, and{" "}
                  <span className="font-semibold text-white">5 VNXAU</span> from the project faucet wallet.
                </p>

                <div className="mt-6 rounded-[24px] border border-white/10 bg-black/20 p-4">
                  <p className="text-sm text-white/45">Recipient wallet</p>
                  <p className="mt-1 break-all font-mono text-sm text-white/85">
                    {wallet.account ?? "Connect wallet to claim"}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={claimFaucet}
                  disabled={!wallet.account || faucetPending}
                  className="mt-4 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black enabled:hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {faucetPending ? "Claiming..." : "Claim Airdrop"}
                </button>

                {faucetResult && (
                  <div className="mt-4 rounded-[24px] border border-emerald-400/20 bg-emerald-500/10 p-4">
                    <p className="text-sm font-semibold text-emerald-200">Faucet transfers sent</p>
                    <div className="mt-3 space-y-2">
                      {faucetResult.map((transfer) => (
                        <div key={transfer.txHash} className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-white/80">{transfer.symbol}</span>
                          <a
                            href={txparkExplorerTxUrl(transfer.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-emerald-200 hover:text-emerald-100"
                          >
                            {shortenTxHash(transfer.txHash)}
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeView === "recent-tokens" && (
              <div className="w-full max-w-2xl rounded-[30px] bg-[#191919] p-5">
                <p className="text-sm text-white/55">Recent Tokens</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight">Your deployed tokens</h3>
                <p className="mt-2 text-sm text-white/45">
                  A list of tokens you{"'"}ve deployed on ParkSwap recently.{" "}
                  <button
                    type="button"
                    onClick={() => setActiveView("create")}
                    className="font-bold text-white/85 hover:text-white"
                  >
                    Create Token
                  </button>
                </p>
                {deployedTokens.length === 0 ? (
                  <p className="mt-6 text-sm text-white/45">No deployments yet.</p>
                ) : (
                  <ul className="mt-6 space-y-3">
                    {deployedTokens.map((token) => (
                      <li key={token.address} className="rounded-2xl border border-white/10 bg-black/25 p-4 text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-white/90">{token.symbol}</p>
                            <p className="text-white/60">{token.name}</p>
                            <p className="mt-2 text-xs text-white/45">
                              {token.supply} supply · {token.decimals} decimals ·{" "}
                              <span className="font-mono text-white/50">{token.iconName}</span>
                            </p>
                            <a
                              href={txparkExplorerAddressUrl(token.address)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-2 inline-block font-mono text-[11px] text-white/55 underline decoration-white/20 underline-offset-2 hover:text-white/80"
                            >
                              Contract on explorer
                            </a>
                            {token.txHash ? (
                              <p className="mt-1">
                                <a
                                  href={txparkExplorerTxUrl(token.txHash)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-mono text-[11px] text-white/45 underline decoration-white/15 underline-offset-2 hover:text-white/70"
                                >
                                  Deployment tx · {shortenTxHash(token.txHash)}
                                </a>
                              </p>
                            ) : null}
                          </div>
                          {token.iconName ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={cryptoIconSvgUrl(token.iconName)}
                              alt=""
                              className="h-11 w-11 shrink-0 rounded-lg bg-white/10 object-contain p-1"
                            />
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
