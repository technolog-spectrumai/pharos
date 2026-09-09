// The main tabs this app presents.
//
// Modelled on enigma's tabs.ts, with two deliberate differences.
//
// There is ONE build gate, and it is not evaluated here. `collab` exists only
// in a build made with the `collab` Cargo feature; App.vue asks the Rust side
// (`collabAvailable`) and hides the tab when the answer is no, because a list
// compiled into the frontend cannot know what the backend was built with.
// There is still no per-user hiding.
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

/** Which editor a tab drives.
 *
 *  ONE, and `text` is not among them: the text editor is still mounted, but as
 *  a FALLBACK rather than a tab — it shows an image, and it shows a `.svg` this
 *  app refused to parse, so "cannot edit" never means "cannot look at". See
 *  EditorHost.openAsText.
 *
 *  The Code tab was removed deliberately. This is a drawing app, and a general
 *  text editor beside the canvas invited the Files panel to route sixteen
 *  extensions into it — which made Sketch quietly the app that opens your
 *  Python. Lazurite is where text belongs. */
export type EditorKind = "sketch";
export type AppTabId = EditorKind | "collab" | "security" | "settings";

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
  { id: "sketch",   path: "/sketch",        labelKey: "nav.sketch",        icon: "pencil",          kind: "sketch" },
  { id: "collab",   path: "/collab",        labelKey: "nav.collab",        icon: "user-group",      kind: null },
  { id: "security", path: "/security",      labelKey: "nav.security",      icon: "shield-halved",   kind: null },
  { id: "settings", path: "/settings",      labelKey: "nav.settings",      icon: "gear",            kind: null },
];

export const DEFAULT_TAB: AppTabId = "sketch";

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
  sketch:   { untitledKey: "file.untitled",      extensions: ["svg"],  filterKey: "nav.sketch" },
};
