import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { withOwnerPubkeyLocked } from "./channel.js";

describe("withOwnerPubkeyLocked", () => {
  it("sets owner pubkey and enables ndr while preserving existing config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        ndr: {
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
    expect(((next.channels as Record<string, unknown>).ndr as Record<string, unknown>).enabled).toBe(true);
    expect(((next.channels as Record<string, unknown>).ndr as Record<string, unknown>).ownerPubkey).toBe("a".repeat(64));
    expect(((next.channels as Record<string, unknown>).ndr as Record<string, unknown>).relays).toEqual(["wss://relay.example"]);
    expect(next.session).toEqual({ store: "/tmp/store" });
  });

  it("creates channels.ndr when missing", () => {
    const cfg: OpenClawConfig = {};
    const next = withOwnerPubkeyLocked(cfg, "b".repeat(64));

    expect(((next.channels as Record<string, unknown>).ndr as Record<string, unknown>).enabled).toBe(true);
    expect(((next.channels as Record<string, unknown>).ndr as Record<string, unknown>).ownerPubkey).toBe("b".repeat(64));
  });
});
