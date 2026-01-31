import { describe, it, expect } from "vitest";
import { parseNdrEvent } from "./ndr-bus.js";

describe("parseNdrEvent", () => {
  it("parses group_message events", () => {
    const line = JSON.stringify({
      event: "group_message",
      group_id: "11111111-1111-1111-1111-111111111111",
      message_id: "msg-1",
      sender_pubkey: "a".repeat(64),
      content: "hello group",
      timestamp: 123,
    });

    const parsed = parseNdrEvent(line);
    expect(parsed).toEqual({
      type: "group_message",
      groupId: "11111111-1111-1111-1111-111111111111",
      messageId: "msg-1",
      senderPubkey: "a".repeat(64),
      content: "hello group",
      timestamp: 123,
    });
  });

  it("parses group_metadata events", () => {
    const line = JSON.stringify({
      event: "group_metadata",
      group_id: "22222222-2222-2222-2222-222222222222",
      action: "updated",
      sender_pubkey: "b".repeat(64),
    });

    const parsed = parseNdrEvent(line);
    expect(parsed).toEqual({
      type: "group_metadata",
      groupId: "22222222-2222-2222-2222-222222222222",
      action: "updated",
      senderPubkey: "b".repeat(64),
    });
  });
});
