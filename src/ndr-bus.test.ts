import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startNdrBus, type NdrBusHandle } from "./ndr-bus.js";

/**
 * Check if the ndr CLI is available
 */
function hasNdr(): boolean {
  try {
    execSync("ndr --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeLive = hasNdr() ? describe : describe.skip;

describeLive("ndr-bus (live)", () => {
  let dataDir: string;
  let bus: NdrBusHandle | null = null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ndr-test-"));
  });

  afterEach(() => {
    bus?.close();
    bus = null;
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("starts and stops the bus", async () => {
    let connected = false;
    let disconnected = false;

    bus = await startNdrBus({
      accountId: "test",
      relays: [],
      ndrPath: "ndr",
      dataDir,
      onMessage: async () => {},
      onConnect: () => { connected = true; },
      onDisconnect: () => { disconnected = true; },
    });

    expect(bus.isRunning()).toBe(true);
    expect(connected).toBe(true);

    bus.close();
    expect(bus.isRunning()).toBe(false);
    expect(disconnected).toBe(true);
    bus = null;
  });

  it("lists chats (empty initially)", async () => {
    bus = await startNdrBus({
      accountId: "test",
      relays: [],
      ndrPath: "ndr",
      dataDir,
      onMessage: async () => {},
    });

    const chats = await bus.listChats();
    expect(chats).toEqual([]);
  });

  it("creates an invite", async () => {
    bus = await startNdrBus({
      accountId: "test",
      relays: [],
      ndrPath: "ndr",
      dataDir,
      onMessage: async () => {},
    });

    const invite = await bus.createInvite();
    expect(invite.inviteUrl).toContain("iris.to");
    expect(invite.inviteId).toBeTruthy();
  });

  it("self-chat: join own invite and send/receive message", async () => {
    // Create two ndr instances (alice and bob) with separate data dirs
    const bobDataDir = mkdtempSync(join(tmpdir(), "ndr-test-bob-"));
    let bobBus: NdrBusHandle | null = null;

    const received: Array<{ chatId: string; text: string }> = [];

    try {
      // Start alice's bus
      bus = await startNdrBus({
        accountId: "alice",
        relays: ["wss://temp.iris.to"],
        ndrPath: "ndr",
        dataDir,
        onMessage: async (chatId, _msgId, _sender, text) => {
          received.push({ chatId, text });
        },
      });

      // Alice creates invite
      const invite = await bus.createInvite();
      expect(invite.inviteUrl).toBeTruthy();

      // Bob joins alice's invite
      bobBus = await startNdrBus({
        accountId: "bob",
        relays: ["wss://temp.iris.to"],
        ndrPath: "ndr",
        dataDir: bobDataDir,
        onMessage: async () => {},
      });

      const joined = await bobBus.joinInvite(invite.inviteUrl);
      expect(joined.chatId).toBeTruthy();
      expect(joined.theirPubkey).toBeTruthy();

      // Bob sends message to alice
      await bobBus.sendMessage(joined.chatId, "hello from bob");

      // Wait for alice to receive it (with timeout)
      const deadline = Date.now() + 15000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }

      expect(received.length).toBeGreaterThan(0);
      expect(received[0].text).toBe("hello from bob");
    } finally {
      bobBus?.close();
      if (existsSync(bobDataDir)) {
        rmSync(bobDataDir, { recursive: true, force: true });
      }
    }
  }, 30000);
});
