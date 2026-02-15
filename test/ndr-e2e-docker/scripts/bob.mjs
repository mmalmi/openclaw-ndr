import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { startNdrBus } from "/plugin/dist/src/ndr-bus.js";

const sharedDir = "/shared";
const invitePath = `${sharedDir}/invite.txt`;
const sentPath = `${sharedDir}/bob_sent.json`;
const errorPath = `${sharedDir}/bob_error.txt`;

const timeoutMs = Number(process.env.TIMEOUT_MS || "180000");
const relays = String(process.env.RELAYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!fs.existsSync(sharedDir)) {
  fs.mkdirSync(sharedDir, { recursive: true });
}

process.env.NDR_REAL = "/opt/cargo/bin/ndr";
process.env.NDR_WRAPPER_LOG = "/shared/bob_invocations.jsonl";

function writeText(path, text) {
  fs.writeFileSync(path, text, "utf8");
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const deadline = Date.now() + timeoutMs;

const waitForInvite = async () => {
  while (Date.now() < deadline) {
    if (fs.existsSync(invitePath)) {
      const inviteUrl = fs.readFileSync(invitePath, "utf8").trim();
      if (inviteUrl) return inviteUrl;
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for invite (${timeoutMs}ms)`);
};

const waitForAliceReceived = async () => {
  while (Date.now() < deadline) {
    if (fs.existsSync("/shared/alice_received.json")) {
      const raw = fs.readFileSync("/shared/alice_received.json", "utf8").trim();
      if (!raw) {
        await sleep(250);
        continue;
      }
      try {
        return JSON.parse(raw);
      } catch {
        // ignore and retry
      }
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for alice_received.json (${timeoutMs}ms)`);
};

let resolveAck;
let rejectAck;
const ackPromise = new Promise((resolve, reject) => {
  resolveAck = resolve;
  rejectAck = reject;
});
let ackPayload = null;

const bus = await startNdrBus({
  accountId: "bob",
  relays,
  ndrPath: "/e2e/ndr-wrapper.mjs",
  dataDir: "/tmp/ndr-bob",
  onMessage: async (chatId, messageId, senderPubkey, text, _reply, _media, _messageIds, replyToId) => {
    ackPayload = {
      ok: true,
      chatId,
      messageId,
      senderPubkey,
      text,
      replyToId,
      at: new Date().toISOString(),
    };
    resolveAck();
  },
  onError: (err, context) => {
    writeText(errorPath, `${context}: ${String(err?.message || err)}\n`);
  },
});

try {
  const inviteUrl = await waitForInvite();

  const { chatId, theirPubkey } = await bus.joinInvite(inviteUrl);

  // Send a message; retry briefly in case the session is still settling.
  const payload = `ping ${Date.now()}`;
  let lastErr = null;
  for (let i = 0; i < 10; i += 1) {
    try {
      await bus.sendMessage(chatId, payload);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  if (lastErr) {
    throw lastErr;
  }

  writeJson(sentPath, {
    ok: true,
    chatId,
    theirPubkey,
    text: payload,
    at: new Date().toISOString(),
  });

  const aliceReceived = await waitForAliceReceived();
  const expectedParentId = String(aliceReceived?.messageId || "").trim();
  if (!expectedParentId) {
    throw new Error("alice_received.json missing messageId");
  }

  // Wait for Alice ack (which should be a reply to our ping).
  const remaining = Math.max(0, deadline - Date.now());
  await Promise.race([ackPromise, sleep(remaining)]);

  if (!ackPayload) {
    throw new Error(`timeout waiting for ack (${timeoutMs}ms)`);
  }

  writeJson("/shared/bob_received.json", {
    ...ackPayload,
    expectedReplyToId: expectedParentId,
  });

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
  await sleep(250);
}
