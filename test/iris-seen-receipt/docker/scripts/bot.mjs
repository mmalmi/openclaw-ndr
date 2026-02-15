import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";

const sharedDir = "/shared";
const invitePath = `${sharedDir}/invite.txt`;
const readyPath = `${sharedDir}/gateway_ready.txt`;
const sessionReadyPath = `${sharedDir}/session_ready.txt`;
const errorPath = `${sharedDir}/bot_error.txt`;
const gatewayLogPath = `${sharedDir}/gateway.log`;

const stateDir = "/root/.openclaw";
const configPath = `${stateDir}/openclaw.json`;
const ndrDataDir = `${stateDir}/ndr-data`;
const relayUrl = String(process.env.RELAY_URL || "wss://temp.iris.to").trim();
const gatewayToken = String(process.env.OPENCLAW_GATEWAY_TOKEN || "testtoken").trim();

const openclawEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_GATEWAY_TOKEN: gatewayToken,
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(path, text) {
  fs.writeFileSync(path, text, "utf8");
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function runJsonCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }

      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          resolve(JSON.parse(lines[i]));
          return;
        } catch {
          // keep scanning until we find json
        }
      }

      resolve({ status: "ok", data: stdout.trim() });
    });
  });
}

function mergeRuntimeConfig() {
  const cfg = fs.existsSync(configPath) ? readJson(configPath) : {};
  const next = {
    ...cfg,
    gateway: {
      ...(cfg.gateway && typeof cfg.gateway === "object" ? cfg.gateway : {}),
      mode: "local",
    },
    plugins: {
      ...(cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {}),
      entries: {
        ...((cfg.plugins && typeof cfg.plugins === "object" && cfg.plugins.entries && typeof cfg.plugins.entries === "object")
          ? cfg.plugins.entries
          : {}),
        "openclaw-ndr": {
          ...((cfg.plugins && typeof cfg.plugins === "object" && cfg.plugins.entries && typeof cfg.plugins.entries === "object" &&
              cfg.plugins.entries["openclaw-ndr"] && typeof cfg.plugins.entries["openclaw-ndr"] === "object")
            ? cfg.plugins.entries["openclaw-ndr"]
            : {}),
          enabled: true,
        },
      },
    },
    channels: {
      ...(cfg.channels && typeof cfg.channels === "object" ? cfg.channels : {}),
      ndr: {
        ...((cfg.channels && typeof cfg.channels === "object" && cfg.channels.ndr && typeof cfg.channels.ndr === "object")
          ? cfg.channels.ndr
          : {}),
        enabled: true,
        relays: [relayUrl],
        ndrPath: "ndr",
        dataDir: ndrDataDir,
      },
    },
  };

  writeJson(configPath, next);
}

async function ensureNdrIdentity() {
  const baseArgs = ["--json", "--data-dir", ndrDataDir];
  const whoami = await runJsonCommand("ndr", [...baseArgs, "whoami"], process.env);
  const loggedIn = whoami?.status === "ok" && whoami?.data && typeof whoami.data === "object"
    ? whoami.data.logged_in
    : undefined;

  if (loggedIn === false) {
    const secret = crypto.randomBytes(32).toString("hex");
    const login = await runJsonCommand("ndr", [...baseArgs, "login", secret], process.env);
    if (login?.status !== "ok") {
      throw new Error(`ndr login failed: ${JSON.stringify(login)}`);
    }
  }
}

async function createInvite() {
  const invite = await runJsonCommand(
    "ndr",
    ["--json", "--data-dir", ndrDataDir, "invite", "create"],
    process.env,
  );
  if (invite?.status !== "ok" || !invite?.data?.url) {
    throw new Error(`ndr invite create failed: ${JSON.stringify(invite)}`);
  }

  writeText(invitePath, `${invite.data.url}\n`);
}

function startGateway() {
  const gateway = spawn(
    "node",
    ["/app/dist/entry.js", "gateway", "run", "--verbose"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: openclawEnv,
    },
  );

  const gatewayLog = fs.createWriteStream(gatewayLogPath, { flags: "a" });
  let ready = false;

  const onOutput = (chunk) => {
    const text = chunk.toString();
    gatewayLog.write(text);
    process.stdout.write(text);
    if (!ready && text.includes("NDR provider started")) {
      ready = true;
      writeText(readyPath, "ready\n");
    }
    if (text.includes("Locked owner pubkey from session_created")) {
      writeText(sessionReadyPath, "ready\n");
    }
  };

  gateway.stdout.on("data", onOutput);
  gateway.stderr.on("data", onOutput);
  gateway.on("close", (code) => {
    if (!ready) {
      writeText(errorPath, `gateway exited before ready (code=${String(code)})\n`);
    }
    gatewayLog.end();
    process.exit(code ?? 1);
  });

  process.on("SIGINT", () => gateway.kill("SIGINT"));
  process.on("SIGTERM", () => gateway.kill("SIGTERM"));
}

async function main() {
  ensureDir(sharedDir);
  ensureDir(stateDir);
  ensureDir(ndrDataDir);

  if (!fs.existsSync(configPath)) {
    writeJson(configPath, {});
  }

  mergeRuntimeConfig();
  await ensureNdrIdentity();
  await createInvite();
  startGateway();
}

main().catch((err) => {
  writeText(errorPath, `${String(err?.stack || err)}\n`);
  process.exit(1);
});
