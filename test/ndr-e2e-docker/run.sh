#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$ROOT_DIR/test/ndr-e2e-docker"

NDR_REPO="${NDR_REPO:-$HOME/src/nostr-double-ratchet}"
OPENCLAW_REPO="${OPENCLAW_REPO:-$HOME/src/openclaw}"

if ! docker image inspect openclaw-plugins-e2e:latest >/dev/null 2>&1; then
  if [[ ! -f "$OPENCLAW_REPO/scripts/e2e/Dockerfile" ]]; then
    echo "Missing base image openclaw-plugins-e2e:latest and OpenClaw repo not found at: $OPENCLAW_REPO" >&2
    exit 2
  fi
  echo "[e2e] building base image openclaw-plugins-e2e:latest (from $OPENCLAW_REPO)..."
  docker build -t openclaw-plugins-e2e -f "$OPENCLAW_REPO/scripts/e2e/Dockerfile" "$OPENCLAW_REPO"
fi

if [[ ! -d "$NDR_REPO/rust" ]]; then
  echo "nostr-double-ratchet not found at: $NDR_REPO (expected rust/)" >&2
  exit 2
fi

cd "$ROOT_DIR"

echo "[e2e] building openclaw-ndr dist..."
pnpm -s build

work="$(mktemp -d "/tmp/openclaw-ndr-e2e.XXXXXX")"
if [[ "${KEEP_WORK:-}" != "1" ]]; then
  trap 'rm -rf "$work"' EXIT
else
  echo "[e2e] keeping work dir (KEEP_WORK=1): $work"
fi

echo "[e2e] staging docker context: $work"
mkdir -p "$work/openclaw-ndr" "$work/nostr-double-ratchet" "$work/shared"

cp -R "$E2E_DIR/Dockerfile" "$work/Dockerfile"
cp -R "$E2E_DIR/compose.yaml" "$work/compose.yaml"
cp -R "$E2E_DIR/scripts" "$work/scripts"
cp -R "$ROOT_DIR/dist" "$work/openclaw-ndr/dist"

# The rust workspace can contain huge build artifacts under target/.
# Sync only sources for a faster docker context.
rsync -a \
  --exclude ".git" \
  --exclude "target" \
  "$NDR_REPO/rust/" \
  "$work/nostr-double-ratchet/rust/"

cd "$work"

rm -f shared/* || true

echo "[e2e] docker compose up (alice+bob)..."
set +e
docker compose up --build --exit-code-from bob
compose_status=$?
set -e

echo "[e2e] results:"
ls -la shared || true
if [[ -f "shared/alice_received.json" ]]; then
  echo
  echo "[e2e] alice_received.json:"
  cat shared/alice_received.json
else
  echo "missing shared/alice_received.json" >&2
  [[ -f "shared/alice_error.txt" ]] && cat shared/alice_error.txt >&2
  exit 1
fi

if [[ -f "shared/bob_received.json" ]]; then
  echo
  echo "[e2e] bob_received.json:"
  cat shared/bob_received.json
else
  echo "missing shared/bob_received.json" >&2
  [[ -f "shared/bob_error.txt" ]] && cat shared/bob_error.txt >&2
  if [[ "${compose_status:-0}" -eq 0 ]]; then
    exit 1
  fi
  exit "${compose_status}"
fi

if [[ -f "shared/alice_invocations.jsonl" ]]; then
  echo
  echo "[e2e] asserting reply invocation (--reply)..."
  node - <<'NODE'
const fs = require("fs");

const received = JSON.parse(fs.readFileSync("shared/alice_received.json", "utf8"));
const expected = String(received.messageId || "").trim();
if (!expected) {
  console.error("missing expected messageId in alice_received.json");
  process.exit(1);
}

const lines = fs
  .readFileSync("shared/alice_invocations.jsonl", "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const hasReplySend = lines.some(
  (argv) =>
    Array.isArray(argv) &&
    argv.includes("send") &&
    argv.includes("--reply") &&
    argv.includes(expected),
);

if (!hasReplySend) {
  console.error(`missing ndr send --reply ${expected} in alice_invocations.jsonl`);
  process.exit(1);
}
NODE
else
  echo "missing shared/alice_invocations.jsonl (cannot assert --reply)" >&2
  if [[ "${compose_status:-0}" -eq 0 ]]; then
    exit 1
  fi
fi

exit "${compose_status:-0}"
