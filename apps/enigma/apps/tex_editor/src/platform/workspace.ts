// One open workspace: its tree, its buffers, and what the last Run said.
//
// Everything here is logic over the `totoapi` client, which is itself logic
// over an injected `fetchImpl` — so this whole module is testable with a fake
// server and no Tauri, no webview and no network. That is deliberate and is
// what most of tests/unit exercises.
import { reactive, readonly } from "vue";
import {
  ApiFailure,
  listWorkspaces, workspace as fetchWorkspace, tree as fetchTree,
  readFile, writeFile, run as runWorkspace, isQueued, pollRun,
  type ApiClient, type Workspace, type WorkspaceDetail,
  type TreeItem, type FileContent, type RunResult, type RunDetail,
} from "totoapi";

/** One editor buffer. `pk` addresses it on the server; `path` is only a label. */
export interface Buffer {
  pk: number;
  name: string;
  text: string;
  /** What the server last confirmed. `dirty` is a comparison, not a flag that
   *  can drift out of step with the text. */
  saved: string;
  /** A file over the server's read ceiling came back SHORTENED. Saving it back
   *  would destroy the tail, so the editor refuses. */
  truncated: boolean;
  /** A compile's output. Read-only on the server too; this is for the UI. */
  readonly: boolean;
}

export interface RunEntry {
  id: number;
  /** What was run, for the transcript header. */
  source: string;
  status: string;
  stdout: string;
  error: string;
  exitCode: number | null;
  files: readonly string[];
  /** The SERVER's run id, for a queued compile. Distinct from `id`, which is
   *  this transcript's own counter — confusing them polls the wrong build. */
  runId?: number;
  /** Whether polling has finished. A queued entry is rewritten IN PLACE as the
   *  build progresses, which is the one exception to the transcript being
   *  append-only: the alternative is a new entry per poll. */
  finished?: boolean;
  passes?: number;
}

export interface WorkspaceState {
  list: Workspace[];
  current: WorkspaceDetail | null;
  items: TreeItem[];
  buffers: Buffer[];
  activePk: number | null;
  entries: RunEntry[];
  busy: boolean;
  error: string;
}

const state = reactive<WorkspaceState>({
  list: [], current: null, items: [], buffers: [],
  activePk: null, entries: [], busy: false, error: "",
});

export const workspaceState = readonly(state);

let seq = 0;

/** The buffer the editor is showing, or null. */
export function active(): Buffer | null {
  return state.buffers.find((b) => b.pk === state.activePk) ?? null;
}

export function isDirty(buffer: Buffer): boolean {
  return buffer.text !== buffer.saved;
}

/** Whether this workspace may be written AT ALL.
 *
 *  Read from the SERVER's `writable`, never inferred. A client that decided for
 *  itself would have to know the permission rules and would be wrong the day
 *  they change — a staff user reads rooms they cannot edit. */
export function canWrite(): boolean {
  return Boolean(state.current?.writable);
}

function fail(err: unknown): never {
  state.error = err instanceof ApiFailure ? err.message : String(err);
  throw err;
}

export async function loadList(client: ApiClient): Promise<void> {
  state.busy = true;
  try {
    state.list = (await listWorkspaces(client)).workspaces;
    state.error = "";
  } catch (err) { fail(err); } finally { state.busy = false; }
}

export async function open(client: ApiClient, slug: string): Promise<void> {
  state.busy = true;
  try {
    state.current = await fetchWorkspace(client, slug);
    state.items = (await fetchTree(client, slug)).items;
    state.buffers = [];
    state.activePk = null;
    state.entries = [];
    state.error = "";
  } catch (err) { fail(err); } finally { state.busy = false; }
}

/** Open a file into a buffer, or focus the one already open.
 *
 *  Re-opening does NOT re-fetch: an unsaved edit is the user's work and
 *  silently replacing it with the server's copy is the worst thing this
 *  function could do. */
export async function openFile(client: ApiClient, pk: number): Promise<Buffer> {
  const existing = state.buffers.find((b) => b.pk === pk);
  if (existing) {
    state.activePk = pk;
    return existing;
  }
  state.busy = true;
  try {
    const file: FileContent = await readFile(client, slug(), pk);
    const buffer: Buffer = {
      pk: file.pk, name: file.name, text: file.content, saved: file.content,
      truncated: file.truncated, readonly: file.readonly,
    };
    state.buffers.push(buffer);
    state.activePk = pk;
    state.error = "";
    return buffer;
  } catch (err) { fail(err); } finally { state.busy = false; }
}

export function edit(pk: number, text: string): void {
  const buffer = state.buffers.find((b) => b.pk === pk);
  if (buffer) buffer.text = text;
}

