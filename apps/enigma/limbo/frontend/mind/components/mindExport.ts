// Mind map JSON export/import plumbing.
//
// Export: Tauri save dialog + direct write; blob download in the browser build
// (sketchExport.ts pattern). Import: the caller hands us a File from a hidden
// <input type="file"> — reading needs the bytes, not a path, so this works
// identically in the desktop webview and the browser dev build with no Rust
// command at all (the sketch background-image rationale).
//
// Errors are thrown as stable CODES, not prose, so the view can translate them
// like the rest of the UI.
import { writeTextFileToDisk } from "rakotis";
import { toExportFile, type MindDoc } from "./mindModel";

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Browser fallback: a blob download, since there is no dialog. */
function browserDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Save the map as pretty-printed JSON (it is a user-facing interchange file).
 *  Returns false if the user cancelled the dialog. */
export async function exportMindJson(doc: MindDoc, defaultName: string): Promise<boolean> {
  const json = JSON.stringify(toExportFile(doc), null, 2);
  if (!isTauri()) {
    browserDownload(new Blob([json], { type: "application/json" }), defaultName);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: defaultName, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return false;
  await writeTextFileToDisk(path, json);
  return true;
}

/** Read + parse a picked file. Throws "unreadable" | "not-json"; validation
 *  against the schema is the caller's job (parseImportFile), because only the
 *  caller has the caps. */
export async function readMindImportFile(file: File): Promise<unknown> {
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsText(file);
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("not-json");
  }
}
