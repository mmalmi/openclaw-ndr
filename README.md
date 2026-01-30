# @openclaw/ndr

OpenClaw channel plugin for [nostr-double-ratchet](https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/nostr-double-ratchet) - forward-secure end-to-end encrypted messaging over Nostr.

Compatible with [chat.iris.to](https://chat.iris.to).

## Features

- **Forward secrecy** - Past messages remain secure even if keys are compromised
- **Double ratchet encryption** - Based on Signal's proven protocol
- **Nostr transport** - Messages sent via Nostr relays
- **Interactive onboarding** - `openclaw onboard` walks you through setup

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

## How it works

1. **Listening** - Runs `ndr listen` to receive incoming messages
2. **Receiving** - Decrypts messages using the double ratchet session
3. **Sending** - Uses `ndr send` to encrypt and publish messages
4. **Session management** - ndr handles key rotation automatically

## Security

- **Forward secrecy** - Each message uses a unique encryption key
- **Session isolation** - Each chat has its own ratchet state
- **No key exposure** - Private keys are managed by the ndr CLI

## Troubleshooting

### "ndr: command not found"

Install: `cargo install ndr`

### "Failed to send message"

Check that:
1. You have an active chat session with the recipient
2. The relay is reachable
3. ndr CLI is working: `ndr chat list`
