import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { extractAndDownloadMedia, type DownloadedMedia } from "./media.js";

export interface NdrMessageMedia {
  path: string;
  mimeType: string | null;
  url: string;
}

export interface NdrBusOptions {
  accountId: string;
  relays: string[];
  ndrPath: string;
  dataDir: string | null;
  onMessage: (
    chatId: string,
    messageId: string,
    senderPubkey: string,
    text: string,
    reply: (text: string) => Promise<void>,
    media?: NdrMessageMedia,
    messageIds?: string[],
  ) => Promise<void>;
  onGroupMessage?: (groupId: string, messageId: string, senderPubkey: string, text: string, reply: (text: string) => Promise<void>, media?: NdrMessageMedia) => Promise<void>;
  onReaction?: (chatId: string, fromPubkey: string, messageId: string, emoji: string) => void;
  onGroupReaction?: (groupId: string, fromPubkey: string, messageId: string, emoji: string) => void;
  onGroupTyping?: (groupId: string, fromPubkey: string) => void;
  onGroupMetadata?: (groupId: string, action: string, senderPubkey?: string) => void;
  onNewSession?: (chatId: string, theirPubkey: string) => Promise<void>;
  onError?: (error: Error, context: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface NdrBusHandle {
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendGroupMessage: (groupId: string, text: string) => Promise<void>;
  acceptGroup: (groupId: string) => Promise<void>;
  react: (chatId: string, messageId: string, emoji: string) => Promise<void>;
  reactGroup: (groupId: string, messageId: string, emoji: string) => Promise<void>;
  sendReceipt: (chatId: string, receiptType: 'delivered' | 'seen', messageIds: string[]) => Promise<void>;
  sendTyping: (chatId: string) => Promise<void>;
  createInvite: () => Promise<{ inviteUrl: string; inviteId: string }>;
  joinInvite: (inviteUrl: string) => Promise<{ chatId: string; theirPubkey: string }>;
  listChats: () => Promise<Array<{ id: string; their_pubkey: string }>>;
  close: () => void;
  isRunning: () => boolean;
}

export type ParsedNdrEvent =
  | {
      type: "message";
      chatId: string;
      messageId: string;
      messageIds: string[];
      senderPubkey: string;
      content: string;
      timestamp?: number;
    }
  | {
      type: "reaction";
      chatId: string;
      messageId: string;
      fromPubkey: string;
      emoji: string;
      timestamp?: number;
    }
  | {
      type: "session_created";
      chatId: string;
      theirPubkey: string;
    }
  | {
      type: "group_message";
      groupId: string;
      messageId: string;
      senderPubkey: string;
      content: string;
      timestamp?: number;
    }
  | {
      type: "group_reaction";
      groupId: string;
      messageId: string;
      fromPubkey: string;
      emoji: string;
      timestamp?: number;
    }
  | {
      type: "group_typing";
      groupId: string;
      fromPubkey: string;
      timestamp?: number;
    }
  | {
      type: "group_metadata";
      groupId: string;
      action: string;
      senderPubkey?: string;
    };

function collectMessageIds(json: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    json.inner_message_id,
    json.innerMessageId,
    json.rumor_id,
    json.rumorId,
    json.inner_id,
    json.innerId,
    json.message_id,
    json.messageId,
    json.id,
    json.outer_message_id,
    json.outerMessageId,
    json.event_id,
    json.eventId,
  ];
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed || ids.includes(trimmed)) continue;
    ids.push(trimmed);
  }
  return ids;
}

