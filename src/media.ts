import { execSync } from "child_process";
import { mkdirSync, existsSync } from "fs";
import { join, extname } from "path";
import { tmpdir } from "os";

/**
 * Regex to detect nhash URLs in message content.
 * Matches: nhash1<base32>/filename.ext or just nhash1<base32>
 */
const NHASH_REGEX = /\b(nhash1[a-z0-9]+(?:\/[^\s]+)?)\b/i;

/**
 * Common image/video/audio extensions for MIME type detection
 */
const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
};

export interface ParsedNhashUrl {
  full: string;
  cid: string;
  filename: string | null;
}

export interface DownloadedMedia {
  path: string;
  mimeType: string | null;
  url: string;
}

/**
 * Parse an nhash URL from message content.
 * Returns the full match, CID, and optional filename.
 */
export function parseNhashUrl(content: string): ParsedNhashUrl | null {
  const match = content.match(NHASH_REGEX);
  if (!match) return null;

  const full = match[1];
  const parts = full.split("/");
  const cid = parts[0];
  const filename = parts.length > 1 ? parts.slice(1).join("/") : null;

  return { full, cid, filename };
}

/**
 * Detect MIME type from filename extension
 */
function mimeFromFilename(filename: string | null): string | null {
  if (!filename) return null;
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? null;
}

/**
 * Download media from an nhash URL using htree CLI.
 * Returns the local file path and detected MIME type.
 */
export async function downloadNhashMedia(
  nhash: ParsedNhashUrl,
  opts?: { tempDir?: string; timeout?: number }
): Promise<DownloadedMedia | null> {
  const tempDir = opts?.tempDir ?? join(tmpdir(), "ndr-media");
  const timeout = opts?.timeout ?? 30000;

  // Ensure temp directory exists
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  // Determine output filename
  const outputFilename = nhash.filename ?? nhash.cid;
  const outputPath = join(tempDir, outputFilename);

  try {
    // Run htree get to download the file
    execSync(`htree get "${nhash.cid}" -o "${outputPath}"`, {
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Verify file exists
    if (!existsSync(outputPath)) {
      return null;
    }

    return {
      path: outputPath,
      mimeType: mimeFromFilename(nhash.filename),
      url: nhash.full,
    };
  } catch {
    // htree not available or download failed
    return null;
  }
}

/**
 * Extract and download media from message content.
 * Returns the downloaded media info and the text with the nhash URL removed.
 */
export async function extractAndDownloadMedia(
  content: string,
  opts?: { tempDir?: string; timeout?: number }
): Promise<{
  media: DownloadedMedia | null;
  textContent: string;
}> {
  const parsed = parseNhashUrl(content);
  if (!parsed) {
    return { media: null, textContent: content };
  }

  const media = await downloadNhashMedia(parsed, opts);

  // Remove the nhash URL from the text content
  const textContent = content.replace(NHASH_REGEX, "").trim();

  return { media, textContent };
}
