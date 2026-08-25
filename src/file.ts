// =============================================================================
// picc-write — src/file.ts
//
// Port of the pure parts of claude-code's:
//   - `utils/file.ts:writeTextContent` / `getFileModificationTime`
//   - `utils/fileRead.ts:detectEncodingForResolvedPath` /
//     `detectLineEndingsForString` / `readFileSyncWithMetadata`
//
// Adaptors vs upstream:
//   - `getFsImplementation()` → plain `node:fs`.
//   - `safeResolvePath` is dropped (the caller already passes an absolute path);
//     symlink transparency is preserved by Node's default `realpath`-free reads.
//   - `writeFileSyncAndFlush_DEPRECATED` → `fs.writeFileSync` (no explicit
//     flush needed for the pi port).
// =============================================================================

import { readFileSync, statSync, writeFileSync } from "node:fs";

export type LineEndingType = "CRLF" | "LF";

/**
 * Get the normalized modification time of a file in milliseconds. Uses
 * `Math.floor` to keep timestamp comparisons stable across operations.
 */
export function getFileModificationTime(filePath: string): number {
  return Math.floor(statSync(filePath).mtimeMs);
}

/**
 * Detect the file encoding from its leading bytes. Empty files default to
 * utf8 (not ascii) so that writing emoji/CJK to empty files is not corrupted.
 */
export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  const buffer = readFileSync(resolvedPath);
  const bytesRead = buffer.length;

  if (bytesRead === 0) {
    return "utf8";
  }

  if (bytesRead >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return "utf16le";
  }

  if (
    bytesRead >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return "utf8";
  }

  return "utf8";
}

/** Detect the dominant line-ending style in a string. */
export function detectLineEndingsForString(content: string): LineEndingType {
  let crlfCount = 0;
  let lfCount = 0;

  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      if (i > 0 && content[i - 1] === "\r") {
        crlfCount++;
      } else {
        lfCount++;
      }
    }
  }

  return crlfCount > lfCount ? "CRLF" : "LF";
}

/**
 * Read a file, returning its CRLF-normalized content plus detected encoding
 * and line-ending style in one pass.
 */
export function readFileSyncWithMetadata(filePath: string): {
  content: string;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
} {
  const encoding = detectEncodingForResolvedPath(filePath);
  const raw = readFileSync(filePath, { encoding });
  const lineEndings = detectLineEndingsForString(raw.slice(0, 4096));
  return {
    content: raw.replaceAll("\r\n", "\n"),
    encoding,
    lineEndings,
  };
}

/**
 * Write `content` to `filePath` with `endings` normalization applied.
 *
 * - `'LF'`: writes `content` verbatim (the model's sent line endings are
 *   respected as-is; no resampling of the repo).
 * - `'CRLF'`: normalizes any existing CRLF to LF first, then re-joins with
 *   CRLF so a `content` that already contains `\r\n` does not become `\r\r\n`.
 */
export function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
): void {
  let toWrite = content;
  if (endings === "CRLF") {
    toWrite = content.replaceAll("\r\n", "\n").split("\n").join("\r\n");
  }
  writeFileSync(filePath, toWrite, { encoding });
}

/**
 * Convert leading tabs on each line to two spaces. Used only for the
 * *display* patch — the written content is left untouched. Ported from
 * picc-edit so the write result diff renders with consistent indentation.
 */
export function convertLeadingTabsToSpaces(content: string): string {
  if (!content.includes("\t")) return content;
  return content.replace(/^\t+/gm, (m) => "  ".repeat(m.length));
}
