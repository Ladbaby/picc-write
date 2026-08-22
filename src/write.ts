// =============================================================================
// picc-write — src/write.ts
//
// Orchestrator: a faithful port of claude-code's `FileWriteTool.ts` `call()`
// + `validateInput()` (the permission / secrets / team-memory checks are
// omitted — pi handles permissions separately).
//
// Behavior:
//   - New file          → create (no read required).
//   - Existing file     → must have been read this session (readState), and
//                         must not have been modified since that read.
//   - Always writes with LF handling (the model's sent line endings are
//     respected as-is — no repo resampling).
//   - Returns a `create`/`update` outcome with a structured patch + line
//     counts (updates) or empty patch + null original (creates).
// =============================================================================

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { countLinesChanged, getPatchFromContents, type Hunk } from "./diff.js";
import {
  getFileModificationTime,
  readFileSyncWithMetadata,
  writeTextContent,
} from "./file.js";
import { expandPath } from "./path.js";
import {
  FILE_MODIFIED_SINCE_READ_ERROR,
  FILE_NOT_READ_ERROR,
} from "./prompt.js";
import { readStateGet, readStateSet } from "./readState.js";

export type WriteInput = {
  file_path: string;
  content: string;
};

export type WriteOutcome = {
  type: "create" | "update";
  filePath: string;
  content: string;
  numLinesAdded: number;
  numLinesRemoved: number;
  structuredPatch: Hunk[];
  originalFile: string | null;
};

// Marker class so the entry point can distinguish read-guard failures from
// general filesystem errors when shaping the tool result.
export class WriteGuardError extends Error {
  // biome-ignore lint/complexity/noUselessConstructor: kept for `instanceof` semantics.
  constructor(message: string) {
    super(message);
  }
}

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Execute a write, enforcing the read-first / modified-since-read guards.
 * Returns a `WriteOutcome`, or throws `WriteGuardError` (read guards) / a
 * plain `Error` (filesystem / OS errors).
 */
export async function writeOutcome(
  input: WriteInput,
  cwd: string,
): Promise<WriteOutcome> {
  const fullFilePath = expandPath(input.file_path, cwd);
  const dir = dirname(fullFilePath);

  // Ensure parent directory exists (outside the critical section, mirroring
  // claude-code's comment that lazy-mkdir-on-ENOENT fires spurious errors).
  await mkdir(dir, { recursive: true });

  // SECURITY: skip filesystem ops for UNC paths to prevent NTLM credential
  // leaks (claude-code short-circuits here; permission layer handles them).
  if (fullFilePath.startsWith("\\\\") || fullFilePath.startsWith("//")) {
    throw new WriteGuardError(
      `Cannot write to network path: ${fullFilePath}`,
    );
  }

  // Load current state (CRLF-normalized) + detected encoding.
  let meta:
    | { content: string; encoding: BufferEncoding; lineEndings: "CRLF" | "LF" }
    | null;
  try {
    meta = readFileSyncWithMetadata(fullFilePath);
  } catch (e) {
    if (isEnoent(e)) {
      meta = null;
    } else {
      throw e;
    }
  }

  const oldContent = meta?.content ?? null;

  // Guards apply only to existing files.
  if (oldContent !== null) {
    const lastRead = readStateGet(fullFilePath);
    if (!lastRead || lastRead.offset !== undefined || lastRead.limit !== undefined) {
      throw new WriteGuardError(FILE_NOT_READ_ERROR);
    }

    const lastWriteTime = getFileModificationTime(fullFilePath);
    if (lastWriteTime > lastRead.timestamp && meta!.content !== lastRead.content) {
      throw new WriteGuardError(FILE_MODIFIED_SINCE_READ_ERROR);
    }
  }

  const enc = meta?.encoding ?? "utf8";

  // Write is a full content replacement — the model sent explicit line
  // endings in `content` and meant them. Do not rewrite them.
  writeTextContent(fullFilePath, input.content, enc, "LF");

  // Record this write as a fresh full read (invalidates stale re-writes).
  readStateSet(fullFilePath, {
    content: input.content,
    timestamp: getFileModificationTime(fullFilePath),
    offset: undefined,
    limit: undefined,
  });

  if (oldContent !== null) {
    const structuredPatch = getPatchFromContents({
      filePath: input.file_path,
      oldContent,
      newContent: input.content,
    });
    const { added, removed } = countLinesChanged(structuredPatch);
    return {
      type: "update",
      filePath: input.file_path,
      content: input.content,
      numLinesAdded: added,
      numLinesRemoved: removed,
      structuredPatch,
      originalFile: oldContent,
    };
  }

  const { added } = countLinesChanged([], input.content);
  return {
    type: "create",
    filePath: input.file_path,
    content: input.content,
    numLinesAdded: added,
    numLinesRemoved: 0,
    structuredPatch: [],
    originalFile: null,
  };
}