export function close(pk: number): void {
  state.buffers = state.buffers.filter((b) => b.pk !== pk);
  if (state.activePk === pk) {
    // `.at(-1)` would be clearer and needs ES2022; this app targets ES2020.
    const last = state.buffers[state.buffers.length - 1];
    state.activePk = last ? last.pk : null;
  }
}

/** Why this buffer cannot be saved, or "" when it can.
 *
 *  A sentence rather than a boolean, because every one of these needs saying:
 *  a silently disabled Save button is how somebody loses an afternoon. */
export function saveRefusal(buffer: Buffer): string {
  if (buffer.truncated) {
    return "This file was too large to load whole, so saving would cut off "
      + "everything past what you can see.";
  }
  if (buffer.readonly) {
    return "This file is produced by a run — edit the source instead.";
  }
  if (!canWrite()) return "You have read-only access to this workspace.";
  return "";
}

export async function save(client: ApiClient, pk: number): Promise<void> {
  const buffer = state.buffers.find((b) => b.pk === pk);
  if (!buffer) return;
  const refusal = saveRefusal(buffer);
  if (refusal) { state.error = refusal; throw new Error(refusal); }

  state.busy = true;
  try {
    const text = buffer.text;
    await writeFile(client, slug(), pk, text);
    // The text AS SENT, not the current text: a keystroke that landed while the
    // request was in flight must stay dirty rather than be marked saved.
    buffer.saved = text;
    state.error = "";
  } catch (err) { fail(err); } finally { state.busy = false; }
}

/** Run the workspace, and put the answer in the transcript.
 *
 *  A SCRIPT THAT RAISED IS NOT AN ERROR. The server returns a traceback as an
 *  ordinary result with a non-zero exit code; only a job that could not run at
 *  all throws. Showing "we could not run your code" for a NameError is the
 *  mistake this whole path was rebuilt to avoid.
 */
export async function execute(
  client: ApiClient, payload: Record<string, unknown>, sourceLabel = "",
): Promise<RunResult> {
  state.busy = true;
  try {
    const result = await runWorkspace(client, slug(), payload);
    seq += 1;
    if (isQueued(result)) {
      const runId = Number((result.run as { id?: number }).id ?? 0);
      state.entries.push({
        id: seq, source: sourceLabel || result.main, status: "queued",
        stdout: "", error: "", exitCode: null, files: [],
        runId, finished: false,
      });
    } else {
      state.entries.push({
        id: seq, source: sourceLabel,
        status: result.status, stdout: result.stdout,
        error: result.error, exitCode: result.exit_code,
        files: result.files ?? [],
      });
    }
    state.error = "";
    return result;
  } catch (err) { fail(err); } finally { state.busy = false; }
}

export function clearTranscript(): void {
  state.entries = [];
}

function slug(): string {
  if (!state.current) throw new Error("no workspace is open");
  return state.current.slug;
}

/** Test seam. `workspaceState` is `readonly`, so a component test cannot put
 *  the store into an edited state by assigning to it — Vue refuses the write
 *  and warns, which is easy to miss in a wall of output. */
export function __setStateForTests(patch: Partial<WorkspaceState>): void {
  Object.assign(state, patch);
}

/** Test seam. */
export function __resetForTests(): void {
  Object.assign(state, {
    list: [], current: null, items: [], buffers: [],
    activePk: null, entries: [], busy: false, error: "",
  });
  seq = 0;
}


/** Ask what became of a queued run, and rewrite its transcript entry.
 *
 *  IN PLACE, which is the transcript's one exception to being append-only. A
 *  compile takes tens of seconds and is polled every second or two; a new entry
 *  per poll would bury the run before it in twenty copies of itself.
 *
 *  Returns whether polling should CONTINUE, so the caller's loop has one thing
 *  to check and cannot mistake "finished" for "failed".
 */
export async function poll(client: ApiClient, entryId: number): Promise<boolean> {
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry || !entry.runId || entry.finished) return false;

  let detail: RunDetail;
  try {
    detail = await pollRun(client, slug(), entry.runId);
  } catch (err) {
    // A POLL THAT FAILS MUST STOP THE LOOP. Left running it would hammer an
    // unreachable server once a second for as long as the window is open.
    entry.finished = true;
    entry.status = "error";
    entry.error = err instanceof ApiFailure ? err.message : String(err);
    return false;
  }

  entry.status = detail.status;
  entry.stdout = detail.stdout;
  entry.error = detail.error;
  entry.passes = detail.passes;
  entry.files = detail.artifacts ?? [];
  entry.finished = detail.finished;

  // The tree arrives WITH a finished run — a successful compile created
  // `build/`, and this is how those files appear without a second request or a
  // guess about when to make one.
  if (detail.finished && detail.items) state.items = detail.items;
  return !detail.finished;
}

/** Whether anything is still being polled — what the UI disables Compile on. */
export function isPolling(): boolean {
  return state.entries.some((e) => e.runId !== undefined && !e.finished);
}
