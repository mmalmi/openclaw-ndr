import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startNdrBus, type NdrBusHandle } from "./ndr-bus.js";

function createChunkedListenStub(dir: string): string {
  const stubPath = join(dir, "ndr-chunked-stub.js");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const has = (needle) => args.includes(needle);

if (has("listen")) {
  const line = JSON.stringify({
    event: "group_message",
    group_id: "11111111-1111-1111-1111-111111111111",
    message_id: "msg-1",
    sender_pubkey: "a".repeat(64),
    content: "hello group",
    timestamp: 123,
  }) + "\\n";
  process.stdout.write(line.slice(0, 15));
  setTimeout(() => {
    process.stdout.write(line.slice(15));
  }, 10);
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

describe("ndr-bus listen stream parsing", () => {
  let bus: NdrBusHandle | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
  });

  it("handles JSON lines split across stdout chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ndr-stream-stub-"));
    const dataDir = mkdtempSync(join(tmpdir(), "ndr-stream-data-"));
    const stubPath = createChunkedListenStub(dir);
    const received: string[] = [];

    try {
      bus = await startNdrBus({
        accountId: "test",
        relays: [],
        ndrPath: stubPath,
        dataDir,
        onMessage: async () => {},
        onGroupMessage: async (_groupId, _messageId, _senderPubkey, content) => {
          received.push(content);
        },
      });

      await expect.poll(() => received, { timeout: 5000 }).toEqual(["hello group"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
