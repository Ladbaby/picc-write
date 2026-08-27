import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	countLinesChanged,
	getPatchFromContents,
} from "../src/diff.js";
import {
	convertLeadingTabsToSpaces,
	detectLineEndingsForString,
	writeTextContent,
} from "../src/file.js";
import { expandPath } from "../src/path.js";
import {
	createSuccessMessage,
	DESCRIPTION,
	FILE_MODIFIED_SINCE_READ_ERROR,
	FILE_NOT_READ_ERROR,
	FILE_WRITE_TOOL_NAME,
	updateSuccessMessage,
} from "../src/prompt.js";
import {
	fileStateToolName,
	readStateClear,
	readStateSet,
	shouldClearReadState,
} from "../src/readState.js";
import {
	WriteGuardError,
	writeOutcome,
} from "../src/write.js";

describe("prompt", () => {
	it("exposes the tool name and short description", () => {
		expect(FILE_WRITE_TOOL_NAME).toBe("Write");
		expect(DESCRIPTION).toBe("Write a file to the local filesystem.");
	});
	it("formats success messages", () => {
		expect(createSuccessMessage("/a.txt")).toBe(
			"File created successfully at: /a.txt",
		);
		expect(updateSuccessMessage("/a.txt")).toBe(
			"The file /a.txt has been updated successfully.",
		);
	});
});

describe("line endings", () => {
	it("detects CRLF vs LF", () => {
		expect(detectLineEndingsForString("a\r\nb\r\n")).toBe("CRLF");
		expect(detectLineEndingsForString("a\nb\n")).toBe("LF");
	});
});

describe("convertLeadingTabsToSpaces", () => {
	it("converts leading tabs to two spaces and leaves others", () => {
		expect(convertLeadingTabsToSpaces("\ta\n\t\tb\nc")).toBe(
			"  a\n    b\nc",
		);
	});
	it("returns the input unchanged when there are no tabs", () => {
		expect(convertLeadingTabsToSpaces("a\nb")).toBe("a\nb");
	});
});

describe("shouldClearReadState", () => {
	it("clears only for interactive (has UI) sessions", () => {
		expect(shouldClearReadState(true)).toBe(true);
		expect(shouldClearReadState(false)).toBe(false);
	});
});

describe("fileStateToolName", () => {
	it("treats read/write/edit (both cases) as file-state tools", () => {
		expect(fileStateToolName("read")).toBe(true);
		expect(fileStateToolName("Read")).toBe(true);
		expect(fileStateToolName("write")).toBe(true);
		expect(fileStateToolName("Write")).toBe(true);
		expect(fileStateToolName("edit")).toBe(true);
		expect(fileStateToolName("Edit")).toBe(true);
	});

	it("rejects unrelated tool names", () => {
		expect(fileStateToolName("bash")).toBe(false);
		expect(fileStateToolName("grep")).toBe(false);
		expect(fileStateToolName("")).toBe(false);
	});
});

describe("writeTextContent", () => {
	it("writes verbatim with LF", async () => {
		const dir = await mkdtemp(join(tmpdir(), "picc-write-"));
		const file = join(dir, "lf.txt");
		writeTextContent(file, "a\r\nb\n", "utf8", "LF");
		expect(await readFile(file, "utf8")).toBe("a\r\nb\n");
	});
});

describe("diff", () => {
	it("produces a hunk for a changed line", () => {
		const patch = getPatchFromContents({
			filePath: "f.txt",
			oldContent: "a\nb\nc\n",
			newContent: "a\nB\nc\n",
		});
		expect(patch.length).toBeGreaterThan(0);
		const { added, removed } = countLinesChanged(patch);
		expect(added).toBe(1);
		expect(removed).toBe(1);
	});
	it("counts all lines as additions for a new file", () => {
		const { added, removed } = countLinesChanged([], "x\ny\nz");
		expect(added).toBe(3);
		expect(removed).toBe(0);
	});
});

describe("expandPath", () => {
	it("resolves ~ to home", () => {
		expect(expandPath("~").length).toBeGreaterThan(0);
	});
	it("throws on null bytes", () => {
		expect(() => expandPath("a\0b")).toThrow(/null bytes/i);
	});
});

