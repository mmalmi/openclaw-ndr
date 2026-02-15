#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$ROOT_DIR/test/iris-seen-receipt"

IRIS_CHAT_REPO="${IRIS_CHAT_REPO:-$HOME/src/iris-chat}"
NDR_REPO="${NDR_REPO:-$HOME/src/nostr-double-ratchet}"
OPENCLAW_REPO="${OPENCLAW_REPO:-$HOME/src/openclaw}"
RELAY_URL="${RELAY_URL:-wss://temp.iris.to}"
KEEP_TMP="${KEEP_TMP:-0}"
SETUP_TIMEOUT_SEC="${SETUP_TIMEOUT_SEC:-180}"
PLAYWRIGHT_PORT="${PLAYWRIGHT_PORT:-45173}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 2
  fi
}

require_cmd docker
require_cmd pnpm
require_cmd rsync
require_cmd mktemp
require_cmd patch

if [[ ! -f "$IRIS_CHAT_REPO/package.json" ]]; then
  echo "iris-chat repo not found at: $IRIS_CHAT_REPO" >&2
  exit 2
fi

if [[ ! -d "$NDR_REPO/rust" ]]; then
  echo "nostr-double-ratchet not found at: $NDR_REPO (expected rust/)" >&2
  exit 2
fi

if ! docker image inspect openclaw-plugins-e2e:latest >/dev/null 2>&1; then
  if [[ ! -f "$OPENCLAW_REPO/scripts/e2e/Dockerfile" ]]; then
    echo "Missing base image openclaw-plugins-e2e:latest and OpenClaw repo not found at: $OPENCLAW_REPO" >&2
    exit 2
  fi
  echo "[seen-e2e] building base image openclaw-plugins-e2e:latest (from $OPENCLAW_REPO)..."
  docker build -t openclaw-plugins-e2e -f "$OPENCLAW_REPO/scripts/e2e/Dockerfile" "$OPENCLAW_REPO"
fi

cd "$ROOT_DIR"
echo "[seen-e2e] building openclaw-ndr dist..."
pnpm -s build

work="$(mktemp -d "/tmp/openclaw-ndr-seen-e2e.XXXXXX")"
image_tag="openclaw-ndr-seen-e2e:$(date +%s)"
container_id=""

cleanup() {
  local status=$?

  if [[ $status -ne 0 ]]; then
    if [[ -f "$work/shared/bot_error.txt" ]]; then
      echo "[seen-e2e] bot_error.txt:"
      cat "$work/shared/bot_error.txt" || true
    fi
    if [[ -f "$work/shared/gateway.log" ]]; then
      echo "[seen-e2e] gateway.log (tail):"
      tail -n 120 "$work/shared/gateway.log" || true
    fi
    if [[ -n "$container_id" ]]; then
      echo "[seen-e2e] docker logs (tail):"
      docker logs --tail 120 "$container_id" || true
    fi
  fi

  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi

  if [[ "$KEEP_TMP" == "1" ]]; then
    echo "[seen-e2e] keeping temp workspace: $work"
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

echo "[seen-e2e] staging docker context: $work/docker"
mkdir -p "$work/docker/openclaw-ndr" "$work/docker/nostr-double-ratchet" "$work/shared" "$work/iris"
cp -R "$E2E_DIR/docker/Dockerfile" "$work/docker/Dockerfile"
cp -R "$E2E_DIR/docker/scripts" "$work/docker/scripts"

rsync -a \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "test" \
  "$ROOT_DIR/" \
  "$work/docker/openclaw-ndr/"

rsync -a \
  --exclude ".git" \
  --exclude "target" \
  "$NDR_REPO/rust/" \
  "$work/docker/nostr-double-ratchet/rust/"

echo "[seen-e2e] forcing inner-rumor message ids in ndr listen output..."
ndr_listen_file="$work/docker/nostr-double-ratchet/rust/crates/ndr/src/commands/message/listen.rs"
if grep -Fq "or_else(|| event_id.map(str::to_string))" "$ndr_listen_file"; then
  echo "[seen-e2e] ndr listen already prefers inner rumor ids"
else
  patch -d "$work/docker/nostr-double-ratchet" -p1 \
    --forward \
    < "$E2E_DIR/docker/patches/ndr-inner-message-id.patch"
fi

echo "[seen-e2e] building bot image $image_tag..."
docker build -t "$image_tag" -f "$work/docker/Dockerfile" "$work/docker"

echo "[seen-e2e] starting bot container..."
container_id="$(
  docker run -d --rm \
    -e RELAY_URL="$RELAY_URL" \
    -e OPENCLAW_GATEWAY_TOKEN="testtoken" \
    -v "$work/shared:/shared" \
    "$image_tag"
)"
echo "[seen-e2e] container id: $container_id"

echo "[seen-e2e] waiting for invite + gateway readiness..."
deadline=$((SECONDS + SETUP_TIMEOUT_SEC))
while true; do
  if [[ -f "$work/shared/bot_error.txt" ]]; then
    echo "[seen-e2e] bot reported error before ready" >&2
    exit 1
  fi
  if [[ -f "$work/shared/invite.txt" && -f "$work/shared/gateway_ready.txt" ]]; then
    break
  fi
  if (( SECONDS >= deadline )); then
    echo "[seen-e2e] timeout waiting for bot readiness (${SETUP_TIMEOUT_SEC}s)" >&2
    exit 1
  fi
  sleep 1
done

invite_url="$(tr -d '\r\n' < "$work/shared/invite.txt")"
if [[ -z "$invite_url" ]]; then
  echo "[seen-e2e] invite URL is empty" >&2
  exit 1
fi
echo "[seen-e2e] invite ready"

echo "[seen-e2e] staging iris-chat into: $work/iris"
rsync -a \
  --exclude node_modules \
  --exclude test-results \
  --exclude playwright-report \
  --exclude .svelte-kit \
  --exclude dist \
  "$IRIS_CHAT_REPO/" \
  "$work/iris/"

cp "$E2E_DIR/openclaw-ndr-seen.spec.ts" "$work/iris/e2e/openclaw-ndr-seen.spec.ts"

cat > "$work/iris/playwright.seen.config.ts" <<EOF
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: "http://localhost:${PLAYWRIGHT_PORT}",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port ${PLAYWRIGHT_PORT} --strictPort",
    url: "http://localhost:${PLAYWRIGHT_PORT}",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
EOF

echo "[seen-e2e] installing iris-chat dependencies..."
pnpm --dir "$work/iris" install

echo "[seen-e2e] building iris-chat app..."
pnpm --dir "$work/iris" run build

echo "[seen-e2e] running Playwright receipt check..."
RELAY_URL="$RELAY_URL" INVITE_URL="$invite_url" SESSION_READY_FILE="$work/shared/session_ready.txt" \
  pnpm --dir "$work/iris" exec playwright test --config playwright.seen.config.ts e2e/openclaw-ndr-seen.spec.ts

echo "[seen-e2e] PASS: seen receipt is visible in iris-chat"
