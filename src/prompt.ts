// =============================================================================
// picc-write — src/prompt.ts
//
// Port of claude-code's `tools/FileWriteTool/prompt.ts` (tool name, description,
// full usage prompt) plus the read-guard error strings from `FileWriteTool.ts`.
// =============================================================================

export const FILE_WRITE_TOOL_NAME = "Write";

export const DESCRIPTION = "Write a file to the local filesystem.";

export const PROMPT = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;

/**
 * Error strings returned by the write orchestrator when the read-first /
 * modified-since-read guards fire.
 */
export const FILE_NOT_READ_ERROR =
  "File has not been read yet. Read it first before writing to it.";

export const FILE_MODIFIED_SINCE_READ_ERROR =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

/** Success messages (from Claude Code's `mapToolResultToToolResultBlockParam`). */
export function createSuccessMessage(filePath: string): string {
  return `File created successfully at: ${filePath}`;
}

export function updateSuccessMessage(filePath: string): string {
  return `The file ${filePath} has been updated successfully.`;
}
