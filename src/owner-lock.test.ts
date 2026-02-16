import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { withOwnerPubkeyLocked } from "./channel.js";

describe("withOwnerPubkeyLocked", () => {
  it("sets owner pubkey while preserving existing config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "openclaw-ndr": {
          relays: ["wss://relay.example"],
          dataDir: "/tmp/ndr",
        },
        other: {
          enabled: true,
        },
      },
      session: {
        store: "/tmp/store",
      },
    };

    const next = withOwnerPubkeyLocked(cfg, "A".repeat(64));

    expect((next.channels as Record<string, unknown>).other).toEqual({ enabled: true });
    expect(((next.channels as Record<string, unknown>)["openclaw-ndr"] as Record<string, unknown>).ownerPubkey).toBe("a".repeat(64));
    expect(((next.channels as Record<string, unknown>)["openclaw-ndr"] as Record<string, unknown>).relays).toEqual(["wss://relay.example"]);
    expect(next.session).toEqual({ store: "/tmp/store" });
  });

  it("creates channels.openclaw-ndr when missing", () => {
    const cfg: OpenClawConfig = {};
    const next = withOwnerPubkeyLocked(cfg, "b".repeat(64));

    expect(((next.channels as Record<string, unknown>)["openclaw-ndr"] as Record<string, unknown>).ownerPubkey).toBe("b".repeat(64));
  });

  it("preserves existing enabled flag", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "openclaw-ndr": {
          enabled: false,
        },
      },
    };
    const next = withOwnerPubkeyLocked(cfg, "c".repeat(64));
    expect(((next.channels as Record<string, unknown>)["openclaw-ndr"] as Record<string, unknown>).enabled).toBe(false);
  });
});
