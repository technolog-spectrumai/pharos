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
// SETTINGS IS LAST AND IS NOT AN EDITOR. It carries no file, so the host's
// save/discard machinery does not apply to it.

/** Which editor a tab drives. `text` is not a tab — it is the fallback a tab
 *  falls into when its own editor refuses a file (see EditorHost.openAsText). */
export type EditorKind = "document" | "sketch" | "sheet" | "deck";
export type AppTabId = EditorKind | "files" | "settings";

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
  { id: "document", path: "/write",         labelKey: "nav.write",         icon: "file-lines",      kind: "document" },
  { id: "sketch",   path: "/sketch",        labelKey: "nav.sketch",        icon: "pencil",          kind: "sketch" },
  { id: "sheet",    path: "/sheets",        labelKey: "nav.sheets",        icon: "table-cells",     kind: "sheet" },
  { id: "deck",     path: "/presentations", labelKey: "nav.presentations", icon: "file-powerpoint", kind: "deck" },
  { id: "files",    path: "/files",         labelKey: "nav.files",         icon: "folder-open",     kind: null },
  { id: "settings", path: "/settings",      labelKey: "nav.settings",      icon: "gear",            kind: null },
];

export const DEFAULT_TAB: AppTabId = "document";

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
  document: { untitledKey: "file.untitledDoc",   extensions: ["xml"],  filterKey: "nav.write" },
  sketch:   { untitledKey: "file.untitled",      extensions: ["svg"],  filterKey: "nav.sketch" },
  sheet:    { untitledKey: "file.untitledSheet", extensions: ["json"], filterKey: "nav.sheets" },
  // pxml FIRST: extensions[0] is what Save As defaults to. "xml" stays as a
  // second entry so the Open dialog still shows the decks already on disk.
  deck:     { untitledKey: "file.untitledDeck",  extensions: ["pxml", "xml"], filterKey: "nav.presentations" },
};
