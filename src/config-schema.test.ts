import { describe, it, expect } from "vitest";
import { NdrConfigSchema, DEFAULT_RELAYS } from "./config-schema.js";

describe("NdrConfigSchema", () => {
  it("accepts empty config", () => {
    const result = NdrConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts full config", () => {
    const result = NdrConfigSchema.safeParse({
      ownerPubkey: "npub1abc123",
      relays: ["wss://relay.example.com"],
      enabled: true,
      name: "test",
      ndrPath: "/usr/local/bin/ndr",
      dataDir: "~/.ndr-test",
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial config", () => {
    const result = NdrConfigSchema.safeParse({
      ownerPubkey: "npub1abc123",
      enabled: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownerPubkey).toBe("npub1abc123");
      expect(result.data.enabled).toBe(false);
    }
  });

  it("rejects invalid types", () => {
    const result = NdrConfigSchema.safeParse({
      enabled: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("DEFAULT_RELAYS", () => {
  it("contains relay URLs", () => {
    expect(DEFAULT_RELAYS.length).toBeGreaterThan(0);
    for (const relay of DEFAULT_RELAYS) {
      expect(relay).toMatch(/^wss:\/\//);
    }
  });
});
