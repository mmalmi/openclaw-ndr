import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { listNdrAccountIds, resolveNdrAccount, resolveDefaultNdrAccountId } from "./types.js";

const channel = "ndr" as const;

type ChannelOnboardingAdapter = {
  channel: typeof channel;
  getStatus: (ctx: {
    cfg: OpenClawConfig;
  }) => Promise<{
    channel: typeof channel;
    configured: boolean;
    statusLines: string[];
    selectionHint?: string;
    quickstartScore?: number;
  }>;
  configure: (ctx: {
    cfg: OpenClawConfig;
    prompter: {
      note: (message: string, title?: string) => Promise<void>;
      text: (opts: {
        message: string;
        placeholder?: string;
        initialValue?: string;
        validate?: (value: string | undefined) => string | undefined;
      }) => Promise<string>;
      confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>;
    };
  }) => Promise<{ cfg: OpenClawConfig; accountId?: string }>;
  disable?: (cfg: OpenClawConfig) => OpenClawConfig;
};

/**
 * Parse an NDR invite URL to extract the inviter's hex pubkey.
 * Invite URL format: https://iris.to#{"inviter":"<hex>","ephemeralKey":"...","sharedSecret":"..."}
 */
function parseInviteUrl(url: string): { inviter: string } | null {
  try {
    const trimmed = url.trim();
    // Handle both full URL and just the fragment
    let fragment = trimmed;
    if (trimmed.includes("#")) {
      fragment = trimmed.split("#")[1] ?? "";
    }
    const decoded = decodeURIComponent(fragment);
    const data = JSON.parse(decoded) as { inviter?: string };
    if (data.inviter && /^[0-9a-fA-F]{64}$/.test(data.inviter)) {
      return { inviter: data.inviter };
    }
  } catch {
    // Invalid URL format
  }
  return null;
}

