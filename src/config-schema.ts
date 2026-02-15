import { z } from "zod";

/**
 * NDR channel configuration schema
 */
export const NdrConfigSchema = z.object({
  /** Owner's pubkey (npub or hex). Only messages from this pubkey are handled as commands. */
  ownerPubkey: z.string().optional(),

  /** Nostr relays to connect to */
  relays: z.array(z.string()).optional(),

  /**
   * Whether outgoing bot messages should use Nostr reply references (inner rumor ["e", ...] tag).
   * - off: never reply unless explicitly requested via reply directives/tags.
   * - first: only the first outbound message per turn replies to the triggering inbound message.
   * - all: every outbound message per turn replies to the triggering inbound message.
   */
  replyToMode: z.enum(["off", "first", "all"]).optional(),

  /** Whether the channel is enabled */
  enabled: z.boolean().optional(),

  /** Display name for the account */
  name: z.string().optional(),

  /** Path to ndr CLI binary (defaults to 'ndr' in PATH) */
  ndrPath: z.string().optional(),

  /** Custom data directory for ndr */
  dataDir: z.string().optional(),

  /** Group policy: open | allowlist | disabled */
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),

  /** Allowlist of sender pubkeys for group messages (npub or hex, '*' for any) */
  groupAllowFrom: z.array(z.string()).optional(),

  /** Allowlist of group IDs (UUIDs). When set, only listed groups are handled. */
  groups: z.array(z.string()).optional(),
});

export type NdrConfig = z.infer<typeof NdrConfigSchema>;

/** Default relays if none configured */
export const DEFAULT_RELAYS = [
  "wss://temp.iris.to",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://offchain.pub",
];
