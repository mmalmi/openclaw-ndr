import { describe, it, expect } from "vitest";
import { parseNdrEvent } from "./ndr-bus.js";

describe("parseNdrEvent", () => {
  it("prefers inner message id while preserving fallback ids", () => {
    const line = JSON.stringify({
      event: "message",
      chat_id: "chat-1",
      from_pubkey: "c".repeat(64),
      content: "hello",
      inner_message_id: "inner-1",
      message_id: "outer-1",
      event_id: "outer-1",
      id: "legacy-1",
      timestamp: 456,
    });

    const parsed = parseNdrEvent(line);
    expect(parsed).toEqual({
      type: "message",
      chatId: "chat-1",
      messageId: "inner-1",
      messageIds: ["inner-1", "outer-1", "legacy-1"],
      senderPubkey: "c".repeat(64),
      content: "hello",
      timestamp: 456,
    });
  });

  it("parses replyToId on message events", () => {
    const line = JSON.stringify({
      event: "message",
      chat_id: "chat-1",
      from_pubkey: "c".repeat(64),
      content: "hello",
      message_id: "inner-1",
      reply_to_id: "parent-1",
    });

    const parsed = parseNdrEvent(line);
    expect(parsed).toEqual({
      type: "message",
      chatId: "chat-1",
      messageId: "inner-1",
      messageIds: ["inner-1"],
      replyToId: "parent-1",
      senderPubkey: "c".repeat(64),
      content: "hello",
      timestamp: undefined,
    });
  });

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

  it("parses replyToId on group_message events", () => {
    const line = JSON.stringify({
      event: "group_message",
      group_id: "11111111-1111-1111-1111-111111111111",
      message_id: "msg-1",
      sender_pubkey: "a".repeat(64),
      content: "hello group",
      reply_to_id: "parent-1",
      timestamp: 123,
    });

    const parsed = parseNdrEvent(line);
    expect(parsed).toEqual({
      type: "group_message",
      groupId: "11111111-1111-1111-1111-111111111111",
      messageId: "msg-1",
      replyToId: "parent-1",
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
