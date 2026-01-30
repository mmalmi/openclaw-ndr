# moltbot-plugin-ndr

Moltbot channel plugin for [nostr-double-ratchet](https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/nostr-double-ratchet) - forward-secure end-to-end encrypted messaging over Nostr.

Compatible with [chat.iris.to](https://chat.iris.to).

## Features

- **Forward secrecy** - Past messages remain secure even if keys are compromised
- **Double ratchet encryption** - Based on Signal's proven protocol
- **Nostr transport** - Messages sent via Nostr relays
- **CLI integration** - Uses the `ndr` CLI for encryption/decryption

## Prerequisites

Install Rust and the required CLIs:

```bash
curl -sSf https://sh.rustup.rs | sh && cargo install ndr hashtree-cli
```

- **ndr** - Required for double ratchet encryption
- **hashtree-cli** - Optional, for encrypted media uploads via [hashtree](https://github.com/mmalmi/hashtree)


## Installation

> **Note:** Moltbot's plugin system is under active development. These instructions may change.

From npm (once published):

```bash
moltbot plugins install moltbot-plugin-ndr
```

From a local clone:

```bash
git clone https://github.com/mmalmi/moltbot-ndr
moltbot plugins install -l ./moltbot-ndr
```

This copies (or symlinks with `-l`) the plugin into `~/.clawdbot/extensions/ndr/`, installs its dependencies, and enables it in your moltbot config.

## Configuration

Add to your `~/.moltbot/moltbot.json`:

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

      // Optional: Custom data directory for ndr
      dataDir: "~/.ndr-moltbot",

      // Optional: Private key (hex or nsec). If not provided, ndr auto-generates one.
      // privateKey: "nsec1...",
    }
  }
}
```

**Authorization:**
- Only messages from `ownerPubkey` are handled as agent commands
- Messages from other pubkeys are logged but ignored (for now)
- If `ownerPubkey` is not set, all messages are handled (legacy behavior)

## Setup

The ndr CLI auto-generates an identity on first use.

### 1. Check your identity

```bash
ndr whoami
```

This shows your npub. Share this with people who want to message you.

### 2. Create an invite (to let others connect to you)

```bash
ndr invite create --label "moltbot"
```

Share the invite URL with the person you want to chat with. They accept it with `ndr chat join <url>`.

### 3. Join someone else's invite

```bash
ndr chat join <invite_url>
```

This creates a chat session. You can now send/receive messages.

### 4. Configure your owner pubkey

Add your npub to the config so only you can control the agent:

```json5
{
  channels: {
    ndr: {
      ownerPubkey: "npub1..."  // your npub from step 1
    }
  }
}
```

### 5. Start the gateway

```bash
moltbot gateway run
```

## Usage

### Check channel status

```bash
moltbot channels status --channel ndr
```

### List active chats

```bash
ndr chat list
```

### Send a message

```bash
moltbot message send --channel ndr --to <chat_id> --message "Hello!"
```

## How it works

1. **Initialization** - ndr auto-generates an identity if not logged in
2. **Listening** - Runs `ndr listen` to receive incoming messages
3. **Receiving** - Decrypts messages using the double ratchet session
4. **Sending** - Uses `ndr send` to encrypt and publish messages
5. **Session management** - ndr handles key rotation automatically

## Security

- **No key exposure** - Private keys are only passed to the ndr CLI
- **Forward secrecy** - Each message uses a unique encryption key
- **Session isolation** - Each chat has its own ratchet state

## Comparison with Nostr NIP-04

| Feature | NDR (Double Ratchet) | Nostr NIP-04 |
|---------|---------------------|--------------|
| Forward secrecy | Yes | No |
| Key rotation | Automatic | None |
| Session state | Required | Stateless |
| Complexity | Higher | Lower |

Use NDR for high-security conversations where forward secrecy matters.
Use NIP-04 for simpler use cases where stateless encryption is acceptable.

## Troubleshooting

### "ndr: command not found"

Install ndr CLI: `cargo install ndr`

### "Failed to send message"

Check that:
1. You have an active chat session with the recipient
2. The relay is reachable
3. ndr CLI is working: `ndr chat list`
