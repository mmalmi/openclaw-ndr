import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { ndrOnboardingAdapter } from "./onboarding.js";
import { startNdrBus } from "./ndr-bus.js";

vi.mock("./ndr-bus.js", () => ({
  startNdrBus: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

type WizardPrompter = {
  note: (message: string, title?: string) => Promise<void>;
  text: (opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (value: string | undefined) => string | undefined;
  }) => Promise<string>;
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>;
};

function createPrompter() {
  const notes: Array<{ title?: string; message: string }> = [];
  const prompter: WizardPrompter = {
    note: async (message: string, title?: string) => {
      notes.push({ title, message });
    },
    text: async () => "",
    confirm: async () => true,
  };
  return { prompter, notes };
}

function hasNdrConfig(cfg: OpenClawConfig): boolean {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const ndr = channels.ndr;
  return Boolean(ndr && typeof ndr === "object");
}

function ndrEnabled(cfg: OpenClawConfig): boolean {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const ndr = channels.ndr as Record<string, unknown> | undefined;
  return Boolean(ndr && ndr.enabled !== false);
}

describe("ndr onboarding persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists channels.ndr when ndr binary is missing", async () => {
    const child = await import("child_process");
    const execSyncMock = vi.mocked(child.execSync);
    execSyncMock.mockImplementation(() => {
      throw new Error("missing");
    });

    const { prompter } = createPrompter();
    const result = await ndrOnboardingAdapter.configure({
      cfg: {},
      prompter,
    });

    expect(hasNdrConfig(result.cfg)).toBe(true);
    expect(ndrEnabled(result.cfg)).toBe(true);
    expect(vi.mocked(startNdrBus)).not.toHaveBeenCalled();
  });

  it("persists channels.ndr when pairing times out", async () => {
    const child = await import("child_process");
    const execSyncMock = vi.mocked(child.execSync);
    execSyncMock.mockImplementation((command: string | Buffer | URL) => {
      const cmd = String(command);
      if (cmd.includes("ndr --version")) return Buffer.from("ndr 0.0.0");
      if (cmd.includes("hashtree-cli --version")) return Buffer.from("hashtree-cli 0.0.0");
      return Buffer.from("");
    });

    const close = vi.fn();
    vi.mocked(startNdrBus).mockResolvedValue({
      listChats: async () => [],
      createInvite: async () => ({ inviteUrl: "https://chat.iris.to/#invite=abc", inviteId: "abc" }),
      sendMessage: async () => {},
      close,
    } as unknown as Awaited<ReturnType<typeof startNdrBus>>);

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockImplementationOnce(() => 0)
      .mockImplementation(() => 121_000);

    const { prompter } = createPrompter();
    const result = await ndrOnboardingAdapter.configure({
      cfg: {},
      prompter,
    });

    nowSpy.mockRestore();

    expect(hasNdrConfig(result.cfg)).toBe(true);
    expect(ndrEnabled(result.cfg)).toBe(true);
    expect(close).toHaveBeenCalled();
  });
});
