#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IRIS_CHAT_REPO="${IRIS_CHAT_REPO:-$HOME/src/iris-chat}"
NDR_TS_REPO="${NDR_TS_REPO:-$HOME/src/nostr-double-ratchet/ts}"
NDR_REPO="${NDR_REPO:-$(cd "$NDR_TS_REPO/.." && pwd)}"
REPEAT_EACH="${REPEAT_EACH:-3}"
KEEP_TMP="${KEEP_TMP:-0}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 2
  fi
}

require_cmd pnpm
require_cmd rsync
require_cmd mktemp
require_cmd cargo

# Ensure Playwright workers can spawn cargo even in sanitized PATH environments.
export PATH="$HOME/.cargo/bin:$PATH"

if [[ ! -f "$IRIS_CHAT_REPO/package.json" ]]; then
  echo "iris-chat repo not found at: $IRIS_CHAT_REPO" >&2
  exit 2
fi

if [[ ! -f "$IRIS_CHAT_REPO/e2e/ndr-interop.spec.ts" ]]; then
  echo "Missing e2e/ndr-interop.spec.ts in: $IRIS_CHAT_REPO" >&2
  exit 2
fi

if [[ ! -f "$NDR_TS_REPO/package.json" ]]; then
  echo "nostr-double-ratchet TS repo not found at: $NDR_TS_REPO" >&2
  exit 2
fi

if [[ ! -d "$NDR_REPO/rust" ]]; then
  echo "nostr-double-ratchet rust repo not found at: $NDR_REPO (expected rust/)" >&2
  exit 2
fi

echo "[interop] building local nostr-double-ratchet TS package..."
pnpm --dir "$NDR_TS_REPO" -s build

work="$(mktemp -d "/tmp/iris-chat-ndr-interop.XXXXXX")"
cleanup() {
  if [[ "$KEEP_TMP" == "1" ]]; then
    echo "[interop] keeping temp workspace: $work"
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

echo "[interop] staging iris-chat into: $work"
rsync -a \
  --exclude node_modules \
  --exclude test-results \
  --exclude playwright-report \
  --exclude .svelte-kit \
  --exclude dist \
  "$IRIS_CHAT_REPO/" \
  "$work/"

echo "[interop] installing iris-chat dependencies..."
pnpm --dir "$work" install

echo "[interop] linking local nostr-double-ratchet from: $NDR_TS_REPO"
pnpm --dir "$work" add "nostr-double-ratchet@link:$NDR_TS_REPO"

resolved_info="$(
  pnpm --dir "$work" exec node -e "
    const fs = require('fs')
    const path = require('path')
    const entry = require.resolve('nostr-double-ratchet')
    let dir = path.dirname(entry)
    while (dir !== path.dirname(dir)) {
      const pkg = path.join(dir, 'package.json')
      if (fs.existsSync(pkg)) {
        const json = JSON.parse(fs.readFileSync(pkg, 'utf8'))
        console.log(json.version)
        console.log(pkg)
        process.exit(0)
      }
      dir = path.dirname(dir)
    }
    process.exit(1)
  "
)"
resolved_version="$(printf '%s\n' "$resolved_info" | sed -n '1p')"
resolved_pkg="$(printf '%s\n' "$resolved_info" | sed -n '2p')"

echo "[interop] resolved nostr-double-ratchet version: $resolved_version"
echo "[interop] resolved package file: $resolved_pkg"

ndr_bridge="/tmp/nostr-double-ratchet"
if [[ -e "$ndr_bridge" && ! -L "$ndr_bridge" ]]; then
  echo "Cannot create NDR bridge path because it exists and is not a symlink: $ndr_bridge" >&2
  exit 2
fi
ln -sfn "$NDR_REPO" "$ndr_bridge"
echo "[interop] bridged NDR rust repo: $ndr_bridge -> $NDR_REPO"

echo "[interop] running Playwright interop (repeat-each=$REPEAT_EACH)..."
CI=1 pnpm --dir "$work" exec playwright test e2e/ndr-interop.spec.ts --repeat-each="$REPEAT_EACH"

echo "[interop] PASS: iris-chat interop succeeded with local nostr-double-ratchet"
