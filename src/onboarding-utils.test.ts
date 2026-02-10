import { describe, expect, it } from "vitest";

import { deriveOwnerPubkeyHex, parseNdrChatJoinOutput } from "./onboarding-utils.js";

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bytesToBech32Words(bytes: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const words: number[] = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) {
    words.push((acc << (5 - bits)) & 31);
  }
  return words;
}

function makeFakeNpubFromHex(hex: string): string {
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  const words = bytesToBech32Words(bytes);
  const data = words.map((w) => BECH32_ALPHABET[w]!).join("");
  // Our decoder drops the last 6 chars as "checksum" without validation.
  const fakeChecksum = "qqqqqq";
  return `npub1${data}${fakeChecksum}`;
}

describe("deriveOwnerPubkeyHex", () => {
  it("extracts inviter pubkey from legacy invite URL", () => {
    const inviter = "a".repeat(64);
    const inviteJson = JSON.stringify({
      inviter,
      ephemeralKey: "b".repeat(64),
      sharedSecret: "c".repeat(64),
    });
    const url = `https://chat.iris.to/#${encodeURIComponent(inviteJson)}`;
    expect(deriveOwnerPubkeyHex(url)).toBe(inviter);
  });

  it("extracts npub from raw token and decodes to hex", () => {
    const expected = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join(
      "",
    );
    const npub = makeFakeNpubFromHex(expected);
    expect(deriveOwnerPubkeyHex(npub)).toBe(expected);
  });

  it("extracts npub from nostr: scheme and decodes to hex", () => {
    const expected = "01".repeat(32);
    const npub = makeFakeNpubFromHex(expected);
    expect(deriveOwnerPubkeyHex(`nostr:${npub}`)).toBe(expected);
  });

  it("extracts npub from Iris chat link and decodes to hex", () => {
    const expected = "02".repeat(32);
    const npub = makeFakeNpubFromHex(expected);
    expect(deriveOwnerPubkeyHex(`https://chat.iris.to/#${npub}`)).toBe(expected);
    expect(deriveOwnerPubkeyHex(`https://chat.iris.to/#/${npub}`)).toBe(expected);
  });
});

describe("parseNdrChatJoinOutput", () => {
  it("parses { data: { id, their_pubkey } }", () => {
    const out = JSON.stringify({
      status: "ok",
      command: "chat.join",
      data: { id: "abcd1234", their_pubkey: "f".repeat(64) },
    });
    expect(parseNdrChatJoinOutput(out)).toEqual({ chatId: "abcd1234", theirPubkey: "f".repeat(64) });
  });
});

