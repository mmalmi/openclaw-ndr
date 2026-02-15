import { describe, expect, it } from "vitest";
import { ndrPlugin } from "./channel.js";

describe("ndr reload policy", () => {
  it("treats ownerPubkey updates as dynamic and non-restarting", () => {
    const ownerPath = "channels.ndr.ownerPubkey";
    const configPrefixes = ndrPlugin.reload?.configPrefixes ?? [];
    const noopPrefixes = ndrPlugin.reload?.noopPrefixes ?? [];

    const ownerPathTriggersRestart = configPrefixes.some(
      (prefix: string) => ownerPath === prefix || ownerPath.startsWith(`${prefix}.`),
    );

    expect(ownerPathTriggersRestart).toBe(false);
    expect(noopPrefixes).toContain(ownerPath);
  });
});
