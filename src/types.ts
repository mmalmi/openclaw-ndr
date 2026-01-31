import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { homedir } from "os";
import { join } from "path";
import { DEFAULT_RELAYS, type NdrConfig } from "./config-schema.js";

/**
 * Expand ~ to home directory
 */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export interface ResolvedNdrAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  ownerPubkey: string | null;
  relays: string[];
  ndrPath: string;
  dataDir: string | null;
  config: NdrConfig;
}

/**
 * List all configured NDR account IDs
 */
export function listNdrAccountIds(cfg: OpenClawConfig): string[] {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const ndrConfig = channels.ndr;
  if (!ndrConfig || typeof ndrConfig !== "object") {
    return [];
  }
  // For now, only support single "default" account
  return ["default"];
}

/**
 * Resolve the default NDR account ID
 */
export function resolveDefaultNdrAccountId(cfg: OpenClawConfig): string | undefined {
  const ids = listNdrAccountIds(cfg);
  return ids.length > 0 ? ids[0] : undefined;
}

/**
 * Resolve NDR account configuration
 */
export function resolveNdrAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedNdrAccount {
  const { cfg, accountId = "default" } = opts;
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const ndrConfig = (channels.ndr ?? {}) as NdrConfig;

  // ndr manages its own identity in its config.json (auto-generates on first use)
  const configured = true;
  const relays = ndrConfig.relays ?? DEFAULT_RELAYS;

  // Normalize owner pubkey to hex if provided
  let ownerPubkey: string | null = null;
  if (ndrConfig.ownerPubkey) {
    ownerPubkey = normalizePubkey(ndrConfig.ownerPubkey);
  }

  return {
    accountId,
    name: ndrConfig.name ?? "NDR",
    enabled: ndrConfig.enabled !== false,
    configured,
    ownerPubkey,
    relays,
    ndrPath: ndrConfig.ndrPath ?? "ndr",
    // Default to ~/.openclaw/ndr-data for persistence (container mounts ~/.openclaw)
    dataDir: expandTilde(ndrConfig.dataDir ?? "~/.openclaw/ndr-data"),
    config: ndrConfig,
  };
}

/**
 * Normalize a pubkey to hex format
 */
export function normalizePubkey(input: string): string {
  const trimmed = input.trim();

  // Already hex
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  // npub format - decode bech32
  if (trimmed.startsWith("npub1")) {
    return decodeBech32Hex(trimmed);
  }

  throw new Error(`Invalid pubkey format: ${input}`);
}

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function decodeBech32Hex(bech32: string): string {
  const lower = bech32.toLowerCase();
  const sepIdx = lower.lastIndexOf("1");
  if (sepIdx < 1) throw new Error("Invalid bech32 string");
  const data = lower.slice(sepIdx + 1);
  // Drop 6-char checksum, decode 5-bit values
  const values: number[] = [];
  for (let i = 0; i < data.length - 6; i++) {
    const v = BECH32_ALPHABET.indexOf(data[i]);
    if (v === -1) throw new Error(`Invalid bech32 char: ${data[i]}`);
    values.push(v);
  }
  // Convert 5-bit groups to 8-bit bytes
  let acc = 0, bits = 0;
  const bytes: number[] = [];
  for (const v of values) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
