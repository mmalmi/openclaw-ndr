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

type ReplyContextEntry = {
  sender: string;
  body: string;
};

const REPLY_CONTEXT_CACHE_LIMIT = 500;
const replyContextCache = new Map<string, Map<string, ReplyContextEntry>>();

function cacheReplyContext(peerKey: string, messageIds: string[], entry: ReplyContextEntry): void {
  if (messageIds.length === 0) return;
  let store = replyContextCache.get(peerKey);
  if (!store) {
    store = new Map();
    replyContextCache.set(peerKey, store);
  }
  for (const rawId of messageIds) {
    const id = rawId.trim();
    if (!id) continue;
    // Refresh insertion order.
    store.delete(id);
    store.set(id, entry);
  }
  while (store.size > REPLY_CONTEXT_CACHE_LIMIT) {
    const oldest = store.keys().next().value as string | undefined;
    if (!oldest) break;
    store.delete(oldest);
  }
}

function resolveReplyContext(peerKey: string, replyToId?: string): ReplyContextEntry | undefined {
  const id = replyToId?.trim();
  if (!id) return undefined;
  return replyContextCache.get(peerKey)?.get(id);
}

type ReplyToMode = "off" | "first" | "all";

function resolveNdrReplyToMode(cfg: OpenClawConfig): ReplyToMode {
  const raw = (cfg.channels as Record<string, unknown> | undefined)?.["openclaw-ndr"] as
    | Record<string, unknown>
    | undefined;
  const mode = raw?.replyToMode;
  return mode === "off" || mode === "first" || mode === "all" ? mode : "off";
}

async function resolveNdrMediaLink(mediaUrl?: string): Promise<string> {
  const trimmed = mediaUrl?.trim();
  if (!trimmed) return "[media attachment]";
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("nhash1")) {
    return trimmed;
  }

  // Local file path: upload via htree for nhash links.
  try {
    const { execSync } = await import("child_process");
    const escapedPath = trimmed.replace(/'/g, "'\\''");
    const output = execSync(`htree add '${escapedPath}'`, {
      encoding: "utf-8",
      timeout: 60000,
    });
    const urlMatch = output.match(/url:\s+(nhash1[^\s]+)/);
    if (urlMatch) {
      return urlMatch[1];
    }
  } catch {
    // Ignore and fall back below.
  }
  return trimmed;
}

async function sendNdrTextOrMedia(params: {
  bus: NdrBusHandle;
  to: string;
  isGroup: boolean;
  text?: string;
  mediaUrl?: string;
  replyToId?: string;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<void> {
  const core = getNdrRuntime();
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "openclaw-ndr",
    accountId: params.accountId,
  });
  const caption = core.channel.text.convertMarkdownTables(params.text ?? "", tableMode);
  const replyToId = params.replyToId?.trim() || undefined;

  if (!params.mediaUrl) {
    if (params.isGroup) {
      await params.bus.sendGroupMessage(params.to, caption, { replyToId });
    } else {
      await params.bus.sendMessage(params.to, caption, { replyToId });
    }
    return;
  }

  const mediaLink = await resolveNdrMediaLink(params.mediaUrl);
  const message = caption ? `${caption}\n${mediaLink}` : mediaLink;
  if (params.isGroup) {
    await params.bus.sendGroupMessage(params.to, message, { replyToId });
  } else {
    await params.bus.sendMessage(params.to, message, { replyToId });
  }
}

const GROUP_ID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DIRECT_PREFIX = "ndr:";
const GROUP_PREFIX = "group:";
const NDR_GROUP_PREFIX = "ndr:group:";

function isGroupId(input: string): boolean {
  return GROUP_ID_REGEX.test(input);
}

type NdrReactionTarget =
  | { kind: "direct"; chatId: string }
  | { kind: "group"; groupId: string };

