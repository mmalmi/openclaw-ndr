import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startNdrBus, type NdrBusHandle } from "./ndr-bus.js";

function createNdrStub(params: { dir: string; logPath: string }): string {
  const stubPath = join(params.dir, "ndr-stub.js");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const logPath = process.env.NDR_STUB_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
}
const args = process.argv.slice(2);
const has = (needle) => args.includes(needle);
if (has("listen")) {
  // Keep the process alive until killed by the parent.
  setInterval(() => {}, 1000);
  return;
}
if (has("whoami")) {
  process.stdout.write(JSON.stringify({ status: "ok", data: { logged_in: true } }));
  return;
}
process.stdout.write(JSON.stringify({ status: "ok", data: {} }));
`;
  writeFileSync(stubPath, script, "utf-8");
  chmodSync(stubPath, 0o755);
  return stubPath;
}

function readStubInvocations(logPath: string): string[][] {
  const raw = readFileSync(logPath, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe("ndr-bus reply support (stub)", () => {
  let dir: string;
  let dataDir: string;
  let logPath: string;
  let stubPath: string;
  let bus: NdrBusHandle | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ndr-stub-"));
    dataDir = mkdtempSync(join(tmpdir(), "ndr-stub-data-"));
    logPath = join(dir, "invocations.log");
    writeFileSync(logPath, "", "utf-8");
    stubPath = createNdrStub({ dir, logPath });
    process.env.NDR_STUB_LOG = logPath;
  });

  afterEach(() => {
    bus?.close();
    bus = null;
    delete process.env.NDR_STUB_LOG;
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("adds --reply for direct messages when replyToId is provided", async () => {
    bus = await startNdrBus({
      accountId: "test",
      relays: [],
      ndrPath: stubPath,
      dataDir,
      onMessage: async () => {},
    });

    await bus.sendMessage("chat-1", "hello", { replyToId: "parent-1" });

    const invocations = readStubInvocations(logPath);
    const sendCalls = invocations.filter((args) => args.includes("send"));
    expect(sendCalls.length).toBeGreaterThan(0);
    expect(sendCalls.some((args) => args.includes("--reply") && args.includes("parent-1"))).toBe(
      true,
    );
  });

  it("adds --reply for group messages when replyToId is provided", async () => {
    bus = await startNdrBus({
      accountId: "test",
      relays: [],
      ndrPath: stubPath,
      dataDir,
      onMessage: async () => {},
    });

    await bus.sendGroupMessage("11111111-1111-1111-1111-111111111111", "hello", {
      replyToId: "parent-1",
    });

    const invocations = readStubInvocations(logPath);
    const sendCalls = invocations.filter((args) => args.includes("group") && args.includes("send"));
    expect(sendCalls.length).toBeGreaterThan(0);
    expect(sendCalls.some((args) => args.includes("--reply") && args.includes("parent-1"))).toBe(
      true,
    );
  });
});

