import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedNdrAccount } from "./types.js";
import {
  isDirectMessageFromOwner,
  isGroupMessageAllowed,
  shouldAutoAcceptGroupInvite,
} from "./channel.js";

function makeAccount(overrides: Partial<ResolvedNdrAccount> = {}): ResolvedNdrAccount {
  return {
    accountId: "default",
    name: "NDR",
    enabled: true,
    configured: true,
    ownerPubkey: overrides.ownerPubkey ?? null,
    relays: [],
    ndrPath: "ndr",
    dataDir: null,
    config: (overrides.config ?? {}) as ResolvedNdrAccount["config"],
    ...overrides,
  };
}

describe("isGroupMessageAllowed", () => {
  it("defaults to open when groupPolicy is not set", () => {
    const cfg: OpenClawConfig = {};
    const account = makeAccount();
    const result = isGroupMessageAllowed({
      cfg,
      account,
      groupId: "00000000-0000-0000-0000-000000000000",
      senderPubkey: "b".repeat(64),
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("open");
  });

  it("blocks when groupPolicy is disabled", () => {
    const cfg: OpenClawConfig = { channels: { defaults: { groupPolicy: "disabled" } } };
    const account = makeAccount();
    const result = isGroupMessageAllowed({
      cfg,
      account,
      groupId: "11111111-1111-1111-1111-111111111111",
      senderPubkey: "a".repeat(64),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("disabled");
  });

  it("allowlist uses ownerPubkey by default", () => {
    const cfg: OpenClawConfig = { channels: { defaults: { groupPolicy: "allowlist" } } };
    const owner = "a".repeat(64);
    const account = makeAccount({ ownerPubkey: owner });

    const ok = isGroupMessageAllowed({
      cfg,
      account,
      groupId: "22222222-2222-2222-2222-222222222222",
      senderPubkey: owner,
    });
    expect(ok.allowed).toBe(true);

    const blocked = isGroupMessageAllowed({
      cfg,
      account,
      groupId: "22222222-2222-2222-2222-222222222222",
      senderPubkey: "b".repeat(64),
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("allowlist");
  });

  it("allowlist enforces group allowlist when provided", () => {
    const cfg: OpenClawConfig = { channels: { defaults: { groupPolicy: "allowlist" } } };
    const account = makeAccount({
      config: {
        groupAllowFrom: ["*"],
        groups: ["group-allowed"],
      },
    });

    const allowed = isGroupMessageAllowed({
      cfg,
      account,
      groupId: "group-allowed",
      senderPubkey: "c".repeat(64),
    });
    expect(allowed.allowed).toBe(true);

    const blocked = isGroupMessageAllowed({
      cfg,
      account,
      groupId: "group-blocked",
      senderPubkey: "c".repeat(64),
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("group");
  });
});

describe("shouldAutoAcceptGroupInvite", () => {
  it("returns true when owner matches sender", () => {
    const owner = "a".repeat(64);
    expect(shouldAutoAcceptGroupInvite(owner, owner)).toBe(true);
  });

  it("returns false when owner is missing", () => {
    expect(shouldAutoAcceptGroupInvite(null, "b".repeat(64))).toBe(false);
  });

  it("returns false when sender is missing or invalid", () => {
    const owner = "c".repeat(64);
    expect(shouldAutoAcceptGroupInvite(owner, undefined)).toBe(false);
    expect(shouldAutoAcceptGroupInvite(owner, "not-a-pubkey")).toBe(false);
  });

  it("returns false when sender does not match owner", () => {
    const owner = "d".repeat(64);
    const sender = "e".repeat(64);
    expect(shouldAutoAcceptGroupInvite(owner, sender)).toBe(false);
  });
});

describe("isDirectMessageFromOwner", () => {
  it("allows message when owner pubkey matches identity pubkey", () => {
    const owner = "a".repeat(64);
    const allowed = isDirectMessageFromOwner({
      identityPubkey: owner,
      ownerPubkey: owner,
    });
    expect(allowed).toBe(true);
  });

  it("normalizes npub/hex forms before comparing", () => {
    const owner = "c".repeat(64);
    const allowed = isDirectMessageFromOwner({
      identityPubkey: owner,
      ownerPubkey: owner,
    });
    expect(allowed).toBe(true);
  });

  it("rejects message when identity pubkey does not match owner pubkey", () => {
    const allowed = isDirectMessageFromOwner({
      identityPubkey: "f".repeat(64),
      ownerPubkey: "d".repeat(64),
    });
    expect(allowed).toBe(false);
  });
});
