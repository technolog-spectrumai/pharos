// Which editor opens a given file.
//
// The app has never needed this before: the tab you are in decides the editor,
// and the file is assumed to comply. A file browser inverts that — you click a
// file and the app has to work out where it goes.
//
// A `.pxml` deck says what it is in its name, and so does a `.svg` or a `.json`.
// A `.xml` does not: cyprian documents still use it, and every deck written
// before the `.pxml` class existed is one. So the extension decides where it
// can, and the sniffers settle `.xml`. The sniffers already exist, written for
// exactly this question when each editor decides whether to accept what it was
// handed — so this reuses them rather than inventing a second, divergent
// opinion about what a document looks like.
//
// The sniffing that survives here is LEGACY RESCUE, not the router. Deleting it
// would strand every deck already sitting on a user's disk as a `.xml`.
import { sniffIsDocument } from "../formats/document";
import { sniffIsPresentation } from "../formats/presentation";
import { isSheet } from "../formats/sheet";
import type { EditorKind } from "../tabs";

/** The unambiguous extensions. `.xml` is deliberately absent — both the writer
 *  and the deck claim it, and the sniffers settle it below.
 *
 *  `json` names CODE, not the sheet, and that is not a demotion: `isSheet` runs
 *  BEFORE this table on every path that has the bytes, so a real workbook still
 *  reaches the grid. What changes is the other JSON — a `package.json`, a
 *  `tsconfig.json` — which used to be handed to Univer and rendered as garbage
 *  because the extension was the only thing anyone asked. */
const BY_EXTENSION: Record<string, EditorKind> = {
  svg: "sketch",
  pxml: "deck",
  json: "code",
  txt: "code",
  py: "code",
  js: "code",
  mjs: "code",
  cjs: "code",
  ts: "code",
  html: "code",
  htm: "code",
  css: "code",
  md: "code",
  yml: "code",
  yaml: "code",
  sh: "code",
  tex: "code",
  sty: "code",
};

/** Own properties only. A bracket lookup on an object literal also resolves
 *  `Object.prototype`, so a file called `x.constructor` would otherwise come
 *  back as a truthy non-editor. (`hasOwnProperty.call` rather than
 *  `Object.hasOwn`, which this build's lib target does not carry.) */
function has(table: Record<string, EditorKind>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function byExtension(ext: string): EditorKind | null {
  return has(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : null;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The editor for a file. Never null: anything unrecognised opens as plain text.
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
    // Fall back to the name rather than giving up: a `.pxml` whose bytes did
    // not sniff (an empty deck, say) is still a deck, and returning null here
    // would make it unopenable precisely when its content WAS available.
    const byName = byExtension(ext);
    if (byName) return byName;
    // Nothing claimed it, so it is text until proven otherwise — an `.xml` no
    // sniffer wanted, a `.log`, a `.csv`, a file with no extension at all. The
    // Code tab opens it as plain text, and its language picker is there if the
    // guess was wrong. Refusing would be the app deciding a file is none of the
    // user's business, which it never is.
    return "code";
  }

  return byExtension(ext) ?? "code";
}

