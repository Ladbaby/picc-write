# picc-write

Claude Code style **Write** tool for [pi](https://pi.dev) — a faithful port of Claude Code's `Write` tool, overriding pi's built-in `write`.

Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.

> pi's built-in `write` is a thin `fs.writeFile` wrapper: input `path` (relative or
> absolute), no "must read first" guard, no create/update distinction, and a
> `Successfully wrote N bytes` message. This extension replicates Claude Code's
> `Write`: `file_path` (absolute) input, a session-scoped read-first guard,
> create-vs-update results with a structured diff, and faithful success messages.

## Usage

Install via `pi install npm:@ladbabynpm/picc-write`.

## Tool

- **Name:** `write` (default; overrides pi's built-in `write`) or `Write` — configurable (see below).
- **Parameters:** `file_path` (absolute, required), `content` (required).
- **Behavior:**
  - **New file** — parent dirs are created automatically; returns `File created successfully at: <path>`.
  - **Existing file** — must have been read this session (any read tool), and must not
    have been modified since that read; returns `The file <path> has been updated
    successfully.` with a structured diff.
  - Writes with explicit LF handling (the model's sent line endings are respected as-is —
    no repo resampling).
- **Read-first guard:** reads are observed from pi `tool_result` events for any read tool
  (`read`/`Read`), so it works whether the file was read with pi's built-in `read` or
  picc-read's `Read`. The map is cleared on `session_start`.

## Configuration

| Setting | Where | Values | Default |
|---|---|---|---|
| `toolName` | `config.json` | `"write"` \| `"Write"` | `"write"` |
| `PICC_WRITE_TOOL_NAME` | env | `"write"` \| `"Write"` | — |
| `PICC_WRITE_CONFIG_PATH` | env | absolute path to a config.json | `~/.pi/agent/extensions/picc-write/config.json` |

Precedence for the tool name: `PICC_WRITE_TOOL_NAME` env > `config.json` > `"write"`.

## What is omitted from the live source

No pi equivalent, so left out: permission checks (`checkWritePermissionForTool`),
`checkTeamMemSecrets`, team-memory guards, skill discovery, `fileHistory`, LSP
`didChange`/`didSave`, `notifyVscodeFileUpdated`, `gitDiff`, and analytics.

## Development

```bash
npm install
npm run lint        # biome check
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
```
