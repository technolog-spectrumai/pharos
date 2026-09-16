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
  foldFile, isConflict, pending, pushRefusal,
  readWorkspace as readCached, recordEdit, summarise,
  writeWorkspace as writeCached,
  type ApiClient, type Workspace, type WorkspaceDetail,
  type TreeItem, type FileContent, type RunResult, type RunDetail,
  type CacheStore, type CachedWorkspace,
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
  /** True when the last server call failed for want of a network. What the UI
   *  branches on to say "editing locally" instead of showing an error. */
  offline: boolean;
  /** Files edited while offline and not yet pushed. */
  pendingCount: number;
  /** Files the server changed underneath a local edit, named for the person to
   *  resolve. Never resolved automatically — see `syncPending`. */
  conflicts: string[];
}

const state = reactive<WorkspaceState>({
  list: [], current: null, items: [], buffers: [],
  activePk: null, entries: [], busy: false, error: "",
  offline: false, pendingCount: 0, conflicts: [],
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

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

/** Where the cache lives, when one has been attached.
 *
 *  INJECTED, never imported: this module is tested with a fake server and no
 *  Tauri, and importing the desktop store here would end that. `main.ts`
 *  attaches the real one; tests attach a Map. */
let store: CacheStore | null = null;

export function useCache(next: CacheStore | null): void {
  store = next;
}

/** Whether this failure means "no network" rather than "the server said no".
 *
 *  THE DISTINCTION THE WHOLE OFFLINE PATH RESTS ON. A 403 must NOT put the
 *  editor into offline mode — the server is right there and is refusing, and
 *  quietly switching to a local copy would hide a permission problem behind a
 *  cache. Only a transport failure counts. */
function isOffline(err: unknown): boolean {
  return err instanceof ApiFailure && err.error.kind === "network";
}

/** Snapshot the open workspace into the cache. Best effort: a cache that will
 *  not write must never break a session that is working. */
async function remember(): Promise<void> {
  if (!store || !state.current) return;
  const existing = await readCached(store, state.current.slug);
  const files: CachedWorkspace["files"] = { ...(existing?.files ?? {}) };
  for (const buffer of state.buffers) {
    const key = String(buffer.pk);
    const prior = files[key];
    files[key] = {
      pk: buffer.pk,
      name: buffer.name,
      saved: buffer.saved,
      text: buffer.text,
      truncated: buffer.truncated,
      readonly: buffer.readonly,
      fetchedAt: prior?.fetchedAt ?? Date.now(),
      editedAt: buffer.text === buffer.saved ? 0 : (prior?.editedAt || Date.now()),
    };
  }
  const snapshot: CachedWorkspace = {
    slug: state.current.slug,
    detail: state.current,
    items: [...state.items],
    files,
    cachedAt: Date.now(),
  };
  await writeCached(store, snapshot);
  state.pendingCount = summarise(snapshot).files;
}

/** Open a workspace from the cache. Returns false when nothing is cached, so
 *  the caller can report the network failure rather than an empty screen. */
async function openFromCache(slug: string): Promise<boolean> {
  if (!store) return false;
  const cached = await readCached(store, slug);
  if (!cached) return false;
  state.current = cached.detail;
  state.items = cached.items;
  state.buffers = Object.values(cached.files).map((f) => ({
    pk: f.pk, name: f.name, text: f.text, saved: f.saved,
    truncated: f.truncated, readonly: f.readonly,
  }));
  state.activePk = null;
  state.entries = [];
  state.offline = true;
  state.pendingCount = summarise(cached).files;
  state.error = "";
  return true;
}

/** Push everything edited offline, oldest edit first.
 *
 *  A CONFLICT IS REPORTED, NEVER RESOLVED. If the server's copy moved while we
 *  were away, this leaves the file pending and names it. Merging automatically
 *  would mean guessing which of two people's afternoons matters more, and
 *  overwriting is the same guess with the answer hidden. */
export async function syncPending(client: ApiClient): Promise<string[]> {
  if (!store || !state.current) return [];
  const cached = await readCached(store, state.current.slug);
  if (!cached) return [];

  const conflicts: string[] = [];
  for (const file of pending(cached)) {
    if (pushRefusal(file)) continue;
    try {
      const fresh = await readFile(client, state.current.slug, file.pk);
      if (isConflict(file, fresh.content)) {
        conflicts.push(file.name);
        continue;
      }
      await writeFile(client, state.current.slug, file.pk, file.text);
      cached.files[String(file.pk)] = { ...file, saved: file.text, editedAt: 0 };
      const buffer = state.buffers.find((b) => b.pk === file.pk);
      if (buffer) buffer.saved = file.text;
    } catch (err) {
      if (isOffline(err)) break;   // still away; keep the queue for later
      conflicts.push(file.name);
    }
  }
  await writeCached(store, cached);
  state.conflicts = conflicts;
  state.pendingCount = summarise(cached).files;
  if (conflicts.length === 0) state.offline = false;
  return conflicts;
}

/** What is waiting to be pushed, for the UI. */
export function pendingCount(): number {
  return state.pendingCount;
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
    state.offline = false;
    state.error = "";
    await remember();
  } catch (err) {
    // The network is what is missing, so try the copy. Anything else — a 403,
    // a 404 — is the server answering and must surface as itself.
    if (isOffline(err) && await openFromCache(slug)) return;
    fail(err);
  } finally { state.busy = false; }
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
    const cached = store ? await readCached(store, slug()) : null;
    // Through `foldFile`, never straight from the response: it is what keeps
    // an edit made offline when the same file is re-read online.
    const folded = foldFile(cached?.files[String(pk)], file, Date.now());
    const buffer: Buffer = {
      pk: folded.pk, name: folded.name, text: folded.text, saved: folded.saved,
      truncated: folded.truncated, readonly: folded.readonly,
    };
    state.buffers.push(buffer);
    state.activePk = pk;
    state.error = "";
    await remember();
    return buffer;
  } catch (err) {
    if (isOffline(err) && store) {
      const cached = await readCached(store, slug());
      const hit = cached?.files[String(pk)];
      if (hit) {
        const buffer: Buffer = {
          pk: hit.pk, name: hit.name, text: hit.text, saved: hit.saved,
          truncated: hit.truncated, readonly: hit.readonly,
        };
        state.buffers.push(buffer);
        state.activePk = pk;
        state.offline = true;
        state.error = "";
        return buffer;
      }
    }
    fail(err);
  } finally { state.busy = false; }
}

