import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type OpenClawConfig,
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
} from "openclaw/plugin-sdk";

import { NdrConfigSchema } from "./config-schema.js";
import { getNdrRuntime } from "./runtime.js";
import {
  listNdrAccountIds,
  resolveDefaultNdrAccountId,
  resolveNdrAccount,
  type ResolvedNdrAccount,
} from "./types.js";
import { startNdrBus, type NdrBusHandle } from "./ndr-bus.js";
import { ndrOnboardingAdapter } from "./onboarding.js";

// Store active bus handles per account
const activeBuses = new Map<string, NdrBusHandle>();

export const ndrPlugin: ChannelPlugin<ResolvedNdrAccount> = {
  id: "ndr",
  meta: {
    id: "ndr",
    label: "NDR",
    selectionLabel: "NDR (Nostr Double Ratchet)",
    docsPath: "/channels/ndr",
    docsLabel: "ndr",
    blurb: "Forward-secure E2E encryption via double ratchet over Nostr (chat.iris.to).",
    order: 56,
    selectionExtras: ["https://chat.iris.to"],
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct"], // DMs only
    media: true, // Supports nhash media via htree
  },
  reload: { configPrefixes: ["channels.ndr"] },
  configSchema: buildChannelConfigSchema(NdrConfigSchema),
  onboarding: ndrOnboardingAdapter,

  config: {
    listAccountIds: (cfg: OpenClawConfig) => listNdrAccountIds(cfg),
    resolveAccount: (cfg: OpenClawConfig, accountId: string) => resolveNdrAccount({ cfg, accountId }),
    defaultAccountId: (cfg: OpenClawConfig) => resolveDefaultNdrAccountId(cfg),
    isConfigured: (account: ResolvedNdrAccount) => account.configured,
    describeAccount: (account: ResolvedNdrAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.ownerPubkey,
    }),
  },

  // Authorization is handled by NDR's invite/accept flow.
  // Only users with an established double ratchet session can message.
  // No pairing/allowFrom config needed - the invite exchange IS the authorization.

  messaging: {
    normalizeTarget: (target: string) => {
      // NDR uses chat IDs, not pubkeys directly
      return target.trim();
    },
    targetResolver: {
      looksLikeId: (input: string) => {
        const trimmed = input.trim();
        // Chat IDs are short hex strings
        return /^[0-9a-fA-F]{8}$/.test(trimmed) || trimmed.startsWith("npub1");
      },
      hint: "<chat_id|npub>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }: { to: string; text?: string; accountId?: string }) => {
      const core = getNdrRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`NDR bus not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "ndr",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      await bus.sendMessage(to, message);
      return { channel: "ndr", to };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }: { to: string; text?: string; mediaUrl?: string; accountId?: string }) => {
      const core = getNdrRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`NDR bus not running for account ${aid}`);
      }
      const caption = text ? `${text}\n` : "";

      // mediaUrl could be a local file path or a remote URL
      let mediaLink = mediaUrl ?? "[media attachment]";
      if (mediaUrl && !mediaUrl.startsWith("http")) {
        // Local file path - upload via htree
        try {
          const { execSync } = await import("child_process");
          // Properly escape the file path for shell
          const escapedPath = mediaUrl.replace(/'/g, "'\\''");
          const output = execSync(`htree add '${escapedPath}'`, {
            encoding: "utf-8",
            timeout: 60000,
          });
          // Parse "url: nhash1.../filename" from output
          const urlMatch = output.match(/url:\s+(nhash1[^\s]+)/);
          if (urlMatch) {
            mediaLink = urlMatch[1];
          }
        } catch {
          // htree not available or failed - fall back to original URL
          mediaLink = mediaUrl ?? "[media: upload failed]";
        }
      }

      const message = `${caption}${mediaLink}`;
      await bus.sendMessage(to, message);
      return { channel: "ndr", to };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts: Array<Record<string, unknown>>) =>
      accounts.flatMap((account: Record<string, unknown>) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "ndr",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }: { account: ResolvedNdrAccount; runtime?: Record<string, unknown> }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx: { account: ResolvedNdrAccount; setStatus: (s: Record<string, unknown>) => void; log?: { info: (m: string) => void; debug: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } }) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
      });
      ctx.log?.info(`[${account.accountId}] starting NDR provider`);

      // Close existing bus if any (prevents duplicate listeners on restart)
      const existingBus = activeBuses.get(account.accountId);
      if (existingBus) {
        ctx.log?.info(`[${account.accountId}] closing existing NDR bus before restart`);
        existingBus.close();
        activeBuses.delete(account.accountId);
      }

      const runtime = getNdrRuntime();

      const bus = await startNdrBus({
        accountId: account.accountId,
        relays: account.relays,
        ndrPath: account.ndrPath,
        dataDir: account.dataDir,
        onReaction: (chatId, fromPubkey, messageId, emoji) => {
          const cfg = runtime.config.loadConfig();
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "ndr",
            accountId: account.accountId,
            peer: { kind: "dm", id: chatId },
          });
          const label = fromPubkey.slice(0, 8);
          const text = `NDR reaction: ${emoji} by ${label} on msg ${messageId}`;
          runtime.system.enqueueSystemEvent(text, {
            sessionKey: route.sessionKey,
            contextKey: `ndr:reaction:add:${chatId}:${messageId}:${fromPubkey}:${emoji}`,
          });
          ctx.log?.debug(`[${account.accountId}] ${text}`);
        },
        onMessage: async (chatId, messageId, senderPubkey, text, replyFn, media) => {
          ctx.log?.debug(`[${account.accountId}] Message from ${senderPubkey} in chat ${chatId}: ${text.slice(0, 50)}...${media ? ` [media: ${media.path}]` : ""}`);

          // Send seen receipt - for a bot there's no delivered-but-unread state
          if (messageId) {
            try {
              await bus.sendReceipt(chatId, "seen", [messageId]);
            } catch {
              // Receipt failed, continue anyway
            }
          }

          // Check if sender is the owner
          // Note: senderPubkey is the ephemeral key used in the message, not the identity key.
          // We need to look up the chat's their_pubkey (identity) to compare with ownerPubkey.
          let identityPubkey = senderPubkey; // fallback
          try {
            const chats = await bus.listChats();
            const chat = chats.find((c) => c.id === chatId);
            if (chat) {
              identityPubkey = chat.their_pubkey;
            }
          } catch {
            // If lookup fails, fall back to senderPubkey
          }

          const isOwner = account.ownerPubkey && identityPubkey === account.ownerPubkey;

          if (!isOwner && account.ownerPubkey) {
            // Non-owner message - log and ignore
            ctx.log?.info(`[${account.accountId}] Ignoring message from non-owner ${identityPubkey}`);
            return;
          }

          // Process the message through openclaw's reply pipeline
          const cfg = runtime.config.loadConfig();
          const ndrTo = `ndr:${chatId}`;

          // Resolve agent route for this chat
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "ndr",
            accountId: account.accountId,
            peer: { kind: "dm", id: chatId },
          });

          // Build the envelope for the message
          const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const body = runtime.channel.reply.formatInboundEnvelope({
            channel: "NDR",
            from: identityPubkey.slice(0, 16) + "...",
            body: text,
            chatType: "direct",
            sender: { name: identityPubkey.slice(0, 8), id: identityPubkey },
            envelope: envelopeOptions,
          });

          // Finalize the inbound context
          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: text,
            CommandBody: text,
            From: `ndr:${identityPubkey}`,
            To: ndrTo,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "direct" as const,
            ConversationLabel: `NDR chat ${chatId}`,
            SenderName: identityPubkey.slice(0, 8),
            SenderId: identityPubkey,
            Provider: "ndr" as const,
            Surface: "ndr" as const,
            MessageSid: `${chatId}-${Date.now()}`,
            CommandAuthorized: true, // Owner is always authorized
            OriginatingChannel: "ndr" as const,
            OriginatingTo: ndrTo,
            // Media fields (if nhash URL was downloaded)
            MediaPath: media?.path,
            MediaType: media?.mimeType ?? undefined,
            MediaUrl: media?.url,
          });

          // Record the session
          const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });
          await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            updateLastRoute: {
              sessionKey: route.mainSessionKey,
              channel: "ndr",
              to: chatId,
              accountId: route.accountId,
            },
          });

          // Create reply prefix context
          const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

          // Create typing callbacks
          const typingCallbacks = createTypingCallbacks({
            start: async () => {
              await bus.sendTyping(chatId);
            },
            onStartError: (err) => {
              logTypingFailure({
                log: (...args: unknown[]) => ctx.log?.debug(String(args.join(" "))),
                channel: "ndr",
                target: chatId,
                error: err,
              });
            },
          });

          const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
            responsePrefix: prefixContext.responsePrefix,
            responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
            humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            onReplyStart: typingCallbacks.onReplyStart,
            deliver: async (payload: { text?: string }) => {
              ctx.log?.info(`[${account.accountId}] NDR deliver called with payload: ${JSON.stringify(payload).slice(0, 200)}`);
              const responseText = payload.text ?? "";
              if (responseText) {
                ctx.log?.info(`[${account.accountId}] NDR sending reply: ${responseText.slice(0, 100)}...`);
                await replyFn(responseText);
                ctx.log?.info(`[${account.accountId}] NDR reply sent successfully`);
              } else {
                ctx.log?.warn(`[${account.accountId}] NDR deliver called but no text in payload`);
              }
            },
            onError: (err: unknown, info: { kind: string }) => {
              ctx.log?.error(`[${account.accountId}] NDR reply failed (${info.kind}): ${String(err)}`);
            },
          });

          // Dispatch the message
          await runtime.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions: {
              ...replyOptions,
              onModelSelected: (modelCtx: unknown) => {
                prefixContext.onModelSelected(modelCtx);
              },
            },
          });
          markDispatchIdle();
        },
        onError: (error, context) => {
          ctx.log?.error(`[${account.accountId}] NDR error (${context}): ${error.message}`);
        },
        onConnect: () => {
          ctx.log?.info(`[${account.accountId}] NDR listener started`);
        },
        onDisconnect: () => {
          ctx.log?.warn(`[${account.accountId}] NDR listener disconnected`);
        },
      });

      // Store the bus handle
      activeBuses.set(account.accountId, bus);

      ctx.log?.info(`[${account.accountId}] NDR provider started`);

      // Return cleanup function
      return {
        stop: () => {
          bus.close();
          activeBuses.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] NDR provider stopped`);
        },
      };
    },
  },
};

/**
 * Get all active NDR bus handles
 */
export function getActiveNdrBuses(): Map<string, NdrBusHandle> {
  return new Map(activeBuses);
}

