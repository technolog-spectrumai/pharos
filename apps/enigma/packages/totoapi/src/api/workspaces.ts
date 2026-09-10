// Workspaces, files and the run verb — the ambrosia half of `/api/v1/`.
//
// This is what an editor is actually built on: a tree to draw, a file's text to
// put in a buffer, a save that goes back, and one button that does whatever
// this workspace's language does.
//
// DTOs transcribed from `toto/ambrosia/api.py` and `toto/ambrosia/filetree.py`,
// frozen server-side by `ambrosia.tests.test_api.ContractTests`.
import type { ApiClient } from "./client";

export type WorkspaceKind = "python" | "latex" | (string & {});

export interface Workspace {
  slug: string;
  name: string;
  /** `python` or `latex`. Widened to `string` on purpose: a third language app
   *  would appear here without this client being rebuilt, and a union that
   *  refused it would turn "a new feature exists" into a crash. */
  kind: WorkspaceKind;
  /** The registry's own key — `dracena`, `texlab`. */
  namespace: string;
  owner: string;
  /** WHETHER THIS TOKEN MAY WRITE, answered by the server.
   *
   *  Never decide this in the client: it would mean knowing the permission
   *  rules, and being wrong the day they change. A staff user reads rooms they
   *  cannot edit, and this is how the UI knows to grey the save button. */
  writable: boolean;
  created_at: string;
}

export interface WorkspaceDetail extends Workspace {
  /** Whether this person may run anything at all on this platform. Gated
   *  separately from editing — see `AMBROSIA_EXECUTION_ACCESS`. */
  can_execute: boolean;
}

/** One row of the flat, depth-tagged tree `filetree.flatten` produces.
 *
 *  FLAT, NOT NESTED, and that is the server's shape rather than a convenience:
 *  the room renders it directly and a client that rebuilt a hierarchy would be
 *  maintaining a second model of the same bucket. */
export interface TreeItem {
  /** `"file"` or `"dir"`. The server's own key is `t`, one character, because
   *  it repeats once per row — transcribed rather than renamed, since the
   *  contract test freezes it. */
  t: "file" | "dir" | (string & {});
  id: number;
  /** Parent directory id, or null at the root. */
  pid: number | null;
  depth: number;
  name: string;
  /** Files only. */
  file_type?: string;
  editable?: boolean;
  viewable?: boolean;
  encrypted?: boolean;
  size?: number;
  runnable?: boolean;
  /** Produced by a run. Openable — a failed compile's log is worth reading —
   *  and never writable. */
  readonly?: boolean;
  /** The one `.tex` that compiles, for a LaTeX workspace. */
  main?: boolean;
  [extra: string]: unknown;
}

export interface FileContent {
  pk: number;
  name: string;
  file_type: string;
  content: string;
  /** LOAD-BEARING. A file over the server's read ceiling comes back SHORTENED;
   *  saving that back would destroy the tail. Refuse to save when this is true
   *  — the room greys the editor out for exactly this reason. */
  truncated: boolean;
  /** A compile's output. Read-only server-side too, so this is a courtesy to
   *  the UI rather than the enforcement. */
  readonly: boolean;
  size: number;
}

export function listWorkspaces(client: ApiClient) {
  return client.get<{ workspaces: Workspace[] }>("/api/v1/workspaces");
}

export function workspace(client: ApiClient, slug: string) {
  return client.get<WorkspaceDetail>(`/api/v1/workspaces/${slug}`);
}

export function tree(client: ApiClient, slug: string) {
  return client.get<{ items: TreeItem[] }>(`/api/v1/workspaces/${slug}/tree`);
}

export function readFile(client: ApiClient, slug: string, pk: number) {
  return client.get<FileContent>(`/api/v1/workspaces/${slug}/files/${pk}`);
}

export function writeFile(
  client: ApiClient, slug: string, pk: number, content: string,
) {
  return client.post<{ pk: number; size: number }>(
    `/api/v1/workspaces/${slug}/files/${pk}/save`, { content });
}

export function createFile(
  client: ApiClient, slug: string, name: string, directory?: number | null,
) {
  return client.post<{ pk: number; name: string; items: TreeItem[] }>(
    `/api/v1/workspaces/${slug}/files/new`, { name, directory: directory ?? null });
}