describe("writeOutcome", () => {
	let cwd: string;
	beforeEach(async () => {
		readStateClear();
		cwd = await mkdtemp(join(tmpdir(), "picc-write-orch-"));
	});

	it("creates a new file (no read required)", async () => {
		const file = join(cwd, "new.txt");
		const outcome = await writeOutcome(
			{ file_path: file, content: "hello" },
			cwd,
		);
		expect(outcome.type).toBe("create");
		expect(outcome.originalFile).toBeNull();
		expect(outcome.structuredPatch).toEqual([]);
		expect(outcome.numLinesAdded).toBe(1);
	});

	it("auto-creates parent directories", async () => {
		const file = join(cwd, "a", "b", "c.txt");
		const outcome = await writeOutcome(
			{ file_path: file, content: "nested" },
			cwd,
		);
		expect(outcome.type).toBe("create");
		expect((await stat(file)).isFile()).toBe(true);
	});

	it("rejects writing an existing file that was not read", async () => {
		const file = join(cwd, "unread.txt");
		await writeFile(file, "old");
		await expect(
			writeOutcome({ file_path: file, content: "new" }, cwd),
		).rejects.toThrow(FILE_NOT_READ_ERROR);
	});

	it("allows writing a file the agent just edited (no re-read needed)", async () => {
		// Simulates the edit→write flow: an `edit` result seeds read-state with a
		// fresh full-read entry (what recordRead now does for read/write/edit),
		// so the follow-up write must NOT throw FILE_NOT_READ_ERROR — matching
		// Claude Code, where FileEditTool refreshes the shared `readFileState`.
		const file = join(cwd, "edited.txt");
		await writeFile(file, "one\ntwo\nthree");
		readStateSet(file, {
			content: "one\ntwo\nthree",
			timestamp: Math.floor((await stat(file)).mtimeMs),
			offset: undefined,
			limit: undefined,
		});
		const outcome = await writeOutcome(
			{ file_path: file, content: "one\nTWO\nthree" },
			cwd,
		);
		expect(outcome.type).toBe("update");
		expect(outcome.originalFile).toBe("one\ntwo\nthree");
		expect(await readFile(file, "utf8")).toBe("one\nTWO\nthree");
	});

	it("updates a file that was read", async () => {
		const file = join(cwd, "read.txt");
		await writeFile(file, "line1\nline2");
		readStateSet(file, {
			content: "line1\nline2",
			timestamp: Math.floor((await stat(file)).mtimeMs),
		});
		const outcome = await writeOutcome(
			{ file_path: file, content: "line1\nLINE2" },
			cwd,
		);
		expect(outcome.type).toBe("update");
		expect(outcome.originalFile).toBe("line1\nline2");
		expect(outcome.numLinesAdded).toBe(1);
		expect(outcome.numLinesRemoved).toBe(1);
	});

	it("rejects a file modified since it was read", async () => {
		const file = join(cwd, "changed.txt");
		await writeFile(file, "stable");
		const oldTime = Math.floor((await stat(file)).mtimeMs) - 100_000;
		readStateSet(file, {
			content: "STALE",
			timestamp: oldTime,
		});
		await expect(
			writeOutcome({ file_path: file, content: "x" }, cwd),
		).rejects.toMatchObject({
			message: FILE_MODIFIED_SINCE_READ_ERROR,
		});
	});

	it("re-throws guard errors as WriteGuardError", async () => {
		const file = join(cwd, "g.txt");
		await writeFile(file, "old");
		try {
			await writeOutcome({ file_path: file, content: "x" }, cwd);
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(WriteGuardError);
		}
	});

	it("keeps a create's read-state across a headless (subagent) session start", async () => {
		const file = join(cwd, "plan.md");
		const created = await writeOutcome(
			{ file_path: file, content: "v1" },
			cwd,
		);
		expect(created.type).toBe("create");

		// A subagent/headless session_start must NOT clear read-state
		// (shouldClearReadState(false) === false), so a subsequent full
		// rewrite of the plan file still satisfies the read-first guard.
		expect(shouldClearReadState(false)).toBe(false);
		const updated = await writeOutcome(
			{ file_path: file, content: "v2\nv3" },
			cwd,
		);
		expect(updated.type).toBe("update");
		expect(updated.originalFile).toBe("v1");
	});

	it("fails the read-first guard when read-state IS cleared", async () => {
		const file = join(cwd, "plan2.md");
		await writeOutcome({ file_path: file, content: "v1" }, cwd);

		// Simulating an interactive session reset clears read-state; a
		// follow-up write then must be rejected until re-read.
		readStateClear();
		await expect(
			writeOutcome({ file_path: file, content: "v2" }, cwd),
		).rejects.toThrow(FILE_NOT_READ_ERROR);
	});
});