function normalizeNdrTarget(rawTarget: string, errMessage: string): { normalized: string; forceGroup: boolean } {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    throw new Error(errMessage);
  }

  let normalized = trimmed;
  let forceGroup = false;
  const lowered = normalized.toLowerCase();

  if (lowered.startsWith(NDR_GROUP_PREFIX)) {
    normalized = normalized.slice(NDR_GROUP_PREFIX.length).trim();
    forceGroup = true;
  } else if (lowered.startsWith(GROUP_PREFIX)) {
    normalized = normalized.slice(GROUP_PREFIX.length).trim();
    forceGroup = true;
  } else if (lowered.startsWith(DIRECT_PREFIX)) {
    normalized = normalized.slice(DIRECT_PREFIX.length).trim();
  }

  if (!normalized) {
    throw new Error(errMessage);
  }

  return { normalized, forceGroup };
}

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean; allowEmpty?: boolean },
): string | null {
  const value = params[key];
  if (typeof value !== "string") {
    if (opts?.required) {
      throw new Error(`NDR react requires ${key}.`);
    }
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed && !opts?.allowEmpty) {
    if (opts?.required) {
      throw new Error(`NDR react requires ${key}.`);
    }
    return null;
  }
  return trimmed;
}

function readRequiredStringParam(params: Record<string, unknown>, key: string): string {
  const value = readStringParam(params, key, { required: true });
  if (!value) {
    throw new Error(`NDR react requires ${key}.`);
  }
  return value;
}

function resolveReactionTarget(rawTarget: string): NdrReactionTarget {
  const { normalized, forceGroup } = normalizeNdrTarget(rawTarget, "NDR react requires target chat/group id.");

  if (forceGroup || isGroupId(normalized)) {
    return { kind: "group", groupId: normalized };
  }
  return { kind: "direct", chatId: normalized };
}

const seenGroupInvites = new Map<string, Set<string>>();
const GROUP_ACCEPT_MAX_ATTEMPTS = 5;
const GROUP_ACCEPT_RETRY_BASE_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasSeenGroupInvite(accountId: string, groupId: string): boolean {
  return seenGroupInvites.get(accountId)?.has(groupId) === true;
}

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

