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

  const { ndrPlugin, getActiveNdrBuses } = await import("./channel.js");

  return { ndrPlugin, cfg, mockBus, getActiveNdrBuses };
}

async function startAccountForTest(params: {
  ndrPlugin: any;
  cfg: Record<string, unknown>;
  getActiveNdrBuses: () => Map<string, unknown>;
}) {
  const account = params.ndrPlugin.config.resolveAccount(params.cfg, "default");
  const abortController = new AbortController();
  const startPromise = params.ndrPlugin.gateway.startAccount({
    account,
    abortSignal: abortController.signal,
    setStatus: vi.fn(),
    log: createLogger(),
  });
  await expect.poll(() => params.getActiveNdrBuses().size).toBe(1);
  return {
    stop: async () => {
      abortController.abort();
      await startPromise;
    },
  };
}

describe("ndr outbound target routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("routes ndr:group:<id> targets to group sends", async () => {
    const { ndrPlugin, cfg, mockBus, getActiveNdrBuses } = await setupPlugin();
    const runtime = await startAccountForTest({ ndrPlugin, cfg, getActiveNdrBuses });

    try {
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
    } finally {
      await runtime.stop();
    }
  });

  it("retries group sends when ndr reports group not found", async () => {
    const { ndrPlugin, cfg, mockBus, getActiveNdrBuses } = await setupPlugin();

    mockBus.sendGroupMessage
      .mockRejectedValueOnce(new Error('{"status":"error","command":"","error":"Group not found: g"}'))
      .mockResolvedValue(undefined);

    const runtime = await startAccountForTest({ ndrPlugin, cfg, getActiveNdrBuses });

    try {
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
    } finally {
      await runtime.stop();
    }
  });
});
