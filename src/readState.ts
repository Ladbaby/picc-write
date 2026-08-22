// =============================================================================
// picc-write — src/readState.ts
//
// Session-scoped "has this file been read (and when)" map, mirroring Claude
// Code's `readFileState`. pi has no shared read-state and no `picc-edit`, so
// picc-write owns this: the entry point populates it from `tool_result` events
// (any read tool) and clears it on session start.
// =============================================================================

/** A recorded read of a file. `offset`/`limit` present ⇒ partial view. */
export type ReadEntry = {
  content: string;
  timestamp: number;
  offset?: number;
  limit?: number;
};

const state = new Map<string, ReadEntry>();

export function readStateGet(filePath: string): ReadEntry | undefined {
  return state.get(filePath);
}

export function readStateSet(filePath: string, entry: ReadEntry): void {
  state.set(filePath, entry);
}

export function readStateClear(): void {
  state.clear();
}
