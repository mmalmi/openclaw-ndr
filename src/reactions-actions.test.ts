import { beforeEach, describe, expect, it, vi } from "vitest";

function createLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

type SetupResult = {
  ndrPlugin: any;
  cfg: Record<string, unknown>;
  mockBus: {
    react: ReturnType<typeof vi.fn>;
    reactGroup: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  capturedOptions: { current: any };
  enqueueSystemEvent: ReturnType<typeof vi.fn>;
  resolveAgentRoute: ReturnType<typeof vi.fn>;
};

async function setupPlugin(): Promise<SetupResult> {
  const cfg = {
    channels: {
      ndr: {
        enabled: true,
      },
    },
  };

  const enqueueSystemEvent = vi.fn();
  const resolveAgentRoute = vi.fn(() => ({
    sessionKey: "session-key",
    mainSessionKey: "main-session",
    agentId: "main",
    accountId: "default",
  }));

  const runtime = {
    config: {
      loadConfig: () => cfg,
    },
    system: {
      enqueueSystemEvent,
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "none",
        convertMarkdownTables: (text: string) => text,
      },
      routing: {
        resolveAgentRoute,
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

  const react = vi.fn(async () => {});
  const reactGroup = vi.fn(async () => {});
  const close = vi.fn();

  const mockBus = {
    sendMessage: vi.fn(async () => {}),
    sendGroupMessage: vi.fn(async () => {}),
    acceptGroup: vi.fn(async () => {}),
    react,
    reactGroup,
    sendReceipt: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    createInvite: vi.fn(async () => ({ inviteUrl: "https://example.com", inviteId: "invite-1" })),
    joinInvite: vi.fn(async () => ({ chatId: "chat-1", theirPubkey: "a".repeat(64) })),
    listChats: vi.fn(async () => []),
    close,
    isRunning: vi.fn(() => true),
  } as any;

  const capturedOptions: { current: any } = { current: null };

  vi.doMock("./runtime.js", () => ({
    getNdrRuntime: () => runtime,
  }));

  vi.doMock("./ndr-bus.js", () => ({
    startNdrBus: vi.fn(async (opts: unknown) => {
      capturedOptions.current = opts;
      return mockBus;
    }),
  }));

  const { ndrPlugin } = await import("./channel.js");

  return {
    ndrPlugin,
    cfg,
    mockBus: {
      react,
      reactGroup,
      close,
    },
    capturedOptions,
    enqueueSystemEvent,
    resolveAgentRoute,
  };
}

describe("ndr reaction support", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("routes react action to direct chats and groups", async () => {
    const { ndrPlugin, cfg, mockBus } = await setupPlugin();

    const actions = ndrPlugin.actions?.listActions?.({ cfg }) ?? [];
    expect(actions).toContain("react");

    const account = ndrPlugin.config.resolveAccount(cfg, "default");
    const runtime = await ndrPlugin.gateway.startAccount({
      account,
      setStatus: vi.fn(),
      log: createLogger(),
    });

    await ndrPlugin.actions.handleAction({
      action: "react",
      params: {
        to: "cafebabe",
        messageId: "dm-msg-1",
        emoji: "🔥",
      },
      cfg,
      accountId: "default",
    });

    expect(mockBus.react).toHaveBeenCalledWith("cafebabe", "dm-msg-1", "🔥");

    await ndrPlugin.actions.handleAction({
      action: "react",
      params: {
        to: "11111111-1111-1111-1111-111111111111",
        messageId: "group-msg-1",
        emoji: "👍",
      },
      cfg,
      accountId: "default",
    });

    expect(mockBus.reactGroup).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "group-msg-1",
      "👍",
    );

    runtime.stop();
  });

  it("surfaces group reaction events as system events", async () => {
    const { ndrPlugin, cfg, capturedOptions, enqueueSystemEvent, resolveAgentRoute } = await setupPlugin();

    const account = ndrPlugin.config.resolveAccount(cfg, "default");
    const runtime = await ndrPlugin.gateway.startAccount({
      account,
      setStatus: vi.fn(),
      log: createLogger(),
    });

    const onGroupReaction = capturedOptions.current?.onGroupReaction;
    expect(typeof onGroupReaction).toBe("function");

    onGroupReaction(
      "22222222-2222-2222-2222-222222222222",
      "b".repeat(64),
      "msg-42",
      "🎉",
    );

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "22222222-2222-2222-2222-222222222222" },
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("NDR group reaction: 🎉"),
      expect.objectContaining({
        sessionKey: "session-key",
        contextKey: "ndr:group-reaction:add:22222222-2222-2222-2222-222222222222:msg-42:" + "b".repeat(64) + ":🎉",
      }),
    );

    runtime.stop();
  });
});
