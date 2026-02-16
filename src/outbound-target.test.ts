import { beforeEach, describe, expect, it, vi } from "vitest";

function createLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function setupPlugin() {
  const cfg = {
    channels: {
      "openclaw-ndr": {
        enabled: true,
      },
    },
  };

  const runtime = {
    config: {
      loadConfig: () => cfg,
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "none",
        convertMarkdownTables: (text: string) => text,
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "session-key",
          mainSessionKey: "main-session",
          agentId: "main",
          accountId: "default",
        })),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatInboundEnvelope: () => "",
        finalizeInboundContext: (value: Record<string, unknown>) => value,
        resolveHumanDelayConfig: () => ({}),
        createReplyDispatcherWithTyping: () => ({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: () => {},
        }),
        dispatchReplyFromConfig: async () => {},
      },
      session: {
        resolveStorePath: () => "/tmp/session.json",
        recordInboundSession: async () => {},
      },
    },
  };

  const mockBus = {
    sendMessage: vi.fn(async () => {}),
    sendGroupMessage: vi.fn(async () => {}),
    acceptGroup: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    reactGroup: vi.fn(async () => {}),
    sendReceipt: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    createInvite: vi.fn(async () => ({ inviteUrl: "https://example.com", inviteId: "invite-1" })),
    joinInvite: vi.fn(async () => ({ chatId: "chat-1", theirPubkey: "a".repeat(64) })),
    listChats: vi.fn(async () => []),
    close: vi.fn(),
    isRunning: vi.fn(() => true),
  } as any;

  vi.doMock("./runtime.js", () => ({
    getNdrRuntime: () => runtime,
  }));

  vi.doMock("./ndr-bus.js", () => ({
    startNdrBus: vi.fn(async () => mockBus),
  }));

  const { ndrPlugin } = await import("./channel.js");

  return { ndrPlugin, cfg, mockBus };
}

describe("ndr outbound target routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("routes ndr:group:<id> targets to group sends", async () => {
    const { ndrPlugin, cfg, mockBus } = await setupPlugin();

    const account = ndrPlugin.config.resolveAccount(cfg, "default");
    const runtime = await ndrPlugin.gateway.startAccount({
      account,
      setStatus: vi.fn(),
      log: createLogger(),
    });

    await ndrPlugin.outbound.sendText({
      to: "ndr:group:11111111-1111-1111-1111-111111111111",
      text: "hello group",
      accountId: "default",
    });

    expect(mockBus.sendGroupMessage).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "hello group",
      { replyToId: undefined },
    );
    expect(mockBus.sendMessage).not.toHaveBeenCalled();

    runtime.stop();
  });

  it("retries group sends when ndr reports group not found", async () => {
    const { ndrPlugin, cfg, mockBus } = await setupPlugin();

    mockBus.sendGroupMessage
      .mockRejectedValueOnce(new Error('{"status":"error","command":"","error":"Group not found: g"}'))
      .mockResolvedValue(undefined);

    const account = ndrPlugin.config.resolveAccount(cfg, "default");
    const runtime = await ndrPlugin.gateway.startAccount({
      account,
      setStatus: vi.fn(),
      log: createLogger(),
    });

    await ndrPlugin.outbound.sendText({
      to: "ndr:group:11111111-1111-1111-1111-111111111111",
      text: "hello group",
      accountId: "default",
    });

    expect(mockBus.sendGroupMessage).toHaveBeenCalledTimes(2);
    expect(mockBus.sendGroupMessage).toHaveBeenNthCalledWith(
      1,
      "11111111-1111-1111-1111-111111111111",
      "hello group",
      { replyToId: undefined },
    );
    expect(mockBus.sendGroupMessage).toHaveBeenNthCalledWith(
      2,
      "11111111-1111-1111-1111-111111111111",
      "hello group",
      { replyToId: undefined },
    );

    runtime.stop();
  });
});
