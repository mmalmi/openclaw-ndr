import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { startNdrBus } from "/plugin/dist/src/ndr-bus.js";

const sharedDir = "/shared";
const invitePath = `${sharedDir}/invite.txt`;
const receivedPath = `${sharedDir}/alice_received.json`;
const errorPath = `${sharedDir}/alice_error.txt`;

const timeoutMs = Number(process.env.TIMEOUT_MS || "180000");
const relays = String(process.env.RELAYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!fs.existsSync(sharedDir)) {
  fs.mkdirSync(sharedDir, { recursive: true });
}

process.env.NDR_REAL = "/opt/cargo/bin/ndr";
process.env.NDR_WRAPPER_LOG = "/shared/alice_invocations.jsonl";

function writeText(path, text) {
  fs.writeFileSync(path, text, "utf8");
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const deadline = Date.now() + timeoutMs;

let resolveReceived;
let rejectReceived;
const receivedPromise = new Promise((resolve, reject) => {
  resolveReceived = resolve;
  rejectReceived = reject;
});

const bus = await startNdrBus({
  accountId: "alice",
  relays,
  ndrPath: "/e2e/ndr-wrapper.mjs",
  dataDir: "/tmp/ndr-alice",
  onMessage: async (chatId, messageId, senderPubkey, text, reply, _media, messageIds, replyToId) => {
    try {
      writeJson(receivedPath, {
        ok: true,
        chatId,
        messageId,
        messageIds,
        replyToId,
        senderPubkey,
        text,
        at: new Date().toISOString(),
      });

      if (!messageId) {
        throw new Error("missing messageId (cannot validate reply threading)");
      }

      // Send a reply that references the incoming message id; Bob will validate reply_to_id.
      await reply("ack: " + text, { replyToId: messageId });
      resolveReceived();
    } catch (err) {
      writeText(errorPath, `onMessage: ${String(err?.message || err)}\n`);
      rejectReceived(err);
    }
  },
  onError: (err, context) => {
    // keep listening, but record the most recent error
    writeText(errorPath, `${context}: ${String(err?.message || err)}\n`);
  },
});

try {
  const invite = await bus.createInvite();
  writeText(invitePath, invite.inviteUrl + "\n");

  const remaining = Math.max(0, deadline - Date.now());
  await Promise.race([receivedPromise, sleep(remaining)]);

  if (!fs.existsSync(receivedPath)) {
    throw new Error(`timeout waiting for message (${timeoutMs}ms)`);
  }
  process.exitCode = 0;
} catch (err) {
  writeText(errorPath, `fatal: ${String(err?.message || err)}\n`);
  process.exitCode = 1;
} finally {
  try {
    bus.close();
  } catch {
    // ignore
  }
  // allow ndr child process to exit cleanly
  await sleep(250);
}
