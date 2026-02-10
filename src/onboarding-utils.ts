import { normalizePubkey } from "./types.js";

/**
 * Parse an NDR invite URL to extract the inviter's hex pubkey.
 *
 * Invite URL format:
 *   https://chat.iris.to/#{"inviter":"<hex>","ephemeralKey":"...","sharedSecret":"..."}
 */
export function parseInviteUrlInviter(url: string): { inviter: string } | null {
  try {
    const trimmed = url.trim();
    if (!trimmed) return null;

    // Handle both full URL and just the fragment.
    let fragment = trimmed;
    if (trimmed.includes("#")) {
      fragment = trimmed.split("#")[1] ?? "";
    }

    const decoded = decodeURIComponent(fragment);
    const data = JSON.parse(decoded) as { inviter?: string };
    if (data.inviter && /^[0-9a-fA-F]{64}$/.test(data.inviter)) {
      return { inviter: data.inviter.toLowerCase() };
    }
  } catch {
    // ignore invalid URL format
  }
  return null;
}

function firstToken(s: string): string {
  return s.split(/[/?&]/, 1)[0] ?? s;
}

function extractNip19Candidate(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Support `nostr:npub1...` (and allow leading slash).
  const withoutScheme = trimmed.startsWith("nostr:") ? trimmed.slice("nostr:".length).trim() : trimmed;
  const looksLikeNip19 = (s: string) => s.startsWith("npub1") || s.startsWith("nprofile1");

  const raw = withoutScheme.replace(/^\/+/, "");
  if (looksLikeNip19(raw)) {
    return firstToken(raw);
  }

  // Full URL or any string with a hash fragment (Iris-style links).
  const hashIdx = withoutScheme.lastIndexOf("#");
  if (hashIdx !== -1) {
    const hash = withoutScheme.slice(hashIdx + 1).trim().replace(/^\/+/, "");
    if (looksLikeNip19(hash)) {
      return firstToken(hash);
    }
  }

  return null;
}

/**
 * Best-effort parse of the owner's pubkey (hex) from an onboarding input string.
 *
 * Supports:
 * - NDR invite URLs (JSON in hash; returns `inviter`)
 * - Iris chat links: https://chat.iris.to/#npub1...
 * - Raw nip19: npub1...
 */
export function deriveOwnerPubkeyHex(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Already hex
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const invite = parseInviteUrlInviter(trimmed);
  if (invite) {
    return invite.inviter;
  }

  const nip19 = extractNip19Candidate(trimmed);
  if (nip19?.startsWith("npub1")) {
    try {
      return normalizePubkey(nip19);
    } catch {
      return null;
    }
  }

  return null;
}

function tryParseJson(output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // try last non-empty line (common when tools emit logs before json)
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]!) as unknown;
      } catch {
        // keep trying
      }
    }
  }
  return null;
}

/**
 * Parse stdout from `ndr --json chat join ...`
 */
export function parseNdrChatJoinOutput(stdout: string): {
  chatId: string | null;
  theirPubkey: string | null;
} {
  const json = tryParseJson(stdout);
  if (!json || typeof json !== "object") {
    return { chatId: null, theirPubkey: null };
  }

  const root = json as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;

  const rawChatId =
    typeof data.id === "string"
      ? data.id
      : typeof data.chat_id === "string"
        ? data.chat_id
        : typeof data.chatId === "string"
          ? data.chatId
          : null;

  const rawTheir =
    typeof data.their_pubkey === "string"
      ? data.their_pubkey
      : typeof data.theirPubkey === "string"
        ? data.theirPubkey
        : null;

  const chatId = rawChatId && rawChatId.trim() ? rawChatId.trim() : null;
  const theirPubkey =
    rawTheir && /^[0-9a-fA-F]{64}$/.test(rawTheir.trim()) ? rawTheir.trim().toLowerCase() : null;

  return { chatId, theirPubkey };
}

