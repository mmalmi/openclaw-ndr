import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { deriveOwnerPubkeyHex, parseNdrChatJoinOutput } from "./onboarding-utils.js";
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
        "3. Click 'Copy your chat link' (npub link) or copy an invite URL",
        "4. Paste it below",
        "",
        "The bot will join and send a hello message (when ndr CLI is installed).",
      ].join("\n"),
      "Chat Invite",
    );

    const joinInput = await prompter.text({
      message: "Paste your chat link (npub) or invite URL",
      placeholder: "https://chat.iris.to/#npub1... or https://chat.iris.to/#%7B...%7D",
      validate: (value) => {
        if (!value?.trim()) return "Required";
        const owner = deriveOwnerPubkeyHex(value);
        if (!owner) {
          return "Invalid link. Expected an Iris chat link (npub1...) or an NDR invite URL.";
        }
        return undefined;
      },
    });

    let ownerPubkey = deriveOwnerPubkeyHex(joinInput);
    if (!ownerPubkey) {
      // This should be prevented by validation, but keep it safe.
      await prompter.note("Failed to parse link (owner pubkey missing).", "Error");
      return { cfg };
    }

    // Try to accept the invite and send hello
    let chatId: string | null = null;
    let joinError: string | null = null;
    let sendError: string | null = null;

    if (ndrAvailable) {
      const { spawnSync } = await import("child_process");
      const os = await import("os");
      const path = await import("path");

      // Use ~/.openclaw/ndr-data to match channel plugin's default dataDir
      const ndrDataDir = path.join(os.homedir(), ".openclaw", "ndr-data");

      try {
        const res = spawnSync("ndr", ["--data-dir", ndrDataDir, "--json", "chat", "join", joinInput.trim()], {
          encoding: "utf-8",
          timeout: 60000,
        });
        if (res.status !== 0) {
          joinError = (res.stderr || res.stdout || "").trim() || `ndr chat join failed (${res.status ?? "unknown"})`;
        } else {
          const parsed = parseNdrChatJoinOutput(res.stdout || "");
          chatId = parsed.chatId;
          // Use the joined peer pubkey when available (avoids fragile URL parsing).
          if (parsed.theirPubkey) {
            ownerPubkey = parsed.theirPubkey;
          }
          if (!chatId) {
            joinError = "Failed to parse chat ID from ndr output";
          }
        }
      } catch (err) {
        joinError = err instanceof Error ? err.message : String(err);
      }

      // Send hello message if we got a chat ID
      if (chatId) {
        try {
          const res = spawnSync("ndr", ["--data-dir", ndrDataDir, "--json", "send", chatId, "Hello! I'm your openclaw agent."], {
            encoding: "utf-8",
            timeout: 30000,
          });
          if (res.status !== 0) {
            sendError = (res.stderr || res.stdout || "").trim() || `ndr send failed (${res.status ?? "unknown"})`;
          }
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
      successMsg.push("", "Join manually:", `  ndr chat join "${joinInput.trim()}"`);
    } else if (!ndrAvailable) {
      successMsg.push("", "Install ndr CLI and join manually:", `  ndr chat join "${joinInput.trim()}"`);
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
