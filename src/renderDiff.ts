// =============================================================================
// picc-write — src/renderDiff.ts
//
// Local port of pi's built-in `renderDiff`, shared in appearance with
// picc-edit's renderer. Added lines use a fixed truecolor green so Write and
// Edit produce identical diff styling regardless of the active theme.
// =============================================================================

import { type Change, diffWords } from "diff";

/** Fixed truecolor for newly added lines (overrides the theme color). */
const ADDED_LINE_FG = "\x1b[38;2;32;124;54m";
/** Reset only the foreground color — same convention as `Theme.fg`. */
const FG_RESET = "\x1b[39m";

type RenderDiffTheme = {
	fg: (color: "toolDiffRemoved" | "toolDiffContext", text: string) => string;
	inverse: (text: string) => string;
};

function renderAddedLine(line: string): string {
	return `${ADDED_LINE_FG}${line}${FG_RESET}`;
}

function parseDiffLine(line: string): {
	prefix: string;
	lineNum: string;
	content: string;
} | null {
	const match = line.match(/^ (\s*\d+) ([-+ ]) (.*)$/);
	if (!match) return null;
	return { prefix: match[2], lineNum: match[1], content: match[3] };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	theme: RenderDiffTheme,
): { removedLine: string; addedLine: string } {
	const wordDiff: Change[] = diffWords(oldContent, newContent);
	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;
	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) removedLine += theme.inverse(value);
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) addedLine += theme.inverse(value);
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}
	return { removedLine, addedLine };
}

/** Render a line-numbered diff with picc-edit's color and word-diff styling. */
export function renderDiff(diffText: string, theme: RenderDiffTheme): string {
	const lines = diffText.split("\n");
	const result: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);
		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}
		if (parsed.prefix === "-") {
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const current = parseDiffLine(lines[i]);
				if (current?.prefix !== "-") break;
				removedLines.push({ lineNum: current.lineNum, content: current.content });
				i++;
			}
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const current = parseDiffLine(lines[i]);
				if (current?.prefix !== "+") break;
				addedLines.push({ lineNum: current.lineNum, content: current.content });
				i++;
			}
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];
				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
					theme,
				);
				result.push(theme.fg("toolDiffRemoved", ` ${removed.lineNum} - ${removedLine}`));
				result.push(renderAddedLine(` ${added.lineNum} + ${addedLine}`));
			} else {
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", ` ${removed.lineNum} - ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(renderAddedLine(` ${added.lineNum} + ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			result.push(renderAddedLine(` ${parsed.lineNum} + ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum}   ${replaceTabs(parsed.content)}`));
			i++;
		}
	}
	return result.join("\n");
}
