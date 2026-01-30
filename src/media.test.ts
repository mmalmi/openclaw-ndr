import { describe, it, expect } from "vitest";
import { parseNhashUrl } from "./media.js";

describe("parseNhashUrl", () => {
  it("parses nhash URL with filename", () => {
    const result = parseNhashUrl("check this out nhash1abc123def/photo.jpg ok?");
    expect(result).not.toBeNull();
    expect(result!.cid).toBe("nhash1abc123def");
    expect(result!.filename).toBe("photo.jpg");
    expect(result!.full).toBe("nhash1abc123def/photo.jpg");
  });

  it("parses nhash URL without filename", () => {
    const result = parseNhashUrl("here nhash1abc123def is the hash");
    expect(result).not.toBeNull();
    expect(result!.cid).toBe("nhash1abc123def");
    expect(result!.filename).toBeNull();
  });

  it("returns null for content without nhash", () => {
    expect(parseNhashUrl("just a normal message")).toBeNull();
    expect(parseNhashUrl("")).toBeNull();
    expect(parseNhashUrl("https://example.com/file.jpg")).toBeNull();
  });

  it("handles nhash at start of string", () => {
    const result = parseNhashUrl("nhash1xyz789/video.mp4");
    expect(result).not.toBeNull();
    expect(result!.cid).toBe("nhash1xyz789");
    expect(result!.filename).toBe("video.mp4");
  });

  it("handles nhash at end of string", () => {
    const result = parseNhashUrl("file: nhash1xyz789");
    expect(result).not.toBeNull();
    expect(result!.cid).toBe("nhash1xyz789");
  });

  it("handles nested path in filename", () => {
    const result = parseNhashUrl("nhash1abc123/path/to/file.png");
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("path/to/file.png");
  });
});
