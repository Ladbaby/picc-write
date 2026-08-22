// =============================================================================
// picc-write — src/diff.ts
//
// Port of claude-code's `utils/diff.ts:getPatchFromContents` /
// `countLinesChanged`, using the `diff` npm package's `structuredPatch`.
//
// Adaptors vs upstream:
//   - `countLinesChanged` is made pure (returns `{ added, removed }`) — no
//     analytics / LOC counters / logging.
//   - A local structural `Hunk` type stands in for `diff`'s
//     `StructuredPatchHunk` (avoid importing from `diff`'s internal types).
// =============================================================================

import { structuredPatch } from "diff";

export const CONTEXT_LINES = 3;

/** Structural type matching `diff`'s `StructuredPatchHunk`. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  [key: string]: unknown;
}

// For some reason, & confuses the diff library, so we replace it with a token,
// then substitute it back in after the diff is computed.
const AMPERSAND_TOKEN = "<<:AMPERSAND_TOKEN:>>";
const DOLLAR_TOKEN = "<<:DOLLAR_TOKEN:>>";

function escapeForDiff(s: string): string {
  return s.replaceAll("&", AMPERSAND_TOKEN).replaceAll("$", DOLLAR_TOKEN);
}

function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, "&").replaceAll(DOLLAR_TOKEN, "$");
}

/**
 * Count lines added and removed in a patch. For new files, pass the content
 * string as the second parameter (all lines count as additions).
 */
export function countLinesChanged(
  patch: Hunk[],
  newFileContent?: string,
): { added: number; removed: number } {
  let numAdditions = 0;
  let numRemovals = 0;

  if (patch.length === 0 && newFileContent) {
    numAdditions = newFileContent.split(/\r?\n/).length;
  } else {
    for (const hunk of patch) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) numAdditions++;
        else if (line.startsWith("-")) numRemovals++;
      }
    }
  }

  return { added: numAdditions, removed: numRemovals };
}

/**
 * Compute a structured patch between two contents, with `&`/`$` escaped
 * through the diff algorithm and unescaped on the returned lines.
 */
export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
}: {
  filePath: string;
  oldContent: string;
  newContent: string;
  ignoreWhitespace?: boolean;
}): Hunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      context: CONTEXT_LINES,
    },
  );
  if (!result) {
    return [];
  }
  return result.hunks.map((h) => ({
    ...h,
    lines: h.lines.map(unescapeFromDiff),
  }));
}
