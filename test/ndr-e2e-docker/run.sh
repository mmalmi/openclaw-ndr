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
trap 'rm -rf "$work"' EXIT

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
docker compose up --build --exit-code-from alice

echo "[e2e] results:"
ls -la shared || true
if [[ -f "shared/alice_received.json" ]]; then
  cat shared/alice_received.json
else
  echo "missing shared/alice_received.json" >&2
  [[ -f "shared/alice_error.txt" ]] && cat shared/alice_error.txt >&2
  exit 1
fi
