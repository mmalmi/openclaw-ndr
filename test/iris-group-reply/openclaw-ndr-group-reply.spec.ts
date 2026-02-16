import { test, expect } from "@playwright/test";
import { access } from "node:fs/promises";

const relayUrl = process.env.RELAY_URL ?? "wss://temp.iris.to";
const inviteUrl = process.env.INVITE_URL;
const sessionReadyFile = process.env.SESSION_READY_FILE;

async function waitForSessionReadyFile(timeoutMs = 60_000): Promise<void> {
  if (!sessionReadyFile) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(sessionReadyFile);
      return;
    } catch {
      // Wait for gateway owner-lock signal.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Session ready file not created within ${timeoutMs}ms: ${sessionReadyFile}`);
}

async function sendMessage(page: import("@playwright/test").Page, text: string): Promise<void> {
  const input = page.getByPlaceholder("Type a message...");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(text);
  await input.press("Enter");
}

test("openclaw-ndr replies to group messages in iris-chat", async ({ page }) => {
  test.setTimeout(360_000);

  if (!inviteUrl) {
    throw new Error("INVITE_URL is required");
  }

  await page.addInitScript((url: string) => {
    window.localStorage.setItem("iris-chat-relays", JSON.stringify([url]));
  }, relayUrl);

  await page.goto("/");
  await page.getByRole("button", { name: "Go" }).click();
  await page.getByRole("button", { name: "New Chat" }).first().click();
  await page.getByPlaceholder("Paste invite link").fill(inviteUrl);

  const messageInput = page.getByPlaceholder("Type a message...");
  await expect(messageInput).toBeVisible({ timeout: 20_000 });
  await waitForSessionReadyFile(120_000);

  const dmIncoming = page.locator("div.group.flex.min-w-0:not(.justify-end) > div.max-w-\\[85\\%\\]");
  const baselineDmIncoming = await dmIncoming.count();
  await sendMessage(page, "/help");
  await expect
    .poll(async () => await dmIncoming.count(), {
      timeout: 60_000,
      message: "waiting for incoming direct-chat reply",
    })
    .toBeGreaterThan(baselineDmIncoming);

  await page.getByRole("button", { name: "New Chat" }).first().click();
  await page.getByRole("button", { name: "Create Group" }).click();

  const memberRows = page.locator("button.w-full.p-3");
  await expect(memberRows.first()).toBeVisible({ timeout: 30_000 });
  await memberRows.first().click();

  await page.getByRole("button", { name: /Next \(1 selected\)/ }).click();

  const groupName = `e2e-group-${Date.now()}`;
  await page.getByPlaceholder("Enter group name...").fill(groupName);
  await page.getByRole("button", { name: "Create Group" }).click();

  await expect(page.getByText(groupName).first()).toBeVisible({ timeout: 30_000 });

  // Give the bot time to auto-accept before first sender-key distribution.
  await page.waitForTimeout(5000);

  const incomingBubbles = page.locator("div.group.flex.min-w-0:not(.justify-end) > div.max-w-\\[85\\%\\]");
  const baselineIncoming = await incomingBubbles.count();

  const deadline = Date.now() + 180_000;
  let replyObserved = false;

  while (Date.now() < deadline) {
    await sendMessage(page, "/help");

    try {
      await expect
        .poll(async () => await incomingBubbles.count(), {
          timeout: 20_000,
          message: "waiting for incoming group reply",
        })
        .toBeGreaterThan(baselineIncoming);
      replyObserved = true;
      break;
    } catch {
      await page.waitForTimeout(2000);
    }
  }

  if (!replyObserved) {
    const allBubbles = await page.locator("div.max-w-\\[85\\%\\]").allInnerTexts();
    throw new Error(`No incoming group reply observed within timeout. Bubbles: ${JSON.stringify(allBubbles)}`);
  }

  await expect(incomingBubbles.first()).toBeVisible();
});