async function acceptGroupInviteWithRetry(bus: NdrBusHandle, groupId: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GROUP_ACCEPT_MAX_ATTEMPTS; attempt += 1) {
    try {
      await bus.acceptGroup(groupId);
      return;
    } catch (err) {
      lastError = err;
      if (attempt >= GROUP_ACCEPT_MAX_ATTEMPTS) {
        break;
      }
      await sleep(GROUP_ACCEPT_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    channels["openclaw-ndr"] && typeof channels["openclaw-ndr"] === "object"
      ? (channels["openclaw-ndr"] as Record<string, unknown>)
      : {};

  return {
    ...cfg,
    channels: {
      ...channels,
      "openclaw-ndr": {
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
  id: "openclaw-ndr",
  meta: {
    id: "openclaw-ndr",
    label: "NDR",
    selectionLabel: "NDR (Nostr Double Ratchet)",
    docsPath: "/channels/openclaw-ndr",
    docsLabel: "openclaw-ndr",
    blurb: "Forward-secure E2E encryption via double ratchet over Nostr (chat.iris.to).",
    order: 56,
    selectionExtras: ["https://chat.iris.to"],
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: true,
    media: true, // Supports nhash media via htree
    reply: true,
  },
  reload: {
    configPrefixes: [
      "channels.openclaw-ndr.relays",
      "channels.openclaw-ndr.enabled",
      "channels.openclaw-ndr.name",
      "channels.openclaw-ndr.ndrPath",
      "channels.openclaw-ndr.dataDir",
      "channels.openclaw-ndr.groupPolicy",
      "channels.openclaw-ndr.groupAllowFrom",
      "channels.openclaw-ndr.groups",
    ],
    noopPrefixes: ["channels.openclaw-ndr.ownerPubkey"],
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
  actions: {
    listActions: ({ cfg }: { cfg: OpenClawConfig }) => {
      const accountId = resolveDefaultNdrAccountId(cfg);
      if (!accountId) {
        return [];
      }
      return ["send", "react"];
    },
    supportsAction: ({ action }: { action: string }) => action === "react",
    handleAction: async ({
      action,
      params,
      accountId,
      cfg,
    }: {
      action: string;
      params: Record<string, unknown>;
      accountId?: string | null;
      cfg: OpenClawConfig;
    }) => {
      if (action !== "react") {
        throw new Error(`Action ${action} is not supported for provider ndr.`);
      }
      const aid =
        accountId ??
        readStringParam(params, "accountId") ??
        resolveDefaultNdrAccountId(cfg) ??
        DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`NDR bus not running for account ${aid}`);
      }

      const target =
        readStringParam(params, "to") ??
        readStringParam(params, "target") ??
        readStringParam(params, "chatId") ??
        readStringParam(params, "groupId");
      if (!target) {
        throw new Error("NDR react requires to/target/chatId/groupId.");
      }

      const remove = params.remove === true;
      if (remove) {
        throw new Error("NDR reaction removal is not supported by ndr CLI.");
      }

      const messageId = readRequiredStringParam(params, "messageId");
      const emoji = readRequiredStringParam(params, "emoji");
      const resolvedTarget = resolveReactionTarget(target);

      if (resolvedTarget.kind === "group") {
        await bus.reactGroup(resolvedTarget.groupId, messageId, emoji);
      } else {
        await bus.react(resolvedTarget.chatId, messageId, emoji);
      }

      return {
        ok: true,
        action: "react",
        added: emoji,
        target:
          resolvedTarget.kind === "group" ? `group:${resolvedTarget.groupId}` : resolvedTarget.chatId,
      };
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async (params: { to: string; text?: string; accountId?: string; replyToId?: string }) => {
      const core = getNdrRuntime();
      const aid = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`NDR bus not running for account ${aid}`);
      }
      const cfg = core.config.loadConfig();
      const { normalized: to, forceGroup } = normalizeNdrTarget(params.to, "NDR send requires target chat/group id.");
      const isGroup = forceGroup || isGroupId(to);
      await sendNdrTextOrMedia({
        bus,
        to,
        isGroup,
        text: params.text,
        replyToId: params.replyToId,
        cfg,
        accountId: aid,
      });
      return { channel: "openclaw-ndr", to };
    },
    sendMedia: async (params: { to: string; text?: string; mediaUrl?: string; accountId?: string; replyToId?: string }) => {
      const core = getNdrRuntime();
      const aid = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`NDR bus not running for account ${aid}`);
      }
      const cfg = core.config.loadConfig();
      const { normalized: to, forceGroup } = normalizeNdrTarget(params.to, "NDR send requires target chat/group id.");
      const isGroup = forceGroup || isGroupId(to);
      await sendNdrTextOrMedia({
        bus,
        to,
        isGroup,
        text: params.text,
        mediaUrl: params.mediaUrl,
        replyToId: params.replyToId,
        cfg,
        accountId: aid,
      });
      return { channel: "openclaw-ndr", to };
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
            channel: "openclaw-ndr",
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
            channel: "openclaw-ndr",
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
        onGroupReaction: (groupId, fromPubkey, messageId, emoji) => {
          const cfg = runtime.config.loadConfig();
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "openclaw-ndr",
            accountId: account.accountId,
            peer: { kind: "group", id: groupId },
          });
          const label = fromPubkey.slice(0, 8);
          const text = `NDR group reaction: ${emoji} by ${label} on msg ${messageId}`;
          runtime.system.enqueueSystemEvent(text, {
            sessionKey: route.sessionKey,
            contextKey: `ndr:group-reaction:add:${groupId}:${messageId}:${fromPubkey}:${emoji}`,
          });
          ctx.log?.debug(`[${account.accountId}] ${text}`);
        },
        onMessage: async (chatId, messageId, senderPubkey, text, _replyFn, media, messageIds, replyToId) => {
          ctx.log?.debug(`[${account.accountId}] Message from ${senderPubkey} in chat ${chatId}: ${text.slice(0, 50)}...${media ? ` [media: ${media.path}]` : ""}`);

          // Send seen receipt - for a bot there's no delivered-but-unread state
          const receiptMessageIds = Array.from(new Set([...(messageIds ?? []), messageId].filter(Boolean)));
          if (receiptMessageIds.length > 0) {
            try {
              await bus.sendReceipt(chatId, "seen", receiptMessageIds);
            } catch (err) {
              ctx.log?.warn(
                `[${account.accountId}] Failed to send seen receipt for ${chatId}/${receiptMessageIds.join(",")}: ${String(err)}`,
              );
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
            channel: "openclaw-ndr",
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

          const peerKey = `dm:${chatId}`;
          cacheReplyContext(peerKey, receiptMessageIds, { sender: identityPubkey, body: text });
          const cachedReply = resolveReplyContext(peerKey, replyToId);
          const sid = receiptMessageIds[0] ?? `${chatId}-${Date.now()}`;

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
            Provider: "openclaw-ndr" as const,
            Surface: "openclaw-ndr" as const,
            MessageSid: sid,
            MessageSids: receiptMessageIds.length > 0 ? receiptMessageIds : undefined,
            ReplyToId: replyToId?.trim() || undefined,
            ReplyToBody: replyToId
              ? (cachedReply?.body ?? `(reply to message id: ${replyToId})`)
              : undefined,
            ReplyToSender: cachedReply?.sender,
            CommandAuthorized: true, // Owner is always authorized
            OriginatingChannel: "openclaw-ndr" as const,
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
              channel: "openclaw-ndr",
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
                channel: "openclaw-ndr",
                target: chatId,
                error: err,
              });
            },
          });

          const replyToMode = resolveNdrReplyToMode(cfg);
          let hasRepliedRef = false;

          const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
            responsePrefix: prefixContext.responsePrefix,
            responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
            humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            onReplyStart: typingCallbacks.onReplyStart,
            deliver: async (payload: Record<string, unknown>) => {
              const text = typeof payload.text === "string" ? payload.text : "";
              const mediaUrls = Array.isArray(payload.mediaUrls)
                ? payload.mediaUrls.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
                : [];
              const mediaUrl = typeof payload.mediaUrl === "string" ? payload.mediaUrl.trim() : "";
              const mediaList = mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];

              if (!text && mediaList.length === 0) {
                return;
              }

              const replyRefCandidate =
                typeof payload.replyToId === "string" && payload.replyToId.trim()
                  ? payload.replyToId.trim()
                  : undefined;
              const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
              const shouldUseReplyRef = (): string | undefined => {
                if (!replyRefCandidate) return undefined;
                if (replyToMode === "off") {
                  return isExplicit ? replyRefCandidate : undefined;
                }
                if (replyToMode === "all") {
                  return replyRefCandidate;
                }
                if (hasRepliedRef) {
                  return undefined;
                }
                return replyRefCandidate;
              };

              const sendReply = async (opts: { text?: string; mediaUrl?: string }) => {
                const replyToId = shouldUseReplyRef();
                await sendNdrTextOrMedia({
                  bus,
                  to: chatId,
                  isGroup: false,
                  text: opts.text,
                  mediaUrl: opts.mediaUrl,
                  replyToId,
                  cfg,
                  accountId: account.accountId,
                });
                if (replyToMode === "first" && replyToId) {
                  hasRepliedRef = true;
                }
              };

              if (mediaList.length === 0) {
                await sendReply({ text });
                return;
              }

              let first = true;
              for (const url of mediaList) {
                await sendReply({ text: first ? text : undefined, mediaUrl: url });
                first = false;
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
        onGroupMessage: async (groupId, messageId, senderPubkey, text, _replyFn, media, replyToId) => {
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
            channel: "openclaw-ndr",
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

          const peerKey = `group:${groupId}`;
          const sids = messageId ? [messageId] : [];
          if (messageId) {
            cacheReplyContext(peerKey, [messageId], { sender: senderPubkey, body: text });
          }
          const cachedReply = resolveReplyContext(peerKey, replyToId);
          const sid = messageId || `${groupId}-${Date.now()}`;

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
            Provider: "openclaw-ndr" as const,
            Surface: "openclaw-ndr" as const,
            MessageSid: sid,
            MessageSids: sids.length > 0 ? sids : undefined,
            ReplyToId: replyToId?.trim() || undefined,
            ReplyToBody: replyToId
              ? (cachedReply?.body ?? `(reply to message id: ${replyToId})`)
              : undefined,
            ReplyToSender: cachedReply?.sender,
            CommandAuthorized: true,
            OriginatingChannel: "openclaw-ndr" as const,
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
              channel: "openclaw-ndr",
              to: groupId,
              accountId: route.accountId,
            },
          });

          const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

          const typingCallbacks = createTypingCallbacks({
            start: async () => {},
            onStartError: () => {},
          });

          const replyToMode = resolveNdrReplyToMode(cfg);
          let hasRepliedRef = false;

          const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
            responsePrefix: prefixContext.responsePrefix,
            responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
            humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            onReplyStart: typingCallbacks.onReplyStart,
            deliver: async (payload: Record<string, unknown>) => {
              const text = typeof payload.text === "string" ? payload.text : "";
              const mediaUrls = Array.isArray(payload.mediaUrls)
                ? payload.mediaUrls.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
                : [];
              const mediaUrl = typeof payload.mediaUrl === "string" ? payload.mediaUrl.trim() : "";
              const mediaList = mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];

              if (!text && mediaList.length === 0) {
                return;
              }

              const replyRefCandidate =
                typeof payload.replyToId === "string" && payload.replyToId.trim()
                  ? payload.replyToId.trim()
                  : undefined;
              const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
              const shouldUseReplyRef = (): string | undefined => {
                if (!replyRefCandidate) return undefined;
                if (replyToMode === "off") {
                  return isExplicit ? replyRefCandidate : undefined;
                }
                if (replyToMode === "all") {
                  return replyRefCandidate;
                }
                if (hasRepliedRef) {
                  return undefined;
                }
                return replyRefCandidate;
              };

              const sendReply = async (opts: { text?: string; mediaUrl?: string }) => {
                const replyToId = shouldUseReplyRef();
                await sendNdrTextOrMedia({
                  bus,
                  to: groupId,
                  isGroup: true,
                  text: opts.text,
                  mediaUrl: opts.mediaUrl,
                  replyToId,
                  cfg,
                  accountId: account.accountId,
                });
                if (replyToMode === "first" && replyToId) {
                  hasRepliedRef = true;
                }
              };

              if (mediaList.length === 0) {
                await sendReply({ text });
                return;
              }

              let first = true;
              for (const url of mediaList) {
                await sendReply({ text: first ? text : undefined, mediaUrl: url });
                first = false;
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

          const owner = ownerPubkey;
          const senderLabel = senderPubkey ? `${senderPubkey.slice(0, 16)}...` : "unknown sender";

          if (shouldAutoAcceptGroupInvite(owner, senderPubkey)) {
            if (hasSeenGroupInvite(account.accountId, groupId)) return;
            try {
              await acceptGroupInviteWithRetry(bus, groupId);
              markGroupInviteSeen(account.accountId, groupId);
              ctx.log?.info(`[${account.accountId}] Auto-accepted group invite ${groupId} from owner`);
            } catch (err) {
              ctx.log?.warn(
                `[${account.accountId}] Failed to auto-accept group invite ${groupId} from owner: ${String(err)}`,
              );
            }
            return;
          }

          if (markGroupInviteSeen(account.accountId, groupId)) return;

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
