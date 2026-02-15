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
      // Wait for gateway to report session_created owner lock.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Session ready file not created within ${timeoutMs}ms: ${sessionReadyFile}`);
}

test("openclaw-ndr sends seen receipt visible in iris-chat", async ({ page }) => {
  test.setTimeout(180_000);

  if (!inviteUrl) {
    throw new Error("INVITE_URL is required");
  }

  await page.addInitScript((url: string) => {
    window.localStorage.setItem("iris-chat-relays", JSON.stringify([url]));
  }, relayUrl);

  await page.goto("/");
  await page.getByRole("button", { name: "Go" }).click();
  await page.getByRole("button", { name: "New Chat" }).click();
  await page.getByPlaceholder("Paste invite link").fill(inviteUrl);

  const messageInput = page.getByPlaceholder("Type a message...");
  await expect(messageInput).toBeVisible({ timeout: 20_000 });
  await waitForSessionReadyFile();

  const irisMessage = `seen-receipt-check ${Date.now()}`;
  await messageInput.fill(irisMessage);
  await page.getByRole("button", { name: "Send" }).click();

  const messageBubble = page.locator(".max-w-\\[85\\%\\]").filter({ hasText: irisMessage }).last();
  await expect(messageBubble).toBeVisible({ timeout: 30_000 });

  // Seen status is rendered with the sky-colored double checkmark icon.
  const seenStatus = messageBubble.locator(".i-carbon-checkmark.text-sky-300");
  await expect(seenStatus).toHaveCount(2, { timeout: 120_000 });
});
