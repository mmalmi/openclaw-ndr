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
  ndrPath: "ndr",
  dataDir: "/tmp/ndr-alice",
  onMessage: async (chatId, messageId, senderPubkey, text, reply) => {
    writeJson(receivedPath, {
      ok: true,
      chatId,
      messageId,
      senderPubkey,
      text,
      at: new Date().toISOString(),
    });
    try {
      await reply("ack: " + text);
    } catch {
      // best-effort
    }
    resolveReceived();
  },
  onError: (err, context) => {
    // keep listening, but record the most recent error
    writeText(errorPath, `${context}: ${String(err?.message || err)}\n`);
  },
});

try {
  const invite = await bus.createInvite();
  writeText(invitePath, invite.inviteUrl + "\n");

  while (Date.now() < deadline) {
    // race: message handler will resolve
    const remaining = Math.max(0, deadline - Date.now());
    await Promise.race([receivedPromise, sleep(Math.min(500, remaining))]);
    if (fs.existsSync(receivedPath)) {
      process.exitCode = 0;
      break;
    }
  }

  if (!fs.existsSync(receivedPath)) {
    throw new Error(`timeout waiting for message (${timeoutMs}ms)`);
  }
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

