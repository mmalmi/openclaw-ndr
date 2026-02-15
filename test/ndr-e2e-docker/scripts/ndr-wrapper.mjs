#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";

const realNdr = process.env.NDR_REAL || "/opt/cargo/bin/ndr";
const logPath = process.env.NDR_WRAPPER_LOG;

// Append JSON argv for later assertions (one line per invocation).
if (logPath) {
  try {
    fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\n", "utf8");
  } catch {
    // Ignore logging failures; wrapper must not break NDR.
  }
}

const child = spawn(realNdr, process.argv.slice(2), { stdio: "inherit" });

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }

  // Ensure the underlying ndr process doesn't outlive this wrapper, otherwise
  // the parent's pipes never close and the test containers hang.
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    process.exit(0);
  }, 2500);
  timer.unref();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.on("exit", () => {
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(shuttingDown ? 0 : 1);
  }
  process.exit(code ?? 1);
});

child.on("error", () => {
  process.exit(1);
});
