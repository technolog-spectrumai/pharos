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
import type { EditorKind } from "../tabs";

/** What this app can open, which since the Code tab was removed is drawings.
 *
 *  The table used to route sixteen text extensions to that tab. They return
 *  null now and the Files panel says so — a drawing app claiming `.py` was
 *  never honest, and Lazurite opens those. IMAGES are not here and are not
 *  refused either: the panel routes them itself, to the viewer that survived
 *  the tab (see FilesPanel, and EditorHost's text fallback). */
const BY_EXTENSION: Record<string, EditorKind> = {
  svg: "sketch",
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
    if (ext === "svg") return "sketch"; // no sniffer; the extension is the claim
    // Fall back to the name rather than giving up: a `.pxml` whose bytes did
    // not sniff (an empty deck, say) is still a deck, and returning null here
    // would make it unopenable precisely when its content WAS available.
    const byName = byExtension(ext);
    if (byName) return byName;
    // Nothing claimed it. With the Code tab gone there is no editor to fall
    // back on, so this says so rather than opening a `.log` in a drawing
    // canvas — and the panel's "cannot open that kind of file" is a better
    // answer than an editor that refuses the file after being handed one.
    return null;
  }

  return byExtension(ext);
}

