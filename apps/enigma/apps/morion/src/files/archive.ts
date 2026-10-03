// A whole workspace as one password-protected .zip, as the page reaches
// src-tauri/src/archive.rs.
//
// The page sends a password and nothing else: Rust opens the save or open
// dialog itself, so no path chosen by the page is ever written or read. Both
// answer null when the user cancelled that dialog.
import { invoke } from "../ipc";

export interface ExportReport {
  path: string;
  files: number;
  sealed: number;
  bytes: number;
  links: number;
}

export interface ImportReport {
  written: string[];
  kept: string[];
  skipped: Array<{ path: string; reason: string }>;
  tagged: number;
}

export function archiveExport(password: string): Promise<ExportReport | null> {
  return invoke<ExportReport | null>("archive_export", { password });
}

/** `password` may be empty for a zip that has none. */
export function archiveImport(password: string): Promise<ImportReport | null> {
  return invoke<ImportReport | null>("archive_import", { password });
}