export const ndrOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const accountIds = listNdrAccountIds(cfg);
    const hasAccount = accountIds.length > 0;
    const defaultAccountId = resolveDefaultNdrAccountId(cfg);
    const account = resolveNdrAccount({ cfg, accountId: defaultAccountId });
    const enabled = account.enabled;

    return {
      channel,
      configured: hasAccount && enabled,
      statusLines: [
        `NDR: ${hasAccount ? (enabled ? "configured" : "disabled") : "not configured"}`,
      ],
      selectionHint: hasAccount
        ? enabled
          ? "configured"
          : "disabled"
        : "E2E encrypted · Nostr",
      quickstartScore: hasAccount && enabled ? 1 : 5,
    };
  },

  configure: async ({ cfg, prompter }) => {
    await prompter.note(
      [
        "NDR (Nostr Double Ratchet) provides forward-secure E2E encrypted messaging.",
        "",
        "Install dependencies (requires Rust):",
        "  curl -sSf https://sh.rustup.rs | sh && cargo install ndr hashtree-cli",
        "",
        "Control surface: chat.iris.to",
      ].join("\n"),
      "NDR Setup",
    );

    // Check if ndr CLI is available
    let ndrAvailable = false;
    try {
      const { execSync } = await import("child_process");
      execSync("ndr --version", { stdio: "ignore" });
      ndrAvailable = true;
    } catch {
      // ndr not found
    }

    // Check if hashtree-cli is available (for media attachments)
    let hashtreeAvailable = false;
    try {
      const { execSync: exec2 } = await import("child_process");
      exec2("hashtree-cli --version", { stdio: "ignore" });
      hashtreeAvailable = true;
    } catch {
      // hashtree-cli not found
    }

    if (!ndrAvailable || !hashtreeAvailable) {
      const missing: string[] = [];
      if (!ndrAvailable) missing.push("ndr (required for messaging)");
      if (!hashtreeAvailable) missing.push("hashtree-cli (required for media attachments)");
      await prompter.note(
        [
          `Missing: ${missing.join(", ")}`,
          "",
          "Install: cargo install ndr hashtree-cli",
          "",
          "You can configure now and install later.",
        ].join("\n"),
        "Warning",
      );
    }

    // Ask for invite URL from chat.iris.to
    await prompter.note(
      [
        "To connect your bot to your account:",
        "",
        "1. Go to chat.iris.to",
        "2. Click 'New Chat' (+ button)",
        "3. Click 'Copy your chat link'",
        "4. Paste the invite URL below",
        "",
        "The bot will accept your invite and send a hello message.",
      ].join("\n"),
      "Chat Invite",
    );

    const inviteUrl = await prompter.text({
      message: "Paste your chat invite URL from chat.iris.to",
      placeholder: "https://chat.iris.to/#...",
      validate: (value) => {
        if (!value?.trim()) return "Required";
        const parsed = parseInviteUrl(value);
        if (!parsed) return "Invalid invite URL. Should be from chat.iris.to";
        return undefined;
      },
    });

    const parsed = parseInviteUrl(inviteUrl);
    if (!parsed) {
      await prompter.note("Failed to parse invite URL.", "Error");
      return { cfg };
    }

    const ownerPubkey = parsed.inviter;

    // Try to accept the invite and send hello
    let chatId: string | null = null;
    let joinError: string | null = null;
    let sendError: string | null = null;

    if (ndrAvailable) {
      const { execSync } = await import("child_process");
      const os = await import("os");
      const path = await import("path");

      // Use ~/.openclaw/ndr-data to match channel plugin's default dataDir
      const ndrDataDir = path.join(os.homedir(), ".openclaw", "ndr-data");
      const ndrCmd = `ndr --data-dir "${ndrDataDir}" --json`;

      // Accept the invite
      try {
        const joinOutput = execSync(`${ndrCmd} chat join "${inviteUrl.trim()}"`, {
          encoding: "utf-8",
          timeout: 60000,
        });
        // Parse JSON output for chat ID
        // Format: { "status": "ok", "command": "chat.join", "data": { "id": "..." } }
        try {
          const joinResult = JSON.parse(joinOutput) as {
            data?: { id?: string; chat_id?: string };
            id?: string;
            chat_id?: string;
          };
          chatId = joinResult.data?.id ?? joinResult.data?.chat_id ?? joinResult.id ?? joinResult.chat_id ?? null;
        } catch {
          // Fallback: parse from text output
          const chatMatch = joinOutput.match(/chat[:\s_]+([0-9a-fA-F]{8})/i);
          if (chatMatch) chatId = chatMatch[1];
        }
      } catch (err) {
        joinError = err instanceof Error ? err.message : String(err);
      }

      // Send hello message if we got a chat ID
      if (chatId) {
        try {
          execSync(`${ndrCmd} send "${chatId}" "Hello! I'm your openclaw agent."`, {
            encoding: "utf-8",
            timeout: 30000,
          });
        } catch (err) {
          sendError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const next: OpenClawConfig = {
      ...cfg,
      channels: {
        ...cfg.channels,
        ndr: {
          ...cfg.channels?.ndr,
          enabled: true,
          ownerPubkey,
        },
      },
    };

    const successMsg: string[] = ["NDR channel configured!", "", `Owner: ${ownerPubkey.slice(0, 16)}...`];

    if (chatId) {
      successMsg.push("", `Chat established: ${chatId}`);
      if (sendError) {
        successMsg.push("", `Warning: Failed to send hello message: ${sendError.slice(0, 100)}`);
      } else {
        successMsg.push("", "Hello message sent! Check chat.iris.to");
      }
    } else if (joinError) {
      successMsg.push("", `Warning: Failed to join chat: ${joinError.slice(0, 100)}`);
      successMsg.push("", "Join manually:", `  ndr chat join "${inviteUrl.trim()}"`);
    } else if (!ndrAvailable) {
      successMsg.push("", "Install ndr CLI and join manually:", `  ndr chat join "${inviteUrl.trim()}"`);
    }

    successMsg.push("", "Start the gateway: openclaw gateway run");

    await prompter.note(successMsg.join("\n"), "Setup Complete");

    return { cfg: next };
  },

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      ndr: { ...cfg.channels?.ndr, enabled: false },
    },
  }),
};