export function parseNdrEvent(line: string): ParsedNdrEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const event = json.event;
  if (typeof event !== "string") return null;

  switch (event) {
    case "message":
      {
        const chatId = typeof json.chat_id === "string" ? json.chat_id : (typeof json.chatId === "string" ? json.chatId : null);
        const senderPubkey = typeof json.from_pubkey === "string"
          ? json.from_pubkey
          : (typeof json.sender_pubkey === "string" ? json.sender_pubkey : null);
        const content = typeof json.content === "string" ? json.content : null;
        if (!chatId || !senderPubkey || content === null) return null;
        const messageIds = collectMessageIds(json);
        const messageId = messageIds[0] ?? "";
        return {
          type: "message",
          chatId,
          messageId,
          messageIds,
          senderPubkey,
          content,
          timestamp: typeof json.timestamp === "number" ? json.timestamp : undefined,
        };
      }
      return null;
    case "reaction":
      {
        const chatId = typeof json.chat_id === "string" ? json.chat_id : (typeof json.chatId === "string" ? json.chatId : null);
        const fromPubkey = typeof json.from_pubkey === "string"
          ? json.from_pubkey
          : (typeof json.sender_pubkey === "string" ? json.sender_pubkey : null);
        const emoji = typeof json.emoji === "string" ? json.emoji : null;
        if (!chatId || !fromPubkey || emoji === null) return null;
        const messageId =
          typeof json.message_id === "string"
            ? json.message_id
            : (typeof json.messageId === "string" ? json.messageId : "");
        return {
          type: "reaction",
          chatId,
          messageId,
          fromPubkey,
          emoji,
          timestamp: typeof json.timestamp === "number" ? json.timestamp : undefined,
        };
      }
      return null;
    case "session_created":
      if (typeof json.chat_id === "string" && typeof json.their_pubkey === "string") {
        return {
          type: "session_created",
          chatId: json.chat_id,
          theirPubkey: json.their_pubkey,
        };
      }
      return null;
    case "group_message":
      {
        const groupId = typeof json.group_id === "string" ? json.group_id : null;
        const senderPubkey = typeof json.sender_pubkey === "string"
          ? json.sender_pubkey
          : (typeof json.from_pubkey === "string" ? json.from_pubkey : null);
        const content = typeof json.content === "string" ? json.content : null;
        if (!groupId || !senderPubkey || content === null) return null;
        const messageId =
          typeof json.message_id === "string"
            ? json.message_id
            : (typeof json.messageId === "string" ? json.messageId : (typeof json.id === "string" ? json.id : ""));
        return {
          type: "group_message",
          groupId,
          messageId,
          senderPubkey,
          content,
          timestamp: typeof json.timestamp === "number" ? json.timestamp : undefined,
        };
      }
      return null;
    case "group_reaction":
      {
        const groupId = typeof json.group_id === "string" ? json.group_id : null;
        const fromPubkey = typeof json.sender_pubkey === "string"
          ? json.sender_pubkey
          : (typeof json.from_pubkey === "string" ? json.from_pubkey : null);
        const emoji = typeof json.emoji === "string" ? json.emoji : null;
        if (!groupId || !fromPubkey || emoji === null) return null;
        const messageId =
          typeof json.message_id === "string"
            ? json.message_id
            : (typeof json.messageId === "string" ? json.messageId : "");
        return {
          type: "group_reaction",
          groupId,
          messageId,
          fromPubkey,
          emoji,
          timestamp: typeof json.timestamp === "number" ? json.timestamp : undefined,
        };
      }
      return null;
    case "group_typing":
      if (typeof json.group_id === "string" && typeof json.sender_pubkey === "string") {
        return {
          type: "group_typing",
          groupId: json.group_id,
          fromPubkey: json.sender_pubkey,
          timestamp: typeof json.timestamp === "number" ? json.timestamp : undefined,
        };
      }
      return null;
    case "group_metadata":
      if (typeof json.group_id === "string" && typeof json.action === "string") {
        return {
          type: "group_metadata",
          groupId: json.group_id,
          action: json.action,
          senderPubkey: typeof json.sender_pubkey === "string" ? json.sender_pubkey : undefined,
        };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Start the NDR bus - manages ndr CLI process for listening and sending
 *
 * The `ndr listen` command handles both incoming messages AND invite responses,
 * so we only need a single listener process.
 */
export async function startNdrBus(options: NdrBusOptions): Promise<NdrBusHandle> {
  const {
    relays,
    ndrPath,
    dataDir,
    onMessage,
    onGroupMessage,
    onReaction,
    onGroupReaction,
    onGroupTyping,
    onGroupMetadata,
    onNewSession,
    onError,
    onConnect,
    onDisconnect,
  } = options;

  let listenProcess: ChildProcess | null = null;
  let running = false;

  // Build common args
  const baseArgs: string[] = ["--json"];
  if (dataDir) {
    baseArgs.push("--data-dir", dataDir);
  }

  // ndr manages its own identity in its config.json (auto-generates on first use)

  const ndrEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(relays.length ? { NOSTR_RELAYS: relays.join(",") } : {}),
  };

  const ensureIdentity = async () => {
    const whoami = await runNdrCommand(ndrPath, [...baseArgs, "whoami"], ndrEnv);
    const loggedIn = (whoami.status === "ok" && typeof whoami.data === "object" && whoami.data !== null)
      ? (whoami.data as { logged_in?: boolean }).logged_in
      : undefined;
    if (loggedIn === false) {
      const sk = randomBytes(32).toString("hex");
      const login = await runNdrCommand(ndrPath, [...baseArgs, "login", sk], ndrEnv);
      if (login.status !== "ok") {
        throw new Error(login.error || "Failed to initialize NDR identity");
      }
    }
  };

  // Start listening for messages and invite responses (both handled by `ndr listen`)
  const startListening = () => {
    listenProcess = spawn(ndrPath, [...baseArgs, "listen"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: ndrEnv,
    });

    listenProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        const parsed = parseNdrEvent(line);
        if (!parsed) continue;

        if (parsed.type === "message") {
          const { chatId, messageId, messageIds, senderPubkey, content } = parsed;

          const reply = async (text: string) => {
              await runNdrCommand(ndrPath, [...baseArgs, "send", chatId, text], ndrEnv);
            };

          extractAndDownloadMedia(content).then(({ media, textContent }) => {
            const messageMedia = media ? {
              path: media.path,
              mimeType: media.mimeType,
              url: media.url,
            } : undefined;
            const nextContent = media ? textContent : content;
            onMessage(chatId, messageId, senderPubkey, nextContent, reply, messageMedia, messageIds).catch((err) => {
              onError?.(err, "message_handler");
            });
          }).catch((err) => {
            onMessage(chatId, messageId, senderPubkey, content, reply, undefined, messageIds).catch((handlerErr) => {
              onError?.(handlerErr, "message_handler");
            });
          });
          continue;
        }

        if (parsed.type === "group_message") {
          const { groupId, messageId, senderPubkey, content } = parsed;
          const reply = async (text: string) => {
            await runNdrCommand(ndrPath, [...baseArgs, "group", "send", groupId, text], ndrEnv);
          };

          if (!onGroupMessage) continue;
          extractAndDownloadMedia(content).then(({ media, textContent }) => {
            const messageMedia = media ? {
              path: media.path,
              mimeType: media.mimeType,
              url: media.url,
            } : undefined;
            const nextContent = media ? textContent : content;
            onGroupMessage(groupId, messageId, senderPubkey, nextContent, reply, messageMedia).catch((err) => {
              onError?.(err, "group_message_handler");
            });
          }).catch((err) => {
            onGroupMessage(groupId, messageId, senderPubkey, content, reply).catch((handlerErr) => {
              onError?.(handlerErr, "group_message_handler");
            });
          });
          continue;
        }

        if (parsed.type === "reaction") {
          onReaction?.(parsed.chatId, parsed.fromPubkey, parsed.messageId, parsed.emoji);
          continue;
        }

        if (parsed.type === "group_reaction") {
          onGroupReaction?.(parsed.groupId, parsed.fromPubkey, parsed.messageId, parsed.emoji);
          continue;
        }

        if (parsed.type === "group_typing") {
          onGroupTyping?.(parsed.groupId, parsed.fromPubkey);
          continue;
        }

        if (parsed.type === "group_metadata") {
          onGroupMetadata?.(parsed.groupId, parsed.action, parsed.senderPubkey);
          continue;
        }

        if (parsed.type === "session_created") {
          onNewSession?.(parsed.chatId, parsed.theirPubkey).catch((err) => {
            onError?.(err, "new_session_handler");
          });
          continue;
        }
      }
    });

    listenProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text && !text.includes("Listening")) {
        onError?.(new Error(text), "listen_stderr");
      }
    });

    listenProcess.on("exit", (code) => {
      if (running && code !== 0) {
        onError?.(new Error(`ndr listen exited with code ${code}`), "listen_exit");
        setTimeout(() => running && startListening(), 5000);
      }
    });

    listenProcess.on("error", (err) => {
      onError?.(err, "listen_spawn");
    });
  };

  running = true;
  onConnect?.();
  await ensureIdentity();
  startListening();

  return {
    sendMessage: async (chatId: string, text: string) => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "send", chatId, text], ndrEnv);
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to send message");
      }
    },
    sendGroupMessage: async (groupId: string, text: string) => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "group", "send", groupId, text], ndrEnv);
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to send group message");
      }
    },
    acceptGroup: async (groupId: string) => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "group", "accept", groupId], ndrEnv);
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to accept group invite");
      }
    },

    react: async (chatId: string, messageId: string, emoji: string) => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "react", chatId, messageId, emoji], ndrEnv);
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to send reaction");
      }
    },
    reactGroup: async (groupId: string, messageId: string, emoji: string) => {
      const result = await runNdrCommand(
        ndrPath,
        [...baseArgs, "group", "react", groupId, messageId, emoji],
        ndrEnv,
      );
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to send group reaction");
      }
    },

    sendReceipt: async (chatId: string, receiptType: 'delivered' | 'seen', messageIds: string[]) => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "receipt", chatId, receiptType, ...messageIds], ndrEnv);
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to send receipt");
      }
    },

    sendTyping: async (chatId: string) => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "typing", chatId], ndrEnv);
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to send typing indicator");
      }
    },

    createInvite: async () => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "invite", "create"], ndrEnv);
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to create invite");
      }
      const data = result.data as { url: string; id: string };
      return { inviteUrl: data.url, inviteId: data.id };
    },

    joinInvite: async (inviteUrl: string) => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "chat", "join", inviteUrl], ndrEnv);
      if (result.status !== "ok") {
        throw new Error(result.error || "Failed to join invite");
      }
      const data = result.data as { id: string; their_pubkey: string };
      return { chatId: data.id, theirPubkey: data.their_pubkey };
    },

    listChats: async () => {
      const result = await runNdrCommand(ndrPath, [...baseArgs, "chat", "list"], ndrEnv);
      if (result.status === "ok" && result.data) {
        const data = result.data as { chats: Array<{ id: string; their_pubkey: string }> };
        return data.chats || [];
      }
      return [];
    },

    close: () => {
      running = false;
      onDisconnect?.();
      if (listenProcess) {
        listenProcess.kill();
        listenProcess = null;
      }
    },

    isRunning: () => running,
  };
}

