# @openclaw/ndr

OpenClaw channel plugin for [nostr-double-ratchet](https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/nostr-double-ratchet) - forward-secure end-to-end encrypted messaging over Nostr.

Compatible with [chat.iris.to](https://chat.iris.to).

## Features

- **Forward secrecy** - Past messages remain secure even if keys are compromised
- **Double ratchet encryption** - Based on Signal's proven protocol
- **Nostr transport** - Messages sent via Nostr relays
- **Interactive onboarding** - `openclaw onboard` walks you through setup
- **Group chats** - NDR group fan-out with shared-channel invites

## Prerequisites

Install Rust and the required CLIs:

```bash
curl -sSf https://sh.rustup.rs | sh && cargo install ndr hashtree-cli
```

- **ndr** - Required for double ratchet encryption
- **hashtree-cli** - Optional, for encrypted media uploads via [hashtree](https://github.com/mmalmi/hashtree)

## Installation

> **Note:** OpenClaw's plugin system is under active development. These instructions may change.

From GitHub:

```bash
openclaw plugins install https://github.com/mmalmi/openclaw-ndr
```

From a local clone:

```bash
git clone https://github.com/mmalmi/openclaw-ndr
openclaw plugins install -l ./openclaw-ndr
```

## Setup

Run the interactive onboarding:

```bash
openclaw onboard
```

Select the NDR channel when prompted. The onboarding will:

1. Check if `ndr` CLI is installed
2. Ask you to paste a chat invite URL from [chat.iris.to](https://chat.iris.to)
3. Accept the invite and send a hello message
4. Configure your owner pubkey (so only you can control the agent)

### Getting a chat invite URL

1. Go to [chat.iris.to](https://chat.iris.to)
2. Click the **+** (New Chat) button
3. Click **Copy your chat link**
4. Paste it into the onboarding prompt

### Start the gateway

```bash
openclaw gateway run
```

## Configuration

The onboarding writes config to `~/.openclaw/openclaw.json`. You can also edit it manually:

```json5
{
  channels: {
    ndr: {
      // Owner's pubkey - only messages from this npub are handled as commands
      ownerPubkey: "npub1...",

      // Optional: Nostr relays (defaults shown below)
      relays: [
        "wss://temp.iris.to",
        "wss://relay.snort.social",
        "wss://relay.primal.net",
        "wss://relay.damus.io",
        "wss://offchain.pub"
      ],

      // Optional: Path to ndr CLI (default: "ndr" in PATH)
      ndrPath: "/path/to/ndr",

      // Optional: Custom data directory for ndr (default: ~/.openclaw/ndr-data)
      dataDir: "~/.openclaw/ndr-data",

      // Optional: Group policy ("allowlist" | "open" | "disabled")
      groupPolicy: "allowlist",

      // Optional: Allowed senders in groups (npub/hex, "*" allows anyone)
      groupAllowFrom: ["npub1...", "abcdef..."],

      // Optional: Allowed group IDs (UUIDs). Can be an array or a map.
      groups: ["11111111-1111-1111-1111-111111111111"]
    }
  }
}
```

**Authorization:**
- Only messages from `ownerPubkey` are handled as agent commands
- Messages from other pubkeys are logged but ignored
- If `ownerPubkey` is not set, all messages are handled

## Usage

### Check channel status

```bash
openclaw channels status --channel ndr
```

### List active chats

```bash
ndr chat list
```

### Groups (NDR)

NDR groups are managed by the `ndr` CLI. This plugin listens for `group_message`
events and can reply in groups when allowed by `groupPolicy`.

```bash
# Create a group (members are hex pubkeys)
ndr group create --name "My Group" --members <hex_pubkey,hex_pubkey>

# List groups (get group IDs)
ndr group list

# Send a group message
ndr group send <group_id> "hello"
```

## How it works

1. **Listening** - Runs `ndr listen` to receive incoming messages
2. **Receiving** - Decrypts messages using the double ratchet session
3. **Sending** - Uses `ndr send` to encrypt and publish messages
4. **Session management** - ndr handles key rotation automatically
5. **Groups** - `ndr group` fan-out with shared-channel invites

## Security

- **Forward secrecy** - Each message uses a unique encryption key
- **Session isolation** - Each chat has its own ratchet state
- **No key exposure** - Private keys are managed by the ndr CLI

## Troubleshooting

### "ndr: command not found" / "hashtree-cli: command not found"

Install both (requires Rust):

```bash
curl -sSf https://sh.rustup.rs | sh && cargo install ndr hashtree-cli
```

### Media attachments not working

Make sure `hashtree-cli` is installed: `hashtree-cli --version`

### "Failed to send message"

Check that:
1. You have an active chat session with the recipient
2. The relay is reachable
3. ndr CLI is working: `ndr chat list`

### Group messages not showing up

Check that:
1. `groupPolicy` allows the sender (`open` or `allowlist` with `groupAllowFrom`)
2. The group ID is included in `groups` if you configured a group allowlist
3. Your NDR client is in the group and has accepted it
