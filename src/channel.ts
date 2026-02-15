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
  normalizePubkey,
} from "./types.js";
import { startNdrBus, type NdrBusHandle } from "./ndr-bus.js";
import { ndrOnboardingAdapter } from "./onboarding.js";

// Store active bus handles per account
const activeBuses = new Map<string, NdrBusHandle>();

const GROUP_ID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isGroupId(input: string): boolean {
  return GROUP_ID_REGEX.test(input);
}

const seenGroupInvites = new Map<string, Set<string>>();

function markGroupInviteSeen(accountId: string, groupId: string): boolean {
  let seen = seenGroupInvites.get(accountId);
  if (!seen) {
    seen = new Set();
    seenGroupInvites.set(accountId, seen);
  }
  if (seen.has(groupId)) return true;
  seen.add(groupId);
  return false;
}

function normalizePubkeySafe(input?: string | null): string | null {
  if (!input) return null;
  try {
    return normalizePubkey(input);
  } catch {
    return null;
  }
}

type RuntimeConfigStore = {
  loadConfig: () => OpenClawConfig;
  writeConfigFile?: (cfg: OpenClawConfig) => Promise<void>;
};

export function withOwnerPubkeyLocked(cfg: OpenClawConfig, ownerPubkey: string): OpenClawConfig {
  const normalized = normalizePubkey(ownerPubkey);
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const ndrSection =
    channels.ndr && typeof channels.ndr === "object"
      ? (channels.ndr as Record<string, unknown>)
      : {};

  return {
    ...cfg,
    channels: {
      ...channels,
      ndr: {
        ...ndrSection,
        ownerPubkey: normalized,
      },
    },
  };
}

export function shouldAutoAcceptGroupInvite(ownerPubkey: string | null, senderPubkey?: string): boolean {
  const owner = normalizePubkeySafe(ownerPubkey);
  const sender = normalizePubkeySafe(senderPubkey);
  if (!owner || !sender) return false;
  return owner === sender;
}

export function isDirectMessageFromOwner(params: {
  identityPubkey: string;
  ownerPubkey: string | null;
}): boolean {
  const owner = normalizePubkeySafe(params.ownerPubkey);
  const sender = normalizePubkeySafe(params.identityPubkey);
  if (!owner || !sender) return false;
  return owner === sender;
}

type GroupPolicy = "open" | "allowlist" | "disabled";

type GroupGateResult = {
  allowed: boolean;
  policy: GroupPolicy;
  reason: "open" | "disabled" | "allowlist" | "group";
};

function resolveGroupPolicy(cfg: OpenClawConfig, account: ResolvedNdrAccount): GroupPolicy {
  const defaults = (cfg.channels ?? {}) as Record<string, unknown>;
  const defaultPolicy = (defaults.defaults as Record<string, unknown> | undefined)?.groupPolicy;
  const policy = account.config.groupPolicy ?? (typeof defaultPolicy === "string" ? defaultPolicy : undefined) ?? "open";
  if (policy === "open" || policy === "disabled" || policy === "allowlist") return policy;
  return "open";
}

function resolveGroupAllowGroups(groupsConfig: ResolvedNdrAccount["config"]["groups"]): string[] {
  if (Array.isArray(groupsConfig)) {
    return groupsConfig.map((g) => String(g)).filter(Boolean);
  }
  if (groupsConfig && typeof groupsConfig === "object") {
    return Object.entries(groupsConfig)
      .filter(([, value]) => (value as { enabled?: boolean } | undefined)?.enabled !== false)
      .map(([key]) => key);
  }
  return [];
}

function normalizeAllowFrom(entries: string[] | undefined, ownerPubkey: string | null): string[] {
  const normalized: string[] = [];
  for (const entry of entries ?? []) {
    const trimmed = String(entry).trim();
    if (!trimmed) continue;
    if (trimmed === "*") {
      normalized.push("*");
      continue;
    }
    try {
      normalized.push(normalizePubkey(trimmed));
    } catch {
      // Ignore invalid entries
    }
  }
  if (normalized.length === 0 && ownerPubkey) {
    normalized.push(ownerPubkey.toLowerCase());
  }
  return normalized;
}

