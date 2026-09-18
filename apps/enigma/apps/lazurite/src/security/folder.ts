// Folder encryption, as the page reaches src-tauri/src/folder.rs.
import { invoke } from "../ipc";

export interface FolderPreview {
  files: number;
  plain: number;
  sealed: number;
  links: number;
  truncated: boolean;
}

export interface FolderReport {
  done: string[];
  skipped: string[];
  /** Not tried: the run stopped at a wrong passphrase. */
  untried: string[];
  failed: Array<{ path: string; error: string }>;
  links: number;
  truncated: boolean;
}


export function folderPreview(dir: string): Promise<FolderPreview> {
  return invoke<FolderPreview>("folder_preview", { dir });
}

/** `password` null means the remembered one. */
export function folderLock(dir: string, password: string | null, unlock: boolean): Promise<FolderReport> {
  return invoke<FolderReport>("folder_lock", { dir, password, unlock });
}
