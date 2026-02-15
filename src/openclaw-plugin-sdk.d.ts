declare module "openclaw/plugin-sdk" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyRecord = Record<string, any>;

  export interface OpenClawConfig {
    channels?: AnyRecord;
    session?: AnyRecord;
    [key: string]: unknown;
  }

  export interface OpenClawPluginApi {
    runtime: PluginRuntime;
    registerChannel(opts: { plugin: ChannelPlugin<unknown> }): void;
  }

  export interface PluginRuntime {
    config: {
      loadConfig(): OpenClawConfig;
    };
    system: {
      enqueueSystemEvent(text: string, options?: { sessionKey?: string; contextKey?: string }): void;
    };
    channel: {
      text: {
        resolveMarkdownTableMode(opts: {
          cfg: OpenClawConfig;
          channel: string;
          accountId: string;
        }): unknown;
        convertMarkdownTables(text: string, mode: unknown): string;
      };
      routing: {
        resolveAgentRoute(opts: {
          cfg: OpenClawConfig;
          channel: string;
          accountId: string;
          peer: { kind: string; id: string };
        }): {
          sessionKey: string;
          mainSessionKey: string;
          agentId: string;
          accountId: string;
        };
      };
      reply: {
        resolveEnvelopeFormatOptions(cfg: OpenClawConfig): unknown;
        formatInboundEnvelope(opts: AnyRecord): string;
        finalizeInboundContext(opts: AnyRecord): AnyRecord;
        resolveHumanDelayConfig(cfg: OpenClawConfig, agentId: string): unknown;
        createReplyDispatcherWithTyping(opts: {
          responsePrefix?: unknown;
          responsePrefixContextProvider?: unknown;
          humanDelay?: unknown;
          onReplyStart?: () => Promise<void>;
          onIdle?: () => void;
          deliver: (payload: AnyRecord) => Promise<void>;
          onError: (err: unknown, info: { kind: string }) => void;
        }): {
          dispatcher: unknown;
          replyOptions: AnyRecord;
          markDispatchIdle: () => void;
        };
        dispatchReplyFromConfig(opts: AnyRecord): Promise<void>;
      };
      session: {
        resolveStorePath(store: unknown, opts: { agentId: string }): string;
        recordInboundSession(opts: AnyRecord): Promise<void>;
      };
    };
  }

  export interface ChannelMessageActionContext {
    action: string;
    params: AnyRecord;
    cfg: OpenClawConfig;
    accountId?: string | null;
    toolContext?: AnyRecord;
  }

  export interface ChannelMessageActionAdapter {
    listActions?: (params: { cfg: OpenClawConfig }) => string[];
    supportsAction?: (params: { action: string }) => boolean;
    handleAction?: (ctx: ChannelMessageActionContext) => Promise<AnyRecord>;
    extractToolSend?: (params: { args: AnyRecord }) => AnyRecord | null;
  }

  export interface ChannelPlugin<TAccount> {
    id: string;
    meta: AnyRecord;
    capabilities: AnyRecord;
    reload?: AnyRecord;
    configSchema: unknown;
    onboarding?: unknown;
    config: AnyRecord;
    messaging?: AnyRecord;
    actions?: ChannelMessageActionAdapter;
    outbound: AnyRecord;
    status: AnyRecord;
    gateway: AnyRecord;
  }

  export const DEFAULT_ACCOUNT_ID: string;
  export function emptyPluginConfigSchema(): unknown;
  export function buildChannelConfigSchema(schema: unknown): unknown;
  export function createReplyPrefixContext(opts: {
    cfg: OpenClawConfig;
    agentId: string;
  }): {
    responsePrefix: unknown;
    responsePrefixContextProvider: unknown;
    onModelSelected: (modelCtx: unknown) => void;
  };

  export type TypingCallbacks = {
    onReplyStart: () => Promise<void>;
    onIdle?: () => void;
  };

  export function createTypingCallbacks(params: {
    start: () => Promise<void>;
    stop?: () => Promise<void>;
    onStartError: (err: unknown) => void;
    onStopError?: (err: unknown) => void;
  }): TypingCallbacks;

  export function logTypingFailure(params: {
    log: (...args: unknown[]) => void;
    channel: string;
    target?: string;
    error: unknown;
  }): void;
}
