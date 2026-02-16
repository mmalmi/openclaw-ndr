import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    acceptGroup: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  capturedOptions: { current: any };
};

async function setupPlugin(ownerPubkey: string): Promise<SetupResult> {
  const cfg = {
    channels: {
      "openclaw-ndr": {
        enabled: true,
        ownerPubkey,
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

  const acceptGroup = vi.fn(async () => {});
  const close = vi.fn();

  const mockBus = {
    sendMessage: vi.fn(async () => {}),
    sendGroupMessage: vi.fn(async () => {}),
    acceptGroup,
    react: vi.fn(async () => {}),
    reactGroup: vi.fn(async () => {}),
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
      acceptGroup,
      close,
    },
    capturedOptions,
  };
}

describe("ndr group invite auto-accept", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries owner auto-accept and marks seen only after success", async () => {
    vi.useFakeTimers();
    const owner = "a".repeat(64);
    const { ndrPlugin, cfg, mockBus, capturedOptions } = await setupPlugin(owner);

    mockBus.acceptGroup
      .mockRejectedValueOnce(new Error("No such file or directory (os error 2)"))
      .mockResolvedValue(undefined);

    const account = ndrPlugin.config.resolveAccount(cfg, "default");
    const runtime = await ndrPlugin.gateway.startAccount({
      account,
      setStatus: vi.fn(),
      log: createLogger(),
    });

    const onGroupMetadata = capturedOptions.current?.onGroupMetadata;
    expect(typeof onGroupMetadata).toBe("function");

    const first = onGroupMetadata("group-1", "created", owner);
    await vi.runAllTimersAsync();
    await first;

    expect(mockBus.acceptGroup).toHaveBeenCalledTimes(2);

    // Seen marker should only be set after successful accept; duplicate events should no-op.
    await onGroupMetadata("group-1", "created", owner);
    expect(mockBus.acceptGroup).toHaveBeenCalledTimes(2);

    runtime.stop();
  });

  it("does not permanently suppress owner auto-accept after failed attempts", async () => {
    vi.useFakeTimers();
    const owner = "b".repeat(64);
    const { ndrPlugin, cfg, mockBus, capturedOptions } = await setupPlugin(owner);

    mockBus.acceptGroup.mockRejectedValue(new Error("temporary failure"));

    const account = ndrPlugin.config.resolveAccount(cfg, "default");
    const runtime = await ndrPlugin.gateway.startAccount({
      account,
      setStatus: vi.fn(),
      log: createLogger(),
    });

    const onGroupMetadata = capturedOptions.current?.onGroupMetadata;
    expect(typeof onGroupMetadata).toBe("function");

    const first = onGroupMetadata("group-2", "created", owner);
    await vi.runAllTimersAsync();
    await first;
    const firstAttemptCount = mockBus.acceptGroup.mock.calls.length;
    expect(firstAttemptCount).toBeGreaterThan(1);

    const second = onGroupMetadata("group-2", "created", owner);
    await vi.runAllTimersAsync();
    await second;

    expect(mockBus.acceptGroup.mock.calls.length).toBeGreaterThan(firstAttemptCount);

    runtime.stop();
  });
});
