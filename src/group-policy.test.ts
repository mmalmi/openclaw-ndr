import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedNdrAccount } from "./types.js";
import { isGroupMessageAllowed } from "./channel.js";

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
