/**
 * picc-write: Claude Code-style Write tool for pi.
 *
 * A faithful port of Claude Code's `Write` tool
 * (`tools/FileWriteTool/FileWriteTool.ts`), registering a tool named
 * `write`/`Write` that **overrides pi's built-in `write`** tool (same-name,
 * last-write-wins — see `core/tools/index.js`).
 *
 * Differences from pi's built-in `write`:
 *   - Input is `file_path` (absolute) + `content` (not `path`).
 *   - Enforces Claude Code's read-first guard: an existing file must have been
 *     read this session, and must not have been modified since that read.
 *     Read-state is tracked from `tool_result` events for any file tool that
 *     establishes known contents (read/write/edit) — mirroring Claude Code,
 *     where a file the agent just wrote or edited is immediately writable.
 *   - Distinguishes create vs update and returns a structured patch +
 *     `originalFile` in `details`, with faithful success messages.
 *   - Writes with explicit LF handling (the model's sent line endings are
 *     respected as-is — no repo resampling).
 *
 * Omitted from the live source (no pi equivalent):
 *   - permission checks (`checkWritePermissionForTool` — pi's permission
 *     system handles writes separately)
 *   - `checkTeamMemSecrets`, team-memory guards, skill discovery, `fileHistory`
 *   - LSP `didChange`/`didSave`, `notifyVscodeFileUpdated`, `gitDiff`,
 *     analytics (`logEvent`), GrowthBook
 *
 * Tool name configuration:
 *   - Default: `"write"` (lowercase; pi's built-in tool name).
 *   - Set `config.json` `toolName` to `"Write"` (default location
 *     `~/.pi/agent/extensions/picc-write/config.json`), or set
 *     `PICC_WRITE_TOOL_NAME=Write`. Valid values: `"write"`, `"Write"`.
 *
 * References:
 * - Claude Code Write tool: tools/FileWriteTool/FileWriteTool.ts (+ prompt.ts, UI.tsx)
 * - Claude Code helpers: utils/file.ts, utils/fileRead.ts, utils/diff.ts, utils/path.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	generateDiffString,
	renderDiff,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	convertLeadingTabsToSpaces,
	getFileModificationTime,
	readFileSyncWithMetadata,
} from "./src/file.js";
import { expandPath } from "./src/path.js";
import {
	createSuccessMessage,
	PROMPT,
	updateSuccessMessage,
} from "./src/prompt.js";
import {
	fileStateToolName,
	type ReadEntry,
	readStateClear,
	readStateSet,
	shouldClearReadState,
} from "./src/readState.js";
import {
	type WriteInput,
	type WriteOutcome,
	writeOutcome,
} from "./src/write.js";

// ============================================================================
// Config (mirrors picc-read)
// ============================================================================

const VALID_TOOL_NAMES = ["write", "Write"] as const;
type ToolName = (typeof VALID_TOOL_NAMES)[number];

// Max lines of a newly written file rendered in the TUI create preview.
// Mirrors Claude Code's `MAX_LINES_TO_RENDER` (tools/FileWriteTool/UI.tsx) —
// in non-verbose mode the file contents are capped and a "… +N lines" footer
// is shown. pi's renderResult has no verbose/expand flag, so this is always
// applied.
const MAX_LINES_TO_RENDER = 10;

function resolveConfigPath(): string {
	const env = process.env.PICC_WRITE_CONFIG_PATH;
	if (env) return env;
	return join(
		homedir(),
		".pi",
		"agent",
		"extensions",
		"picc-write",
		"config.json",
	);
}

function readToolNameFromConfig(): ToolName | undefined {
	const configPath = resolveConfigPath();
	if (!existsSync(configPath)) return undefined;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as { toolName?: unknown };
		const val = parsed?.toolName;
		if (
			typeof val === "string" &&
			(VALID_TOOL_NAMES as readonly string[]).includes(val)
		) {
			return val as ToolName;
		}
		if (val !== undefined) {
			console.warn(
				`[picc-write] config.json: invalid toolName "${val}" — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "write".`,
			);
		}
	} catch {
		// unreadable / malformed — fall through to default
	}
	return undefined;
}

function loadToolName(): ToolName {
	const envVal = process.env.PICC_WRITE_TOOL_NAME;
	if (typeof envVal === "string") {
		if ((VALID_TOOL_NAMES as readonly string[]).includes(envVal)) {
			return envVal as ToolName;
		}
		console.warn(
			`[picc-write] PICC_WRITE_TOOL_NAME="${envVal}" is invalid — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "write".`,
		);
	}
	return readToolNameFromConfig() ?? "write";
}

// ============================================================================
// Schema
// ============================================================================

const WRITE_SCHEMA = Type.Object({
    content: Type.String({
        description: "The content to write to the file",
    }),
	file_path: Type.String({
		description:
			"The absolute path to the file to write (must be absolute, not relative)",
	}),
});

// ============================================================================
// Read-state tracking (populates the write guard across file tools)
// ============================================================================

function recordRead(input: Record<string, unknown>, cwd: string): void {
	const rawPath = input.file_path;
	if (typeof rawPath !== "string" || !rawPath) return;

	let fullPath: string;
	try {
		fullPath = expandPath(rawPath, cwd);
	} catch {
		return;
	}

	try {
		const meta = readFileSyncWithMetadata(fullPath);
		const timestamp = getFileModificationTime(fullPath);
		const offset = typeof input.offset === "number" ? input.offset : undefined;
		const limit = typeof input.limit === "number" ? input.limit : undefined;
		const entry: ReadEntry = {
			content: meta.content,
			timestamp,
			offset,
			limit,
		};
		readStateSet(fullPath, entry);
	} catch {
		// file gone or unreadable — nothing to record
	}
}

// ============================================================================
// Create preview (TUI channel) — Claude Code's `FileWriteToolCreatedMessage`
// ============================================================================

/**
 * Build the TUI render for a NEW file (the `create` branch). Claude Code's
 * `renderToolResultMessage` shows, for a create, a "Wrote N lines to <path>"
 * header followed by a preview of the file contents capped at
 * `MAX_LINES_TO_RENDER` lines and a dim "… +M lines" footer when truncated
 * (see `tools/FileWriteTool/UI.tsx`). pi's `renderResult` has no `verbose` /
 * Ctrl-O-expand affordance, so we always render the truncated preview.
 *
 * `details.content` holds the written content and `details.numLinesAdded` the
 * line count (both already populated by `writeOutcome`).
 */
