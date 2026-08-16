// Which editor opens a given file.
//
// The app has never needed this before: the tab you are in decides the editor,
// and the file is assumed to comply. A file browser inverts that — you click a
// file and the app has to work out where it goes.
//
// Extension alone cannot do it. `document` and `deck` BOTH claim `.xml`, so a
// `.xml` is genuinely ambiguous and has to be settled by looking inside. The
// sniffers already exist, written for exactly this question when each editor
// decides whether to accept what it was handed — so this reuses them rather
// than inventing a second, divergent opinion about what a document looks like.
import { sniffIsDocument } from "../formats/document";
import { sniffIsPresentation } from "../formats/presentation";
import { isSheet } from "../formats/sheet";
import type { EditorKind } from "../tabs";

/** The unambiguous extensions. `.xml` is deliberately absent. */
const BY_EXTENSION: Record<string, EditorKind> = {
  svg: "sketch",
  json: "sheet",
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The editor for a file, or null when nothing here can open it.
 *
 * `content` is optional so a listing can grey out rows before fetching
 * anything — but without it a `.xml` stays unresolved, because guessing between
 * a document and a deck would open the wrong editor half the time, and an
 * editor refusing a file it was handed is a worse experience than a row that
 * says nothing yet.
 */
export function kindForFile(name: string, content?: string): EditorKind | null {
  const ext = extensionOf(name);

  // Content first when we have it: a file's insides are what it IS, and a
  // renamed `.txt` full of deck XML should still open as a deck.
  if (content !== undefined) {
    if (isSheet(content)) return "sheet";
    if (sniffIsPresentation(content)) return "deck";
    if (sniffIsDocument(content)) return "document";
    if (ext === "svg") return "sketch"; // no sniffer; the extension is the claim
    return null;
  }

  return BY_EXTENSION[ext] ?? null;
}

/** Whether a listing row should look clickable, before anything is fetched.
 *  `.xml` counts as openable here — which of the two editors it goes to is
 *  settled once the bytes arrive. */
export function looksOpenable(name: string): boolean {
  const ext = extensionOf(name);
  return ext === "xml" || ext in BY_EXTENSION;
}