export function isGroupMessageAllowed(params: {
  cfg: OpenClawConfig;
  account: ResolvedNdrAccount;
  groupId: string;
  senderPubkey: string;
}): GroupGateResult {
  const { cfg, account, groupId, senderPubkey } = params;
  const policy = resolveGroupPolicy(cfg, account);
  if (policy === "disabled") {
    return { allowed: false, policy, reason: "disabled" };
  }
  if (policy === "open") {
    return { allowed: true, policy, reason: "open" };
  }

  const allowFrom = normalizeAllowFrom(account.config.groupAllowFrom, account.ownerPubkey);
  if (allowFrom.length === 0) {
    return { allowed: false, policy, reason: "allowlist" };
  }
  const sender = senderPubkey.toLowerCase();
  if (!allowFrom.includes("*") && !allowFrom.includes(sender)) {
    return { allowed: false, policy, reason: "allowlist" };
  }

  const allowedGroups = resolveGroupAllowGroups(account.config.groups);
  if (allowedGroups.length > 0 && !allowedGroups.includes(groupId)) {
    return { allowed: false, policy, reason: "group" };
  }

  return { allowed: true, policy, reason: "allowlist" };
}

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
    chatTypes: ["direct", "group"],
    media: true, // Supports nhash media via htree
  },
  reload: {
    configPrefixes: [
      "channels.ndr.relays",
      "channels.ndr.enabled",
      "channels.ndr.name",
      "channels.ndr.ndrPath",
      "channels.ndr.dataDir",
      "channels.ndr.groupPolicy",
      "channels.ndr.groupAllowFrom",
      "channels.ndr.groups",
    ],
    noopPrefixes: ["channels.ndr.ownerPubkey"],
  },
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
        return /^[0-9a-fA-F]{8}$/.test(trimmed) || isGroupId(trimmed) || trimmed.startsWith("npub1");
      },
      hint: "<chat_id|group_id|npub>",
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
      if (isGroupId(to)) {
        await bus.sendGroupMessage(to, message);
      } else {
        await bus.sendMessage(to, message);
      }
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
      if (isGroupId(to)) {
        await bus.sendGroupMessage(to, message);
      } else {
        await bus.sendMessage(to, message);
      }
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
      let ownerPubkey = account.ownerPubkey;

      const ensureOwnerLocked = async (candidatePubkey: string, source: "session_created" | "first_message", chatId?: string) => {
        const normalized = normalizePubkeySafe(candidatePubkey);
        if (!normalized || ownerPubkey) return;

        ownerPubkey = normalized;
        account.ownerPubkey = normalized;

        const runtimeConfig = runtime.config as RuntimeConfigStore;
        if (typeof runtimeConfig.writeConfigFile !== "function") {
          ctx.log?.warn(
            `[${account.accountId}] Owner pubkey locked in memory from ${source}${chatId ? ` (${chatId})` : ""}, but runtime config writer is unavailable`,
          );
          return;
        }

        try {
          const nextCfg = withOwnerPubkeyLocked(runtimeConfig.loadConfig(), normalized);
          await runtimeConfig.writeConfigFile(nextCfg);
          ctx.log?.info(
            `[${account.accountId}] Locked owner pubkey from ${source}${chatId ? ` (${chatId})` : ""}`,
          );
        } catch (err) {
          ctx.log?.warn(
            `[${account.accountId}] Failed to persist owner pubkey lock from ${source}: ${String(err)}`,
          );
        }
      };

      const bus = await startNdrBus({
        accountId: account.accountId,
        relays: account.relays,
        ndrPath: account.ndrPath,
        dataDir: account.dataDir,
        onNewSession: async (newChatId, theirPubkey) => {
          await ensureOwnerLocked(theirPubkey, "session_created", newChatId);
        },
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

          await ensureOwnerLocked(identityPubkey, "first_message", chatId);

          const isOwner = isDirectMessageFromOwner({
            identityPubkey,
            ownerPubkey,
          });

          if (!isOwner && ownerPubkey) {
            // Non-owner message - log and ignore
            ctx.log?.info(
              `[${account.accountId}] Ignoring message from non-owner ${identityPubkey} in chat ${chatId}`,
            );
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
        onGroupMessage: async (groupId, messageId, senderPubkey, text, replyFn, media) => {
          ctx.log?.debug(`[${account.accountId}] Group message from ${senderPubkey} in group ${groupId}: ${text.slice(0, 50)}...${media ? ` [media: ${media.path}]` : ""}`);

          const cfg = runtime.config.loadConfig();
          const allow = isGroupMessageAllowed({
            cfg,
            account,
            groupId,
            senderPubkey,
          });

          if (!allow.allowed) {
            ctx.log?.info(`[${account.accountId}] Ignoring group message (${allow.reason}) from ${senderPubkey} in ${groupId}`);
            return;
          }

          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "ndr",
            accountId: account.accountId,
            peer: { kind: "group", id: groupId },
          });

          const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const body = runtime.channel.reply.formatInboundEnvelope({
            channel: "NDR",
            from: senderPubkey.slice(0, 16) + "...",
            body: text,
            chatType: "group",
            sender: { name: senderPubkey.slice(0, 8), id: senderPubkey },
            envelope: envelopeOptions,
          });

          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: text,
            CommandBody: text,
            From: `ndr:${senderPubkey}`,
            To: `ndr:group:${groupId}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "group" as const,
            ConversationLabel: `NDR group ${groupId}`,
            SenderName: senderPubkey.slice(0, 8),
            SenderId: senderPubkey,
            Provider: "ndr" as const,
            Surface: "ndr" as const,
            MessageSid: `${groupId}-${messageId || Date.now()}`,
            CommandAuthorized: true,
            OriginatingChannel: "ndr" as const,
            OriginatingTo: `ndr:group:${groupId}`,
            MediaPath: media?.path,
            MediaType: media?.mimeType ?? undefined,
            MediaUrl: media?.url,
          });

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
              to: groupId,
              accountId: route.accountId,
            },
          });

          const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

          const typingCallbacks = createTypingCallbacks({
            start: async () => {},
            onStartError: () => {},
          });

          const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
            responsePrefix: prefixContext.responsePrefix,
            responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
            humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            onReplyStart: typingCallbacks.onReplyStart,
            deliver: async (payload: { text?: string }) => {
              const responseText = payload.text ?? "";
              if (responseText) {
                await replyFn(responseText);
              }
            },
            onError: (err: unknown, info: { kind: string }) => {
              ctx.log?.error(`[${account.accountId}] NDR group reply failed (${info.kind}): ${String(err)}`);
            },
          });

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
        onGroupMetadata: async (groupId, action, senderPubkey) => {
          if (action !== "created") return;
          if (markGroupInviteSeen(account.accountId, groupId)) return;

          const owner = ownerPubkey;
          const senderLabel = senderPubkey ? `${senderPubkey.slice(0, 16)}...` : "unknown sender";

          if (shouldAutoAcceptGroupInvite(owner, senderPubkey)) {
            try {
              await bus.acceptGroup(groupId);
              ctx.log?.info(`[${account.accountId}] Auto-accepted group invite ${groupId} from owner`);
            } catch (err) {
              ctx.log?.warn(
                `[${account.accountId}] Failed to auto-accept group invite ${groupId} from owner: ${String(err)}`,
              );
            }
            return;
          }

          if (!owner) {
            ctx.log?.info(
              `[${account.accountId}] Group invite ${groupId} from ${senderLabel} (no owner set). Run: ndr group accept ${groupId}`,
            );
            return;
          }

          try {
            const chats = await bus.listChats();
            const ownerHex = normalizePubkeySafe(owner);
            const ownerChat = ownerHex
              ? chats.find((chat) => normalizePubkeySafe(chat.their_pubkey) === ownerHex)
              : undefined;

            if (!ownerChat) {
              ctx.log?.warn(
                `[${account.accountId}] Group invite ${groupId} from ${senderLabel} (no chat with owner). Run: ndr group accept ${groupId}`,
              );
              return;
            }

            const notice = `Group invite ${groupId} from ${senderLabel}. Run: ndr group accept ${groupId} (or ndr group delete ${groupId}).`;
            await bus.sendMessage(ownerChat.id, notice);
          } catch (err) {
            ctx.log?.warn(
              `[${account.accountId}] Failed to notify owner about group invite ${groupId}: ${String(err)}`,
            );
          }
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