export function edit(pk: number, text: string): void {
  const buffer = state.buffers.find((b) => b.pk === pk);
  if (!buffer || buffer.text === text) return;
  buffer.text = text;
  // Fire and forget: a keystroke must not wait on a disk write, and a cache
  // that failed is already handled as a miss everywhere it is read.
  void cacheEdit(pk, text);
}

/** Record one edit in the cache, so closing the laptop does not lose it. */
async function cacheEdit(pk: number, text: string): Promise<void> {
  if (!store || !state.current) return;
  const cached = await readCached(store, state.current.slug);
  const existing = cached?.files[String(pk)];
  if (!cached || !existing) return;
  cached.files[String(pk)] = recordEdit(existing, text, Date.now());
  await writeCached(store, cached);
  state.pendingCount = summarise(cached).files;
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
    state.offline = false;
    state.error = "";
    await remember();
  } catch (err) {
    // OFFLINE IS NOT A FAILED SAVE. The text is already in the cache, so the
    // honest report is "kept here, waiting for the server" — and `saved` must
    // NOT move, because the file genuinely is not on the server yet.
    if (isOffline(err)) {
      state.offline = true;
      await cacheEdit(pk, buffer.text);
      state.error = "";
      return;
    }
    fail(err);
  } finally { state.busy = false; }
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
    offline: false, pendingCount: 0, conflicts: [],
  });
  seq = 0;
  store = null;
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
