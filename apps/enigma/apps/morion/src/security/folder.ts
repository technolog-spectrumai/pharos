// Folder encryption, as the page reaches src-tauri/src/folder.rs.
import { invoke } from "../ipc";

export interface FolderPreview {
  files: number;
  plain: number;
  sealed: number;
  links: number;
  /** The file cap stopped the count: a second run reaches more. */
  truncated: boolean;
  /** Folders below the depth limit were not entered: no run reaches them. */
  deep: boolean;
}

export interface FolderReport {
  done: string[];
  skipped: string[];
  /** Not tried: the run stopped at a wrong passphrase. */
  untried: string[];
  failed: Array<{ path: string; error: string }>;
  links: number;
  truncated: boolean;
  deep: boolean;
}


export function folderPreview(dir: string): Promise<FolderPreview> {
  return invoke<FolderPreview>("folder_preview", { dir });
}

/** `password` null means the remembered one. */
export function folderLock(dir: string, password: string | null, unlock: boolean): Promise<FolderReport> {
  return invoke<FolderReport>("folder_lock", { dir, password, unlock });
}

/** Encrypt a chosen handful of files with one passphrase — the Security Mana
 *  prompt's list. Paths that are not files in the workspace come back as
 *  failures in the report. */
export function filesLock(paths: string[], password: string): Promise<FolderReport> {
  return invoke<FolderReport>("files_lock", { paths, password });
}