/**
 * Run an ndr CLI command and return parsed JSON output
 */
async function runNdrCommand(
  ndrPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ status: string; error?: string; data?: unknown }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ndrPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("exit", (code) => {
      if (code === 0) {
        try {
          const json = JSON.parse(stdout.trim());
          resolve(json);
        } catch {
          resolve({ status: "ok", data: stdout.trim() });
        }
      } else {
        resolve({ status: "error", error: stderr.trim() || `Exit code ${code}` });
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Get chat list from ndr
 */
export async function listChats(ndrPath: string, dataDir: string | null): Promise<Array<{ id: string; their_pubkey: string }>> {
  const args = ["--json"];
  if (dataDir) {
    args.push("--data-dir", dataDir);
  }
  args.push("chat", "list");

  const result = await runNdrCommand(ndrPath, args);
  if (result.status === "ok" && Array.isArray(result.data)) {
    return result.data as Array<{ id: string; their_pubkey: string }>;
  }
  return [];
}

/**
 * Join a chat via invite URL
 */
export async function joinChat(
  ndrPath: string,
  dataDir: string | null,
  inviteUrl: string
): Promise<{ chatId: string; theirPubkey: string }> {
  const args = ["--json"];
  if (dataDir) {
    args.push("--data-dir", dataDir);
  }
  args.push("chat", "join", inviteUrl);

  const result = await runNdrCommand(ndrPath, args);
  if (result.status !== "ok") {
    throw new Error(result.error || "Failed to join chat");
  }

  const data = result.data as { id: string; their_pubkey: string };
  return { chatId: data.id, theirPubkey: data.their_pubkey };
}

/**
 * Create an invite
 */
export async function createInvite(
  ndrPath: string,
  dataDir: string | null
): Promise<{ inviteUrl: string; inviteId: string }> {
  const args = ["--json"];
  if (dataDir) {
    args.push("--data-dir", dataDir);
  }
  args.push("invite", "create");

  const result = await runNdrCommand(ndrPath, args);
  if (result.status !== "ok") {
    throw new Error(result.error || "Failed to create invite");
  }

  const data = result.data as { url: string; id: string };
  return { inviteUrl: data.url, inviteId: data.id };
}