export function createFolder(
  client: ApiClient, slug: string, name: string, parent?: number | null,
) {
  return client.post<{ items: TreeItem[] }>(
    `/api/v1/workspaces/${slug}/folders/new`, { name, parent: parent ?? null });
}

export function renameFile(
  client: ApiClient, slug: string, pk: number, name: string,
) {
  return client.post<{ items: TreeItem[] }>(
    `/api/v1/workspaces/${slug}/files/${pk}/rename`, { name });
}

export function deleteFile(client: ApiClient, slug: string, pk: number) {
  return client.post<{ items: TreeItem[] }>(
    `/api/v1/workspaces/${slug}/files/${pk}/delete`);
}

// --------------------------------------------------------------------------
// Running
// --------------------------------------------------------------------------

/** What `POST /run` answers, for either language.
 *
 *  THE TWO SHAPES ARE GENUINELY DIFFERENT and are not flattened into a common
 *  envelope: Python answers synchronously with output, LaTeX answers with a run
 *  to poll. Inventing a shared wrapper would mean every caller unwrapping a
 *  fiction. `queued` is the discriminant — set from the payload rather than
 *  from the kind, so a language that later changes which way it works needs no
 *  client change. */
export type RunResult = SyncRun | QueuedRun;

export interface SyncRun {
  slug: string;
  kind: WorkspaceKind;
  queued: false;
  status: string;
  /** One stream. The runner merges stderr into stdout so a traceback sits where
   *  it happened relative to the prints around it. `stderr` is present and
   *  empty rather than absent, so a client reading it gets "" not a crash. */
  stdout: string;
  stderr: string;
  error: string;
  exit_code: number | null;
  /** Names of files the run produced, to fetch separately. Not the bytes: a
   *  run that writes a 40 MB PDF must not put it through this response. */
  files: string[];
}

export interface QueuedRun {
  slug: string;
  kind: WorkspaceKind;
  queued: true;
  status: "queued";
  run: Record<string, unknown>;
  main: string;
  main_pk: number;
}

export function isQueued(result: RunResult): result is QueuedRun {
  return result.queued === true;
}

/** Do whatever this workspace's language does.
 *
 *  ONE endpoint for both. A Python workspace takes `{code}`; a LaTeX workspace
 *  takes an optional `{capsule}`. A client does not have to know which it is
 *  holding — and a third language would work here without a rebuild.
 *
 *  A SCRIPT THAT RAISED IS NOT AN ERROR. The server treats a failure carrying a
 *  report as an ordinary result with the traceback in `stdout`; only a job that
 *  could not RUN at all (killed at its deadline, OOM-killed, lost) throws. Do
 *  not show "we could not run your code" for a NameError. */
export function run(
  client: ApiClient, slug: string, payload: Record<string, unknown> = {},
) {
  return client.post<RunResult>(`/api/v1/workspaces/${slug}/run`, payload);
}

/** What became of a queued run.
 *
 *  THE OTHER HALF OF `run`, and a LaTeX client cannot work without it: `run`
 *  answers with a receipt and a compile takes tens of seconds, so a client that
 *  could not ask what became of the id would start builds and never learn
 *  whether they worked.
 *
 *  404 with `code: "no_poll_verb"` where the language answers immediately — a
 *  Python workspace's Run IS the result, so there is nothing to come back for.
 *  Branch on the code, not on the status.
 */
export function pollRun(client: ApiClient, slug: string, runId: number) {
  return client.get<RunDetail>(`/api/v1/workspaces/${slug}/runs/${runId}`);
}

/** One compile, as the server reports it.
 *
 *  Transcribed from texlab's `_run_payload`. `status` is deliberately the same
 *  key a synchronous run uses so a transcript can render both through one path;
 *  `state` is the run's own lifecycle value underneath it. */
export interface RunDetail {
  id: number;
  state: string;
  /** Stop polling when this is true. */
  finished: boolean;
  status: string;
  /** Empty until finished — a half-written log is worse than none. */
  stdout: string;
  error: string;
  passes: number;
  artifacts: string[];
  pdf_pk: number | null;
  main: string;
  duration: number | null;
  /** THE TREE, and only on a finished run. A successful compile creates
   *  `build/`, and a client that had to guess when to refetch would either miss
   *  the new files or poll the tree forever. */
  items?: TreeItem[];
}
