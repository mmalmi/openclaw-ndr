import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { startNdrBus } from "./ndr-bus.js";
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

    if (!ndrAvailable) {
      await prompter.note(
        [
          "Missing: ndr (required for pairing and messaging)",
          "",
          "Install: cargo install ndr hashtree-cli",
          "",
          "Then re-run: openclaw onboard",
        ].join("\n"),
        "Blocked",
      );
      return { cfg };
    }

    if (!hashtreeAvailable) {
      await prompter.note(
        [
          "Missing: hashtree-cli (required for media attachments)",
          "",
          "Install: cargo install hashtree-cli",
          "",
          "You can continue without it (text-only).",
        ].join("\n"),
        "Warning",
      );
    }

    const defaultAccountId = resolveDefaultNdrAccountId(cfg);
    const account = resolveNdrAccount({ cfg, accountId: defaultAccountId });

    // Pairing flow: bot generates a private invite URL; user opens it in chat.iris.to.
    // We'll wait for the invite to be accepted, then lock the agent to that pubkey.
    const timeoutMs = 120_000;
    const startedAt = Date.now();
    const beforeChatIds = new Set<string>();
    let baselineOk = false;
    let lastError: string | null = null;
    let chatId: string | null = null;
    let ownerPubkey: string | null = null;
    let sendError: string | null = null;

    const bus = await startNdrBus({
      accountId: account.accountId,
      relays: account.relays,
      ndrPath: account.ndrPath,
      dataDir: account.dataDir,
      onMessage: async () => {},
      onNewSession: async (newChatId, theirPubkey) => {
        chatId = newChatId;
        ownerPubkey = theirPubkey;
      },
      onError: (err, context) => {
        lastError = `${context}: ${err instanceof Error ? err.message : String(err)}`;
      },
    });

    try {
      try {
        for (const entry of await bus.listChats()) {
          beforeChatIds.add(entry.id);
        }
        baselineOk = true;
      } catch {
        // If we can't list chats, do not attempt diff-based pairing (could mis-pair).
        baselineOk = false;
      }

      const invite = await bus.createInvite();

      let qr = "";
      try {
        const mod = await import("qrcode-terminal");
        const qrcode: {
          generate: (
            input: string,
            opts: { small?: boolean },
            cb: (code: string) => void,
          ) => void;
        } = (mod as unknown as { default?: unknown }).default
          ? ((mod as unknown as { default: unknown }).default as typeof qrcode)
          : (mod as unknown as typeof qrcode);
        qr = await new Promise<string>((resolve) => {
          qrcode.generate(invite.inviteUrl, { small: true }, (code) => resolve(code));
        });
      } catch {
        // QR optional
      }

      const lines = [
        "Open this one-time pairing link in chat.iris.to (or scan the QR):",
        "",
        invite.inviteUrl,
      ];
      if (qr.trim()) {
        lines.push("", qr.trimEnd());
      }
      lines.push("", `Waiting up to ${Math.round(timeoutMs / 1000)}s for you to accept…`);
      await prompter.note(lines.join("\n"), "Pairing");

      while (Date.now() - startedAt < timeoutMs) {
        if (chatId && ownerPubkey) {
          break;
        }
        if (baselineOk) {
          try {
            const chats = await bus.listChats();
            const newlyCreated = chats.find((c) => !beforeChatIds.has(c.id));
            if (newlyCreated) {
              chatId = newlyCreated.id;
              ownerPubkey = newlyCreated.their_pubkey;
              break;
            }
          } catch {
            // ignore polling failures
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!chatId || !ownerPubkey) {
        const detail = lastError ? `Last error: ${lastError}` : "No session detected.";
        await prompter.note(
          [
            `Timed out waiting for pairing (${Math.round(timeoutMs / 1000)}s).`,
            detail,
            "",
            "You can try again: openclaw onboard",
          ].join("\n"),
          "Pairing Failed",
        );
        return { cfg };
      }

      // Send hello message once paired.
      try {
        await bus.sendMessage(chatId, "Hello! I'm your openclaw agent.");
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
      }

      const next: OpenClawConfig = {
        ...cfg,
        channels: {
          ...cfg.channels,
          ndr: {
            ...cfg.channels?.ndr,
            enabled: true,
            ownerPubkey,
            ownerChatId: chatId,
          },
        },
      };

      const successMsg: string[] = [
        "NDR channel configured!",
        "",
        `Owner: ${ownerPubkey.slice(0, 16)}...`,
        `Chat established: ${chatId}`,
      ];
      if (sendError) {
        successMsg.push("", `Warning: Failed to send hello message: ${sendError.slice(0, 100)}`);
        if (sendError.toLowerCase().includes("not initiator")) {
          successMsg.push(
            "",
            "Tip: start the gateway first, then send the first message from chat.iris.to.",
          );
        }
      } else {
        successMsg.push("", "Hello message sent! Check chat.iris.to");
      }
      successMsg.push("", "Start the gateway: openclaw gateway run");
      successMsg.push("", "After the gateway starts, send a fresh message to verify delivery.");

      await prompter.note(successMsg.join("\n"), "Setup Complete");

      return { cfg: next };
    } finally {
      bus.close();
    }

  },

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      ndr: { ...cfg.channels?.ndr, enabled: false },
    },
  }),
};
