import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import plugin from "../index.js";

type JsonRecord = Record<string, unknown>;

function readJson(filePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonRecord;
}

describe("plugin id consistency", () => {
  it("uses ndr as plugin id across export, manifest, and package metadata", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const manifest = readJson(path.join(root, "openclaw.plugin.json"));
    const pkg = readJson(path.join(root, "package.json"));
    const openclaw = (pkg.openclaw ?? {}) as JsonRecord;

    expect(plugin.id).toBe("ndr");
    expect(manifest.id).toBe("ndr");
    expect(openclaw.id).toBe("ndr");
  });
});
