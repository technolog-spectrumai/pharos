// The main tabs this app presents.
//
// Modelled on enigma's tabs.ts, with two deliberate differences.
//
// There are no build gates and no per-user hiding yet. Zinnia ships every
// editor, so the AND of "compiled in" and "user wants it" has nothing to
// evaluate — this is a plain list until one of those exists.
//
// And these tabs do NOT route. Enigma's are views a router mounts and unmounts;
// an office tab owns an open FILE with an unsaved buffer in it, and unmounting
// on every switch would throw that away. App.vue keeps each visited tab alive
// and toggles visibility instead, which is why there is a `path` here for
// nothing to consume yet — it is what a router would need if one arrives.
//
// SETTINGS IS LAST, AND IT IS NOT THE ONLY TAB THAT CARRIES NO FILE. A tab with
// a null `kind` hosts no editor, so the host's save/discard machinery does not
// apply to it — and `App.showFiles` keys off that same null, so it gets no files
// sidepanel either. A tab that needs to show files must bring its own listing.
//
// FILES IS NOT A TAB. It was one, and the tab is what made it useless: picking
// a file meant leaving the editor. It is a sidepanel now (src/files/FilesPanel
// .vue), on screen beside whichever editor is showing.

/** Which editor a tab drives. `text` is not a tab — it is the fallback a tab
 *  falls into when its own editor refuses a file (see EditorHost.openAsText). */
export type EditorKind = "sheet" | "code";
export type AppTabId = EditorKind | "security" | "settings";

export interface AppTab {
  id: AppTabId;
  /** Unused today; see the header. */
  path: string;
  /** The `nav.*` key. */
  labelKey: string;
  icon: string;
  /** The editor this tab hosts, or null for a tab that holds no file. */
  kind: EditorKind | null;
}

export const APP_TABS: readonly AppTab[] = [
  { id: "sheet",    path: "/sheets",        labelKey: "nav.sheets",        icon: "table-cells",     kind: "sheet" },
  { id: "code",     path: "/code",          labelKey: "nav.code",          icon: "code",            kind: "code" },
  { id: "security", path: "/security",      labelKey: "nav.security",      icon: "shield-halved",   kind: null },
  { id: "settings", path: "/settings",      labelKey: "nav.settings",      icon: "gear",            kind: null },
];

export const DEFAULT_TAB: AppTabId = "sheet";

/** What each editor kind calls a new file, and what it will save as. One place,
 *  because the new-file seed, the save dialog's filter and the "open" filter
 *  all have to agree — a mismatch shows up as a file the tab that wrote it
 *  cannot reopen. */
export const KIND_FILES: Record<EditorKind, {
  /** i18n key for the default filename. */
  untitledKey: string;
  /** Extensions this tab offers in Open and Save As. */
  extensions: string[];
  /** Shown as the filter's name in the native dialog. */
  filterKey: string;
}> = {
  sheet:    { untitledKey: "file.untitledSheet", extensions: ["json"], filterKey: "nav.sheets" },
  // `txt` first, so a new Code file is born plain text — the language is a
  // choice nobody has made yet, and `untitled.py` would make it for them. The
  // rest widen the Open dialog only.
  //
  // `xml` is here although the Files panel never routes one to this tab: the
  // panel decides from the bytes, and a deck's XML belongs to Presentations.
  // Opening that same file HERE, on purpose, to look at the source is a
  // different request — and this editor refuses nothing, so the filter can
  // afford to offer it.
  code:     { untitledKey: "file.untitledText",
              extensions: ["txt", "py", "js", "mjs", "cjs", "ts", "json",
                           "html", "htm", "css", "md", "yml", "yaml", "sh", "tex", "sty", "xml"],
              filterKey: "nav.code" },
};