function createPreviewText(
	details: { filePath: string; content: string },
	theme: {
		fg: (c: "toolTitle" | "accent" | "muted" | "dim", t: string) => string;
		bold: (t: string) => string;
	},
): string {
	const lines = details.content.split("\n");
	const total = lines.length;
	const shown = lines.slice(0, MAX_LINES_TO_RENDER);
	const remaining = total - MAX_LINES_TO_RENDER;

	// Faded header (bold kept on count + path).
	const header =
		"Wrote " +
		theme.bold(String(total)) +
		" " +
		(total === 1 ? "line" : "lines")
        // WARNING: although is it more faithful to include the following contents to match Claude Code, we choose to omit them, since the tool result block's header already includes the file path
		// " to " +
		// theme.fg("accent", theme.bold(details.filePath));

	// Line numbers, right-aligned to the shown line count's width, dimmed to
	// recede further than the muted header. Content stays the default (bright)
	// text color.
	const width = String(shown.length).length;
	const body = shown
		.map((line, i) =>
			theme.fg("dim", String(i + 1).padStart(width)) + " " + line.replace(/\t/g, "  "),
		)
		.join("\n");

	const footer =
		remaining > 0
			? "\n" + theme.fg("muted", `… +${remaining} line${remaining === 1 ? "" : "s"}`)
			: "";

	return (
		theme.fg("muted", header) +
		"\n" +
		body +
		footer
	);
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	const toolName = loadToolName();

	// Clear any stale read-state on a fresh/reloaded *interactive* session.
	// Subagent/headless sessions (hasUI === false) share this module's state
	// in-process and fire their own session_start; clearing there would wipe
	// the interactive session's read-state mid-conversation (the plan-mode
	// "File has not been read yet" bug). See shouldClearReadState.
	pi.on("session_start", (_event, ctx) => {
		if (shouldClearReadState(ctx.hasUI)) {
			readStateClear();
		}
	});

	// Observe successful file tools (read/write/edit) to feed the write guard.
	// Claude Code refreshes its shared `readFileState` from all three, so a file
	// the agent just wrote or edited is immediately writable without a redundant
	// re-read. `tool_result` events carry no cwd of their own; use the process
	// cwd.
	pi.on("tool_result", (event) => {
		if (!fileStateToolName(event.toolName)) return;
		if (event.isError) return;
		recordRead(event.input, process.cwd());
	});

	pi.registerTool({
		name: toolName,
		label: toolName,
		description: PROMPT,
		promptSnippet: "Create or overwrite files",
		promptGuidelines: [],
		parameters: WRITE_SCHEMA,
		// Rely on the framework's default background shell (colored Box)
		// rather than self-framing — the standard pending/success/error
		// background is applied based on isError (see tool-execution).
		// Overrides the built-in `write`, which we do NOT want to inherit
		// its `renderCall`/`renderResult` (they always dump content).
		renderShell: "default",
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const input = params as WriteInput;
			const cwd = ctx.cwd;

			try {
				const outcome: WriteOutcome = await writeOutcome(input, cwd);
				const message =
					outcome.type === "create"
						? createSuccessMessage(outcome.filePath)
						: updateSuccessMessage(outcome.filePath);
				// Display-oriented, line-numbered diff in the exact format the
				// built-in diff viewer (`renderDiff`) expects. Both sides are put in
				// the same display space (leading tabs → 2 spaces) so the update
				// diff does not balloon to the whole file. Lives only in `details`
				// (TUI channel) — the model sees just `content`.
				const { diff } =
					outcome.originalFile !== null
						? generateDiffString(
								convertLeadingTabsToSpaces(outcome.originalFile),
								outcome.content,
							)
						: { diff: "" };
				return {
					content: [{ type: "text", text: message }],
					details: { ...outcome, diff },
				};
			} catch (err) {
				// pi's agent loop only flags a tool result as errored when
				// execute() rejects — a resolved `{ isError: true }` is dropped
				// (agent-loop returns `{ result, isError: false }` on resolve).
				// Throw so the guard / validation / fs failure is surfaced as a
				// real tool error (matching pi's built-in `write` and picc-edit).
				throw err instanceof Error ? err : new Error(String(err));
			}
		},
		renderCall(args, theme, context) {
			const path =
				typeof args.file_path === "string" ? args.file_path : "";
			let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
			text += theme.fg("accent", path);
			const t =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			t.setText(text);
			return t;
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Writing..."), 0, 0);
			}
			const t =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			// On error, details is undefined. Show the error message in red.
			if (context.isError) {
				const errorMsg = result.content
					.filter(
						(c): c is { type: "text"; text: string } => c.type === "text",
					)
					.map((c) => c.text)
					.join("\n");
				t.setText(theme.fg("error", errorMsg || "Write failed"));
				return t;
			}
			const details = result.details as
				| (WriteOutcome & { diff?: string })
				| undefined;
			// Updates render a summary line + diff. Creates render a "Wrote N
			// lines" header + a capped preview of the written content (see
			// createPreviewText) — mirroring Claude Code's create branch.
			if (details?.diff) {
				t.setText(
					"\n" +
						theme.fg("success", updateSuccessMessage(details.filePath)) +
						"\n" +
						renderDiff(details.diff),
				);
			} else if (details) {
				t.setText(createPreviewText(details, theme));
			} else {
				t.setText(theme.fg("success", "Written"));
			}
			return t;
		},
	});
}
