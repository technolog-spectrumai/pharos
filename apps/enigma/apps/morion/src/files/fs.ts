// The workspace filesystem, as the page reaches it.
//
// Every read and write of a workspace file goes through Rust
// (src-tauri/src/workspace.rs), which holds the open workspace and refuses any
// path that would leave it — `..`, an absolute path elsewhere, a symbolic
// link. The page never decides what is inside the boundary; it only asks.
//
// This module is the store's backend (see `setFileBackend` in petalite) and
// the host's read/write pair. Off the desktop there is no Rust and no
// workspace; the browser build keeps its file-input/download fallback in the
// host and never calls anything here.
import { invoke } from "../ipc";
import { lockErrorKey } from "padova";
import type { Entry, FileBackend } from "petalite/files";

/** The Rust error prefixes this module can surface, each with a catalogue
 *  key under `workspace.errors`. Anything else is shown as it came. */
export const FS_ERRORS = [
  "no_workspace",
  "cannot_open",
  "outside_workspace",
  "symlink",
  "not_found",
  "locked",
  "not_text",
  "too_large",
  "no_session",
  "metadata",
  "too_many_tags",
  "tag_too_long",
  "tag_folder",
  "meta_damaged",
  "archive_no_password",
  "archive_wrong_password",
  "archive_inside",
  "archive_too_many",
  "archive_too_large",
  "archive_damaged",
  "archive_io",
  "archive_blocked",
  "archive_meta",
  "archive_too_deep",
  "archive_entry_password",
] as const;

export function fsErrorKey(message: string): string | null {
  const prefix = message.split(":")[0];
  return (FS_ERRORS as readonly string[]).includes(prefix) ? `workspace.errors.${prefix}` : null;
}

/** For an action run inside padova's passphrase dialog, which has words for
 *  the sealing prefixes only: the workspace key to show instead, or null to
 *  leave the error to the dialog. Encrypting prefers the sealing sentence
 *  ("too big to encrypt"); opening and decrypting prefer the workspace one
 *  ("too big to open here", "not a text file"). */
export function dialogErrorKey(message: string, mode: "lock" | "unlock" | "open"): string | null {
  if (mode === "lock" && lockErrorKey(message)) return null;
  return fsErrorKey(message);
}

/** The text of a Rust `Result<_, String>` rejection, or of any thrown thing. */
export function errorText(err: unknown): string {
  return typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
}


export interface WorkspaceInfo {
  root: string;
  name: string;
}

/** Make `root` the workspace. Answers its canonical spelling. */
export async function openWorkspace(root: string): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("workspace_open", { root });
}

export async function listDir(dir: string): Promise<Entry[]> {
  return invoke<Entry[]>("workspace_list", { dir });
}

export async function readText(path: string): Promise<string> {
  return invoke<string>("workspace_read_text", { path });
}

export async function readBytes(path: string): Promise<Uint8Array> {
  const body = await invoke<ArrayBuffer | Uint8Array | number[]>("workspace_read_bytes", { path });
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return Uint8Array.from(body);
}

export async function writeText(path: string, text: string): Promise<void> {
  await invoke("workspace_write_text", { path, text });
}

/** The store's backend: listings carry `sealed`, read from the first bytes in
 *  Rust, so the tree needs no probe per row. */
export const rustBackend: FileBackend = {
  open: async (root) => (await openWorkspace(root)).root,
  list: listDir,
  readText,
  readBytes,
};
