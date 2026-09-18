// The editors this app has, and the files each one writes.
//
// There are no tabs. There used to be — Write, Presentations, Code, and for a
// while Markdown — and each one owned an editor host, so the user had to say
// what kind of file they meant before opening it. The app now works the other
// way round: a file is opened, `kindForFile` (src/files/openWith.ts) reads its
// name and bytes, and the one host mounts whichever editor that answer names.
// Security and Settings are views reached from the menu, not editor kinds.
//
// So this module is a table, not a navigation model. What it still has to
// get right is the agreement between the new-file seed, Save As's default
// extension and the Open filter — a mismatch shows up as a file the app wrote
// and then cannot reopen as what it was.

/** Which editor a file opens in. `text` is not a kind — it is the fallback a
 *  structured editor falls into when it refuses a file (EditorHost.openAsText). */
export type EditorKind = "document" | "deck" | "code" | "markdown" | "sheet" | "sketch";

export const KIND_FILES: Record<EditorKind, {
  /** i18n key for the default filename. */
  untitledKey: string;
  /** Extensions offered in Open and Save As; `[0]` is Save As's default. */
  extensions: string[];
  /** Shown as the filter's name in the native dialog. */
  filterKey: string;
}> = {
  document: { untitledKey: "file.untitledDoc",   extensions: ["xml"],  filterKey: "nav.write" },
  // pxml FIRST: extensions[0] is what Save As defaults to. "xml" stays as a
  // second entry so the Open dialog still shows the decks already on disk.
  deck:     { untitledKey: "file.untitledDeck",  extensions: ["pxml", "xml"], filterKey: "nav.presentations" },
  // `txt` first, so a new text file is born plain — the language is a choice
  // nobody has made yet, and `untitled.py` would make it for them. `xml` is
  // here for the XML that is neither a document nor a deck: the sniffers
  // decide that, and a leftover config file is source.
  code:     { untitledKey: "file.untitledText",
              extensions: ["txt", "py", "js", "mjs", "cjs", "ts", "json",
                           "html", "htm", "css", "yml", "yaml", "sh", "tex", "sty", "xml"],
              filterKey: "nav.code" },
  // Plain files on disk, nothing more: a Markdown note is a `.md` the way a
  // script is a `.py`. `md` first so a new note is born with the common name.
  markdown: { untitledKey: "file.untitledMd", extensions: ["md", "markdown"], filterKey: "nav.markdown" },
  // A Univer workbook snapshot. `.json` is shared with code on purpose: the
  // name cannot tell a workbook from a `package.json`, and `isSheet` reads the
  // bytes to decide (see openWith.ts).
  sheet:    { untitledKey: "file.untitledSheet", extensions: ["json"], filterKey: "nav.sheets" },
  // Plain SVG. The drawing engine writes ordinary elements (plus `data-en-*`
  // hints it reads back); there is no drawing format of our own.
  sketch:   { untitledKey: "file.untitled", extensions: ["svg"], filterKey: "nav.sketch" },
};

/** What New offers, in the order it offers it — the menu and the start screen
 *  read the same list, so they cannot disagree about what can be created. */
export const NEW_FILE_KINDS: ReadonlyArray<{ kind: EditorKind; labelKey: string; icon: string }> = [
  { kind: "document", labelKey: "file.newDoc",  icon: "file-lines" },
  { kind: "deck",     labelKey: "file.newDeck", icon: "file-powerpoint" },
  { kind: "sheet",    labelKey: "file.newSheet", icon: "table-cells" },
  { kind: "sketch",   labelKey: "sketch.newDrawing", icon: "pen-nib" },
  { kind: "markdown", labelKey: "file.newMd",   icon: "file-pen" },
  { kind: "code",     labelKey: "file.newText", icon: "code" },
];

/** Every extension any editor claims, once — the Open dialog's first filter. */
export const ALL_EXTENSIONS: readonly string[] =
  [...new Set(Object.values(KIND_FILES).flatMap((spec) => spec.extensions))];
