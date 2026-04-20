import { NextResponse } from "next/server";
import { Contract, JsonRpcProvider, Wallet, isAddress, parseUnits } from "ethers";
import { FEATURED_TOKENS, TXPARK_RPC_URL, erc20Abi, normalizeAddress } from "@/lib/txpark";

const faucetTransferAbi = [
  ...erc20Abi,
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

function envTrim(key: string) {
  const value = process.env[key]?.trim();
  return value || undefined;
}

function requireOneOfServerEnv(...keys: string[]) {
  for (const key of keys) {
    const value = envTrim(key);
    if (value) return value;
  }
  throw new Error(`Missing required server env. Set one of: ${keys.join(", ")}`);
}

function toHexPrivateKey(value: string) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { address?: string };
    const recipient = body.address?.trim();

    if (!recipient || !isAddress(recipient)) {
      return NextResponse.json({ error: "Invalid wallet address." }, { status: 400 });
    }

    const rpcUrl = envTrim("NEXT_PUBLIC_RPC_URL") ?? TXPARK_RPC_URL;
    const privateKey = toHexPrivateKey(requireOneOfServerEnv("FAUCET_PRIVATE_KEY", "PRIVATE_KEY"));

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const normalizedRecipient = normalizeAddress(recipient);

    const tokenEntries = [
      { token: FEATURED_TOKENS.usdc, amount: "5" },
      { token: FEATURED_TOKENS.xu3o8, amount: "5" },
      ...(FEATURED_TOKENS.vnxau ? [{ token: FEATURED_TOKENS.vnxau, amount: "5" }] : []),
    ];

    const results: Array<{ symbol: string; address: string; txHash: string }> = [];

    for (const entry of tokenEntries) {
      const contract = new Contract(entry.token.address, faucetTransferAbi, wallet);
      const amount = parseUnits(entry.amount, entry.token.decimals);
      const tx = await contract.transfer(normalizedRecipient, amount);
      await tx.wait();
      results.push({
        symbol: entry.token.symbol,
        address: entry.token.address,
        txHash: tx.hash,
      });
    }

    return NextResponse.json({
      recipient: normalizedRecipient,
      transfers: results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Faucet request failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
