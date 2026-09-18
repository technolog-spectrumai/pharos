# Morion: the user interface

This describes what Morion shows and does, control by control, as of
2026-09-18. It covers the shell (header, ☰ menu, start screen), the workspace
and its Files sidepanel, the one workspace search, file and folder encryption
with in-memory editing of encrypted files, tags, Security Mana, the Workspace
security view, every editor, and Settings. It is written for people who will
change or test the interface, so every control carries the source file that
draws it and the `data-testid` a test would use. Where a catalogue string is
quoted, it is quoted exactly as `apps/morion/src/i18n/en.ts` (or a package's
own catalogue) spells it. The Rust side is described only as far as a user
meets it: what it refuses, what it writes, and what it never keeps.

Paths are relative to the repository root. The app is `apps/morion` and its
Rust half `apps/morion/src-tauri/src`; the shared packages it draws from are
`packages/petalite` (workspace store, file tree, select menu, modal card,
theme), `packages/rakotis` (modal, buttons), `packages/wisteria` (the drawing
engine and its toolbar) and `packages/padova` (the passphrase dialog, the
front end of the sealing commands and their error sentences; padova's own
Security view is no longer mounted in Morion). The encryption itself is the
`padova` and `substrate` crates under `crates/`.

The window and page title are "Morion" (`apps/morion/index.html:6`,
`apps/morion/src/config.ts:7`, `apps/morion/src-tauri/tauri.conf.json:15`).
The bundle identifier is still `com.spectrumaipl.zinnia`, which is why every
localStorage key below begins with `zinnia:` and why a remembered passphrase is
filed in the system keyring under that name.

The screen lives in one window that opens at 1200 by 800, resizable and not
fullscreen, titled "Morion" (`apps/morion/src-tauri/tauri.conf.json:15-20`).
The installed package and its launcher entry are still called "Zinnia"
(`productName`, `tauri.conf.json:3`), the name the app had before it became
Morion; the Linux bundles are `deb` and `rpm` (`tauri.conf.json:29-31`).

## The one-screen model

There is one screen. `apps/morion/src/App.vue` is a full-height column: a
header bar, and below it the Files sidepanel beside a content column
(`App.vue:287-537`). The content column holds one `EditorHost`
(`apps/morion/src/views/EditorHost.vue`) and, once visited, the Workspace
security and Settings views. Nothing is ever unmounted: the host, the panel
and both views are hidden with `v-show`, so a half-written document survives a
visit to Settings and a loaded folder tree survives toggling the panel
(`App.vue:516-535`). Hidden is not the same as inert by accident: App passes
the host `active` = (the editor view is on screen) (`App.vue:526`), the host
hands it to whichever editor is mounted (`EditorHost.vue:621-738`) and reads it
itself before Ctrl+O (`EditorHost.vue:566-578`). That flag is what every
shortcut marked "gated by active" in Keyboard shortcuts consults, so a
document behind Settings keeps its state but answers no keys.

Everything on this screen happens inside one workspace: an ordinary folder the
user chose, which Rust holds as the boundary for every file operation
(`apps/morion/src-tauri/src/workspace.rs`). Rust resolves each path it is
handed against that folder and refuses, before it reads or writes anything, a
path that climbs out with `..`, an absolute path elsewhere, a path with a
symbolic link anywhere in it, or anything inside a folder named `.morion`,
Morion's own metadata folder, at any depth (`workspace.rs:109-186`). The page
never decides what is inside: every listing, read, write, encryption, search,
tag and Mana charge is a Rust command against the one open workspace
(`apps/morion/src/files/fs.ts:1-11`, `apps/morion/src/main.ts:39-41`).
Morion's own metadata (tags and the Mana ledger) lives inside the workspace
in a hidden `.morion/` folder. Choosing a workspace, the recent list,
reopening at launch and the full boundary rules are under Workspaces.

The host reads the same store as the Files panel, the ☰ menu's Workspace
section, the start screen and the Workspace security view (`App.vue:81-85`,
`EditorHost.vue:66-70`). With no workspace open on the desktop, Open… and Save
As… are greyed in the menu (`App.vue:273-283`), the start screen's Open… is
disabled (`StartView.vue:70`), and the keyboard's Ctrl+O sets the header error
to "Choose a workspace folder first." (`workspace.errors.no_workspace`,
`EditorHost.vue:452-455`); a Save As that gets that far says the same
(`EditorHost.vue:522-525`). New needs no workspace, although the new file's
first Save does, since it falls through to Save As. The browser build needs
none at all: it keeps its file-input and download fallback. The Open dialog
opens on the workspace root and Save As offers `<root>/<name>` for a
never-saved file (`EditorHost.vue:460, 528`).

There are no editor tabs. The file decides the editor. When a file is opened,
`kindForFile` (`apps/morion/src/files/openWith.ts:81-104`) reads its name and
bytes and the host mounts whichever editor that answer names. An encrypted
file is no exception: Rust decrypts it into memory first and the plaintext is
routed the same way, so an encrypted note opens in the Markdown editor, an
encrypted deck in Presentations and an encrypted picture in the image viewer
(`EditorHost.vue:209-219`; see Encryption). The only time the user names an
editor is New, which passes the kind explicitly. With no file open the host
shows the start screen instead of any editor; there is no default untitled
document. Nothing closes a file: once one is open, only another open replaces
it: New, Open, a row clicked in the Files panel, or a search hit
(`EditorHost.vue:400-412, 594-596`; `App.vue:132-142`).

Two views can stand in front of the editor, and neither is an editor: Settings,
behind the ☰ menu, and Workspace security, behind the shield in the Files
sidepanel's header (`App.vue:70-72, 522`). Choosing one puts that view in front
of the editor; the × next to the view title in the header, New, Open, Save or
Save As, or choosing or switching the workspace from the menu brings the editor
back (`App.vue:199-209, 251-263, 421`). An editor's export command (CSV, PNG)
does not: it runs without changing the view (`App.vue:225-241`).

`kindForFile` runs these steps in order and never returns null
(`openWith.ts:81-104`). Called without content, which nothing in the app does
today, it answers by extension alone and `code` for anything unlisted, so a
bare `.xml` name is `code`; the `?? "code"` fallback in `EditorHost.vue:401` is
unreachable. With content:

1. If the first 2048 characters, after stripping the XML prolog, comments and
   DOCTYPE and trimming leading whitespace, open with a `<presentation` tag,
   the kind is `deck`. The test is case-insensitive and the tag name must end
   there (followed by whitespace, `/` or `>`), so `<PRESENTATION>` and
   `< presentation>` count and `<presentations>` does not. The name is ignored
   (`apps/morion/src/formats/presentation.ts:410-415`).
2. Same test for a `<document` tag, with the same delimiter and case rules,
   giving `document` (`apps/morion/src/formats/document.ts:319-326`).
3. If the text parses as JSON to a non-array object whose `sheets` is a
   non-array object and which has a `sheetOrder` key, the kind is `sheet`,
   whatever the extension (`apps/morion/src/formats/sheet.ts:71-82`).
4. Otherwise the lower-cased extension is looked up in a table
   (`openWith.ts:30-53`). The extension is whatever follows the last dot,
   lower-cased, so `notes.tar.gz` is a `gz` (code), `README` has none (code),
   a file named just `.md` is Markdown, and `NOTES.MD` is Markdown too; a name
   ending in a prototype property such as `x.constructor` is not a hit
   (`openWith.ts:59-70`). `.xml` is deliberately absent from the table: a
   document or deck is recognised by its root element only, and any other
   `.xml` falls through.
5. Anything left opens as `code`, the plain-text editor with its language
   picker: a `.log`, a `.csv`, a file with no extension, an `.xml` no sniffer
   wanted.

The complete file to editor table (`apps/morion/src/kinds.ts`,
`openWith.ts`, `EditorHost.vue:92-103`):

| Kind | Extensions (Save As filter name, `[0]` is the default) | Content sniff | Editor | What New creates | Default name |
|---|---|---|---|---|---|
| `document` | `xml` ("Write") | root element `<document>` | Write, `apps/morion/src/editors/DocumentEditor.vue` | "New document": `dumps(newDocument(""))`: one empty paragraph, empty title, font `serif`, margins `normal`, no contents page, no cover (`document.ts:61-70`) | `untitled.xml` |
| `deck` | `pxml`, `xml` ("Presentations") | root element `<presentation>` | Presentations, `apps/morion/src/editors/PresentationEditor.vue` | "New presentation": `dumpsDeck(newPresentation(""))`: one untitled slide, title-content layout, one empty text block, theme `black`, font `sans` (`presentation.ts:184-194`) | `untitled-deck.pxml` |
| `sheet` | `json` ("Sheets") | JSON with `sheets` object and `sheetOrder` | Sheet, `apps/morion/src/editors/SheetEditor.vue` | "New spreadsheet": `newWorkbook("untitled-sheet")`, one sheet "Sheet1", 100 rows by 26 columns | `untitled-sheet.json` |
| `sketch` | `svg` ("Drawing") | none by extension; the editor itself refuses unsafe SVG | Drawing, `apps/morion/src/editors/SketchEditor.vue` | "New drawing": empty text, which the editor opens as a blank 1920 by 1080 board | `untitled.svg` |
| `markdown` | `md`, `markdown` ("Markdown") | none | Markdown face of `apps/morion/src/editors/TextEditor.vue` (undo/redo strip, no picker) | "New Markdown note": empty text | `untitled.md` |
| `code` | `txt`, `py`, `js`, `mjs`, `cjs`, `ts`, `json`, `html`, `htm`, `css`, `yml`, `yaml`, `sh`, `tex`, `sty`, `xml` ("Code") | none; the fallback for everything unclaimed | Code face of `TextEditor.vue` (undo/redo strip and language picker) | "New text": empty text | `untitled.txt` |
| `text` (not a kind) | keeps the file's own name and filter | reached only by "Open as plain text" after a refusal | bare `TextEditor.vue` (no strip, no picker) | not offered by New | unchanged |

The filter names and default names are catalogue strings (`file.untitled*`,
`nav.*`; `EditorHost.vue:94, 437`). In Polish they read `bez-nazwy.xml`,
`bez-nazwy-prezentacja.pxml`, `bez-nazwy-arkusz.json`, `bez-nazwy.svg`,
`bez-nazwy.md`, `bez-nazwy.txt` and the filters "Pisanie", "Prezentacje",
"Arkusze", "Rysunek", "Markdown", "Kod" (`apps/morion/src/i18n/pl.ts:9-14,
200-216`); a new spreadsheet's workbook name is the localised file name minus
its extension, so `bez-nazwy-arkusz` in Polish (`EditorHost.vue:100`).

Three consequences worth knowing. A `package.json` opens in the Code editor,
because `json` names code in the table and only a real workbook passes step 3.
A `.txt` whose bytes begin with `<presentation` opens as a deck. An empty file
is routed by its name alone, because nothing sniffs: an empty `.pxml` opens as
a fresh one-slide deck (`presentation.ts:266-268`) and an empty `.svg` as a
blank board, but an empty `.xml` opens in the Code editor, not in Write, since
`.xml` is not in the table (`openWith.ts:86-104`). To start a Write document,
use New.

Every open remounts the editor: the host keys it by a generation counter
(`EditorHost.vue:125-128, 411`), so undo history never carries from one file to
the next. Save does not remount, and neither does encrypting or decrypting the
open file.

Whatever an editor draws is bounded by the window's content-security policy
(`tauri.conf.json:23`): a file's own HTML or SVG cannot embed an iframe or
plugin, load a script, fetch anything, or show an image that is not inline
`data:`/`blob:` or an app asset. The dev build relaxes this only for the Vite
server and inline scripts (`tauri.conf.json:24`).

## The header

The header is `App.vue:289-514`, a shrink-to-fit bar that wraps on narrow
widths. Left to right:

| Control | Label, tooltip | `data-testid` | What it does | When shown | Source |
|---|---|---|---|---|---|
| ☰ button (icon `bars`) | native tooltip is the brand name "Morion"; aria-label "Menu" (`nav.menu`) | `app-menu` | Toggles the app menu panel. `aria-haspopup="menu"`, `aria-expanded` mirrors the open state. | Always | `App.vue:295-302`; `config.ts:7` (the same `brand.name` is the window and page title, `index.html:6`) |
| Folder button (icon `folder-open`) | "Files panel" (`files.toggle`), `aria-pressed` | `files-toggle` | Toggles the Files sidepanel and writes `zinnia:files`. Filled with the accent colour when on, outlined when off. The panel is only visible in the editor view, but the toggle still flips and persists from Workspace security or Settings. The start screen's "Search the workspace" also switches it on (`App.vue:185-189`), so the button can turn filled without being clicked. | Always | `App.vue:401-411, 78-79, 87` |
| View title (icon + "Workspace security" or "Settings", bold, truncated) | `security.workspace.title` / `nav.settings`; icons `shield-halved` and `gear` | `view-title` | Read-only name of the view standing in front of the editor. | Only while Workspace security or Settings is up | `App.vue:415-417, 65-68` |
| × button (icon `xmark`) | "Close" (`common.close`) | `view-close` | Returns to the editor view, and so to the open file or the start screen. | Only while a view is up | `App.vue:418-423` |
| File name (bold, truncated) | none | `file-name` | The open file's name, for example `email.txt`. Updated on every open, on New, and by Save As to the picked path's basename. "Open as plain text" does not rename. | Editor view with a file open | `App.vue:425-426`; `EditorHost.vue:405, 534` |
| "•" | "Unsaved changes" (`file.unsavedTitle`) | none | The unsaved dot. Appears beside the name while the host's `dirty` flag is set, which the mounted editor drives through `update:dirty`; cleared by a successful save and by every open or New. | Editor view, file open, buffer dirty | `App.vue:427`; `EditorHost.vue:133, 408, 499, 518` |
| File shield (icon `shield-halved`, a 28px square) | tooltip "Encrypted" (`shield.statusSealedShort`) or "Not encrypted" (`shield.statusPlain`); aria-label "Encryption" (`shield.title`); `aria-haspopup="dialog"`, `aria-expanded`; `data-sealed` is "1" or "0" | `file-shield` | Toggles the shield panel described below. Filled with the accent colour while the open file is encrypted, outlined while it is plain. | Editor view with a file open, saved or not | `App.vue:432-443` |
| Tags button (icon `tag`, then "No tags" at 50% opacity or up to three chips; at most 16rem wide) | tooltip and aria-label "Tags" (`tags.title`) | `file-tags`; each chip `file-tag-{i}`, 0-based | Opens the tag dialog (see Tags). | Editor view, and only for a file that has a path on disk: never for a new, unsaved file, and never in the browser build | `App.vue:477-485` |
| Spacer | | | | | `App.vue:490` |
| Notice (small, 60% opacity) | today only "Saved" (`file.saved`) | none | Set after a successful write or a browser download; cleared when Save starts or a file is opened or created. Save As from the menu and Open do not clear it first, so a stale "Saved" can outlive a cancelled Save As. Editing does not clear it, so "Saved" can sit beside a fresh dot. | Editor view, notice non-empty | `App.vue:492`; `EditorHost.vue:410, 500, 519, 543` |
| File error (small, warn colour, truncated) | "Could not open the file. <sentence>" (`file.openFailed`), "Could not save. <sentence>" (`file.saveFailed`), "Choose a workspace folder first." (`workspace.errors.no_workspace`) when Open… or Save As… runs without a workspace, "Not saved: the file is encrypted and its passphrase was not given." (`shield.saveCancelled`) when the passphrase asked for at Save was not given, or the bare sentence of a permanent decrypt that failed from the file shield | `file-error` | The host's last file error. `<sentence>` is Rust's refusal put through the catalogue (see Opening, saving and discarding). Cleared at the start of Open, Save, an encrypted open, Encrypt and Decrypt, and on any open or New; Save As from the menu does not clear it first, a new failure overwrites it. While an editor is mounted the same text is also handed to it, which draws it as a warn strip above its body. | Editor view, error non-empty | `App.vue:493-495`; `EditorHost.vue:277, 288, 311, 337, 351, 409, 447, 453, 472, 491, 503, 523, 542` |
| Export error (small, warn colour, truncated) | "Could not export. <reason>" (`file.exportFailed`), the reason being the error's own text, not a catalogue sentence | `export-error` | Set when an export command throws past its editor, which today means a CSV write that failed (a refused or full location). Nothing is charged. Cleared at the start of the next export and whenever another file is put on screen: App watches the host's `generation`, which every open, New and "Open as plain text" bumps, so reopening a file of the same name clears it too, while a Save As rename leaves it (`App.vue:243-246`; `EditorHost.vue:128, 379, 411`). The drawing's PNG export catches its own failures and shows them in the editor instead, so it never reaches this line. | Editor view, non-empty | `App.vue:225-246, 496-498` |
| Locale button (text "PL" or "EN") | none | none | Shows the language you would switch TO ("PL" while English). Flips en and pl through `setLocale`, which sets the vue-i18n locale, `<html lang>` and `zinnia:locale`. The write is try/caught, so with storage blocked the switch still takes effect for the session and is simply not remembered (`packages/petalite/src/i18n/index.ts:54-58`). | Always | `App.vue:41-43, 500-503`; `packages/petalite/src/i18n/index.ts:51-59` |
| Dark toggle (icon `moon` while dark, `sun` while light) | "Dark mode" (`nav.themeDark`) while dark, "Light mode" (`nav.themeLight`) while light | `dark-toggle` | Shows the CURRENT mode. Toggles the `.dark` class on `<html>` and writes `zinnia:dark`. | Always | `App.vue:31-39, 507-513` |

The header also mounts two dialogs that draw nothing in the bar: the one Mana
confirmation (`ManaConfirm`) and the tag dialog (`TagModal`, present only
while the open file has a path). Both are teleported to `<body>` when they open
(`App.vue:486-488`).

### The file shield

The shield says whether the OPEN file is encrypted and offers the one thing
that can be done about it. Its state is the host's own `isSealed`: true while
the host holds a Rust session for the open file, shows an encrypted picture
from memory, or knows the file was encrypted on disk while it was open and has
not yet been saved back through its passphrase (`EditorHost.vue:146-154`). The
host does not watch the disk, but the Files panel tells it after every
successful row shield action and every folder run, and it then asks Rust about
the open file again (`resync`, `EditorHost.vue:221-240`; `App.vue:522`), so the
shield follows those changes (see Encryption).

The panel (`App.vue:445-473`, `data-testid="file-shield-panel"`,
`role="dialog"`, 18rem wide) opens below the shield over a transparent
full-window backdrop that closes it on click (`App.vue:444`). Escape closes it
while focus is inside the shield's wrapper (`App.vue:432`), which it is right
after the shield was clicked; focus is not moved into the panel. It also
closes when either button is pressed and whenever the open file's name changes,
that is on every open, New or Save As rename (`App.vue:147-148`). Top to
bottom:

| Element | Text | Key | `data-testid` | Notes |
|---|---|---|---|---|
| Title (icon `lock` while encrypted, `lock-open` while plain) | "Encryption" | `shield.title` | none | |
| Status | "Not encrypted"; for an encrypted file "Encrypted on disk. It is decrypted in memory only; saving writes it back encrypted."; for an encrypted picture "Encrypted on disk. Shown from memory; nothing is written." | `shield.statusPlain`, `shield.statusSealed`, `shield.statusSealedImage` | `file-shield-status` | `App.vue:452-454` |
| Encrypt button (icon `lock`) | "Encrypt with a passphrase…" | `shield.encrypt` | `file-shield-encrypt` | Only while the file is plain. Closes the panel and runs `encryptFile` (see Encryption). `App.vue:456-461, 159-162` |
| Decrypt button (icon `lock-open`) | "Decrypt permanently…" | `shield.decrypt` | `file-shield-decrypt` | Only while the file is encrypted. Closes the panel and runs `decryptFile`. `App.vue:462-467, 163-166` |
| Blocker line | "Save the file first." while the file has never been saved (no path), else "Save your changes first." while it has unsaved changes | `shield.saveFirst`, `shield.cleanFirst` | `file-shield-blocker` | While it shows, the button above is disabled. The button is also disabled, with no line, while a Save is in flight. In the browser build a file never has a path, so Encrypt is always blocked there. `App.vue:151-157, 468` |
| Limits (under a rule, 11px) | "Encryption protects the contents of a file. Its name, its folder, its size and dates, and any tags stay visible." | `shield.limits` | `file-shield-limits` | `App.vue:470-472` |

### Tags in the header

The chips are read from Rust (`tags_get`) whenever the open file's path
changes, including Save As to a new path, and replaced by whatever the tag
dialog saved; off the desktop nothing is read, and a failed read shows no
chips (`App.vue:171-182, 488`). Switching the workspace does not change the
path, so the chips of a file left open from the previous workspace stay as they
were read.

With the panel open and a dirty `email.txt` opened from the Files panel, the
left of the bar reads: ☰, the filled folder button, "email.txt •", the outlined
shield, and a tags button reading "No tags".

Four header states:

* Editor view, no file: ☰, folder button, locale and dark buttons; the content
  column shows the start screen. If Open… (menu, start screen or Ctrl+O) fails,
  the `file-error` line still appears here: `openFile()` sets the error whether
  or not a file is open (`EditorHost.vue:471-473`) and the notice and error
  lines are not gated on a file (`App.vue:492-495`), and since no editor is
  mounted the header is the only place it shows.
* Editor view, file open: name and dot, then the shield and, for a file on
  disk, the tags button; notice, file error and export error on the right when
  present.
* Editor view, file open, Open… failed after a save: "Saved" and "Could not
  open the file. <sentence>" sit side by side, because `openFile()` clears only
  the error (`EditorHost.vue:447`) and the notice is cleared only by a
  successful open or the next Save (`EditorHost.vue:410, 543`).
* Workspace security or Settings up: the view title and × replace the name,
  the shield and the tags; the notice, the file error and the export error are
  suppressed by the `view === 'editor'` guard; the Files panel is hidden.

Dark mode: when `zinnia:dark` is absent the initial value follows the OS
(`matchMedia("(prefers-color-scheme: dark)")`), and when `matchMedia` is
unavailable the default is dark (`App.vue:31-35`). The watcher is immediate, so
the key is written at startup. Locale: read at startup from `zinnia:locale`;
absent, unsupported, or unreadable storage falls back to `navigator.language`
starting with "pl", else "en" (`packages/petalite/src/i18n/index.ts:31-41`; the
app only supplies the key and the catalogues,
`apps/morion/src/i18n/index.ts:17-33`). A key missing from the Polish
catalogue renders its English text (`fallbackLocale: "en"`,
`packages/petalite/src/i18n/index.ts:47`). At startup the stored locale reaches
vue-i18n but `<html lang>` stays at the `"en"` of `index.html` until the PL/EN
button is pressed.

## The ☰ menu

The panel (`App.vue:305-398`, `data-testid="app-menu-panel"`, `role="menu"`,
14rem wide) opens below the ☰ button over a fixed full-window backdrop
(`App.vue:304`). It closes on a backdrop click, on Escape while focus is inside
the menu wrapper (`App.vue:294`), and after any command is chosen; unfolding
Workspace or New is not a command and leaves it open. Disabled items are drawn
at 40% opacity; New, Open, Save and Save As also lose their hover tint while
disabled (`App.vue:352, 372`), whereas a disabled export entry keeps it
(`App.vue:381`).

While the menu is open the backdrop sits above everything but the ☰ button
(`App.vue:296, 304`), so a click on the folder button, the file shield, the
PL/EN or dark toggles, the Files panel or the editor only closes the menu; it
does not also press what was clicked. A second click on ☰ closes it through the
button. Every row is a `role="menuitem"` button, and the Workspace and New
parents carry `aria-expanded` (`App.vue:311-313, 350-353`). Opening the menu
moves focus nowhere and there is no arrow-key navigation or focus trap: rows
are reached with Tab like ordinary buttons, and the only key the menu answers
is Escape. No row shows a shortcut hint, although Open… has Ctrl+O. The rows
under the two parents are indented (`pl-9`) and slightly shorter (`py-1.5`,
`App.vue:327, 337, 362`).

Top to bottom, with Workspace and New unfolded, the menu reads:

| Item | Icon | Catalogue key | `data-testid` | Disabled when | What it does | Source |
|---|---|---|---|---|---|---|
| "Workspace" and, at 60% opacity, the folder's base name or "No workspace open" | `folder`; chevron right (folded) or down (unfolded) | `workspace.title`, `workspace.none` | `menu-workspace` (the row), `menu-workspace-name` (the name) | never | Toggles the Workspace fold-out in place. It re-folds whenever the menu closes (`App.vue:197`). | `App.vue:311-322` |
| Full path line (11px, 50% opacity, truncated, tooltip the path) | | | `menu-workspace-path` | | The open folder's canonical path. Only while a folder is open. | `App.vue:324-325` |
| "Choose a folder…" while none is open, "Change folder…" while one is | `folder-open` | `workspace.pick` / `workspace.change` | `menu-workspace-pick` | never | Closes the menu, shows the editor view, then `workspace.pickRoot()`: the native folder picker (see Workspaces). | `App.vue:199-203, 326-331` |
| "Recent" caption (10px, uppercase), then one row per recent folder by base name, tooltip the full path | `clock-rotate-left` | `workspace.recent` | `menu-workspace-recent-{i}`, 0-based | never | The recent list (six kept) minus the folder that is open now; caption and rows are absent when that leaves none. A click closes the menu, shows the editor view and switches to that folder through `workspace.switchRoot(path)`, with no dialog. A folder that has gone is refused and the current workspace stays; the refusal shows only in the Files panel. | `App.vue:85, 205-209, 332-341` |
| Hint (11px, 60% opacity, not indented) | | `workspace.hint` | `menu-workspace-hint` | | "A workspace is an ordinary folder on this computer. Morion works on the files inside it and nowhere else: nothing is imported, copied or uploaded." | `App.vue:342-344` |
| (rule) | | | | | Always drawn under the Workspace section, folded or not. | `App.vue:346` |
| New ▾ | `file-circle-plus`; chevron right (folded) or down (unfolded) | `file.new` | `menu-new` | the host is busy | Toggles the New fold-out in place. The fold-out re-folds every time the menu closes (`App.vue:197`). | `App.vue:350-358` |
| New document | `file-lines` | `file.newDoc` | `menu-new-document` | never on its own (only the parent greys out) | `runNew('document')`: closes the menu, shows the editor view, seeds `untitled.xml`. Discard prompt first if dirty. | `App.vue:258-263, 359-368`; `kinds.ts:54` |
| New presentation | `file-powerpoint` | `file.newDeck` | `menu-new-deck` | never | `runNew('deck')`, `untitled-deck.pxml` | `kinds.ts:55` |
| New spreadsheet | `table-cells` | `file.newSheet` | `menu-new-sheet` | never | `runNew('sheet')`, `untitled-sheet.json` | `kinds.ts:56` |
| New drawing | `pen-nib` | `sketch.newDrawing` (wisteria catalogue, `packages/wisteria/src/i18n/index.ts:107`) | `menu-new-sketch` | never | `runNew('sketch')`, `untitled.svg` | `kinds.ts:57` |
| New Markdown note | `file-pen` | `file.newMd` | `menu-new-markdown` | never | `runNew('markdown')`, `untitled.md` | `kinds.ts:58` |
| New text | `code` | `file.newText` | `menu-new-code` | never | `runNew('code')`, `untitled.txt` | `kinds.ts:59` |
| Open… | `folder-open` | `file.open` | `menu-open` | the host is busy; on the desktop, also while no workspace is open | Closes the menu, shows the editor view, `host.openFile()`. | `App.vue:212, 251-256, 281` |
| Save | `floppy-disk` | `file.save` | `menu-save` | unless `host.canSave` | `host.saveFile()`: writes to the file's path, or falls through to Save As for a never-saved file. | `App.vue:213, 279` |
| Save As… | `file-pen` | `file.saveAs` | `menu-saveAs` | the host is busy, no file is open, or (desktop) no workspace is open | `host.saveAs()`. | `App.vue:214, 280` |
| (rule) | | | | | Drawn only above the first export entry, as its top border. | `App.vue:382` |
| Export entries | per editor | per editor | `menu-export` for the first, `menu-export-{i}` for later ones | the host is busy | Closes the menu and runs the mounted editor's export through `runExport`, without changing the view. From an encrypted file the Mana confirmation comes first and the charge follows only if a file was written (see Security Mana). A failure the editor did not catch itself appears in the header as "Could not export. <reason>". | `App.vue:220, 225-241, 379-388` |
| (rule) | | | | | Divides the file commands from Settings. | `App.vue:390` |
| Settings | `gear` | `nav.settings` | `menu-settings` | never | Closes the menu, mounts `SettingsView` on first visit, shows it in front of the editor. | `App.vue:70-72, 265-268, 391-397` |

There is no Security row any more. Workspace security is about the folder, not
the app, so it is reached from the shield in the Files sidepanel's header
(`App.vue:9-12, 70-72`; `FilesPanel.vue:240-245`).

`isDisabled` (`App.vue:273-283`) decides New, Open, Save and Save As.
Everything is greyed while there is no host or the host is busy; then Save
follows `canSave`, Save As needs an open file and a workspace, and Open needs a
workspace. The workspace rule applies only on the desktop: the browser build
has no workspace and needs none, because it opens through a file input and
saves by download (`isTauri`, `App.vue:27, 276-278`), so there Open… is always
available and Save As… needs only an open file. The New fold-out's six rows
carry no `:disabled` of their own; only the New parent greys out while busy
(`App.vue:353, 360-367`). "No host" is a guard, not a state you can reach: the
host is mounted once with the app and only ever hidden (`App.vue:126-127,
526`), so in practice the rows grey out for busy, `canSave`, an open file and
the workspace alone.

`busy` is the host's save-in-flight flag (`EditorHost.vue:130, 539-551`): it
is set only by Save, and for a never-saved file it stays set while the native
Save As dialog that Save falls through to is open. Save As… chosen from the
menu does not set it, and neither does encrypting, decrypting or opening an
encrypted file. The drawing's PNG export keeps its own busy flag
(`SketchEditor.vue:125, 159`) that the menu does not show, so a second "Export
as PNG" while one is rendering looks enabled, writes nothing and answers that
nothing was written.

`canSave` is `hasFile && !busy && !readOnly && (dirty || path === null)`
(`EditorHost.vue:562-563`). So a brand-new untitled file has Save enabled at
once, an already-saved file only once it has changed, and an opened image,
plain or encrypted, never. Save As looks enabled for an opened image, because
`isDisabled` only checks for a file and a workspace, but `saveAs()` returns
false without doing anything (`EditorHost.vue:509`).

Export entries exist only while an editor that offers them is mounted
(`EditorHost.vue:584-586` reads `exports` off the editor):

| Editor | Entry | Icon | Key | Source |
|---|---|---|---|---|
| Sheet | "Export sheet as CSV…" | `file-csv` | `sheet.exportCsv` | `SheetEditor.vue:274` |
| Drawing | "Export as PNG" | `file-image` | `sketch.exportPng` | `SketchEditor.vue:254` |

Each export's `run` answers whether it wrote a file: `true` after a written
file (or a browser download), `false` for a cancelled save dialog, a failure it
caught itself, or nothing to export (`SheetEditor.vue:228-259`,
`SketchEditor.vue:155-174`; the type is `App.vue:92-93`). The menu uses that
answer only to decide whether an export from an encrypted file is charged. It
shows nothing on success, and it catches a failure the editor let through (in
practice a CSV write that failed): the header's `export-error` line then reads
"Could not export." (`file.exportFailed`) and the error's own text, and nothing
is charged (`App.vue:225-246`). "Export as PNG" is the one dialog-opening
command written without the trailing "…" the others carry
(`packages/wisteria/src/i18n/index.ts:93`). The entry is exposed by the editor
component, not by a successful parse, so it is still listed and enabled while
the Sheet or Drawing editor is showing its refusal panel; choosing it then
writes nothing (`SheetEditor.vue:229-231` finds no snapshot,
`SketchEditor.vue:158-159` finds no session), after the Mana confirmation if
the file is encrypted, and nothing is charged. A sheet whose grid failed to
start still exports, from the snapshot it read. Once "Open as plain text" has
remounted the file in the bare text editor the entry is gone.

With the header's PL/EN button on Polish the same rows read Obszar roboczy
("Nie otwarto obszaru roboczego" while none is open), Wybierz folder… or Zmień
folder…, Ostatnie, Nowy, Nowy dokument, Nowa prezentacja, Nowy arkusz, Nowy
rysunek, Nowa notatka Markdown, Nowy tekst, Otwórz…, Zapisz, Zapisz jako…,
Eksportuj arkusz jako CSV…, Eksportuj jako PNG, Ustawienia
(`apps/morion/src/i18n/pl.ts:15, 112, 198-214, 228-232`;
`packages/wisteria/src/i18n/index.ts:192, 206`).

The Write, Presentations, Markdown, Code and bare text editors offer none, so
nothing appears between Save As… and the rule. In particular PDF export is not
wired: `en.ts` carries the `pdf.*` strings and `apps/morion/src/pdf/` can
build a document, but `DocumentEditor.vue` exposes no `exports`
(`DocumentEditor.vue:287-298`) and nothing outside `src/pdf/` imports it. The
"Export as PDF…" and "Export slides as PDF…" strings never reach the menu.
Likewise `file.newDrawing` ("New", `en.ts:210`) is a leftover the New drawing
row does not use, and wisteria's "Export as SVG" (`sketch.exportSvg`,
`packages/wisteria/src/i18n/index.ts:91`) and "Open as XML instead"
(`sketch.openAsXml`, `:106`) are rendered nowhere in this app: there is no SVG
export entry because Save already writes the drawing as plain SVG.

Every file command (New, Open, Save, Save As) first switches back to the editor
view (`App.vue:251-263`), so Open from Settings means "open a file", not "open
one out of sight". An export entry does not: it runs where it is
(`App.vue:225-241`), so "Export sheet as CSV…" or "Export as PNG" chosen from
Workspace security or Settings still opens the native save dialog and writes
the file, while the drawing's "Saved." notice or error line lands in the
editor's strip behind the view, and a CSV failure's "Could not export." line
waits in the header until the editor view is back (`App.vue:496`), unseen until
the × is pressed.

## The start screen

`apps/morion/src/views/StartView.vue:30-88`, rendered by
`EditorHost.vue:615-617` whenever no file is open (`kind === null`) and the
editor view is on screen. A centred column, `max-w-md`, root
`data-testid="start"`, centred vertically and horizontally inside 24px padding;
the region scrolls if the window is shorter than the column
(`StartView.vue:31-32`). Outlined buttons tint on hover
(`hover:bg-accent-light/10`), Open… dims to 90% (`:72`), and kind-button icons
sit at 70% opacity (`:63`). Top to bottom:

| Control | Text | Key | `data-testid` | Does | Disabled when | Source |
|---|---|---|---|---|---|---|
| Heading and hint | "Morion", "Open a file, start a new one, or find a note." | `brand.name` (`config.ts:7`, a constant, not an i18n key: it does not change with the PL/EN toggle), `start.hint` | none | static | | `StartView.vue:34-35` |
| Workspace card (bordered) | caption "Workspace" (small, uppercase); the folder's base name in bold (tooltip the full path) or "No workspace open"; the `workspace.hint` sentence "A workspace is an ordinary folder on this computer. Morion works on the files inside it and nowhere else: nothing is imported, copied or uploaded."; a small button "Choose a folder…" or "Change folder…" (icon `folder-open`) | `workspace.title`, `workspace.none`, `workspace.hint`, `workspace.pick`, `workspace.change` | `start-workspace` (card), `start-workspace-name` (folder set), `start-workspace-none` (no folder), `start-workspace-pick` (button) | The button emits `pickWorkspace`, which the host answers with `workspace.pickRoot()`: the same native folder picker as the menu and the Files panel. The card comes first because Open and Save have nowhere to look without a workspace. | never | `StartView.vue:40-53`; `EditorHost.vue:617` |
| Section caption | "New" (small, uppercase) | `file.new` | none | labels the grid | | `StartView.vue:56` |
| Six kind buttons, 2-column grid in `NEW_FILE_KINDS` order | "New document", "New presentation" / "New spreadsheet", "New drawing" / "New Markdown note", "New text", each with its icon | `file.newDoc`, `file.newDeck`, `file.newSheet`, `sketch.newDrawing`, `file.newMd`, `file.newText` | `start-new-document`, `start-new-deck`, `start-new-sheet`, `start-new-sketch`, `start-new-markdown`, `start-new-code` | `emit('new', kind)`, then `EditorHost.newFile(kind)`: seeds an untitled file of that kind and mounts its editor. No workspace is needed. | busy | `StartView.vue:57-66`; `kinds.ts:53-60` |
| "Open…" (accent-filled, bold, icon `folder-open`) | | `file.open` | `start-open` | `EditorHost.openFile()`: the native dialog on the workspace under Tauri, a hidden file input in a browser | busy; on the desktop, also while no workspace is open | `StartView.vue:70-77` |
| "Search the workspace" (outlined, icon `magnifying-glass`) | | `start.searchNotes` | `start-search` | `App.startSearch()`: forces the Files panel open (if it was collapsed, `zinnia:files` becomes "1") and focuses its workspace search box | never | `StartView.vue:78-84`; relayed by `EditorHost.vue:58-62, 616`; `App.vue:185-189, 527` |

Open… is disabled for a reason you can see: on the desktop with no workspace
open it stays greyed (`busy || (isTauri && !workspace)`, `StartView.vue:70`)
until a folder is chosen in the card above it. In the browser build it is never
greyed for that reason, since the browser opens through a file input. While
busy the kind buttons and Open… would sit at 40% opacity, but that state is
unreachable here: `busy` is only ever set by `saveFile`
(`EditorHost.vue:539-551`), which refuses to run without an open file, and an
open file means the start screen is no longer mounted. The `:disabled="busy"`
wiring is defensive.

Neither the kind buttons nor Open… can raise the discard prompt from here. Both
go through `confirmDiscard` (`EditorHost.vue:416, 446`), but with no file open
there is no editor to mark anything dirty, so the prompt resolves silently and
the new or opened file appears at once.

Cancelling the Open dialog leaves the start screen exactly as it was
(`EditorHost.vue:461`). If the picked file cannot be read, the start screen
also stays, and "Could not open the file. <sentence>" (`file.openFailed`,
`en.ts:221`) appears in the header's `file-error` slot (`App.vue:493-495`, see
The header); no editor is mounted. The error is cleared on the next Open…
(`EditorHost.vue:447`). A file Rust reports as encrypted goes to the passphrase
dialog instead (see Encryption); cancelling that also leaves the start screen.

If no folder has been chosen yet, or the remembered folder is currently
unreadable (the `files-unreadable` state), "Search the workspace" opens the
panel but focuses nothing: the search box is only rendered in the panel's
tree branch (`FilesPanel.vue:288-336`), so `focusSearch()` (`:201-206`) finds
nothing to focus. `App.startSearch` waits one tick after opening the panel
before trying (`App.vue:185-189`).

There is no way back to this screen. `fileKind` is set only by `show`
(`EditorHost.vue:403`) and nothing ever clears it, and the menu has no Close
command, so the start screen is seen once per session: the first New or Open
replaces it with an editor for good. Switching the workspace does not bring it
back either. To "start over" the user opens or creates another file.

## Workspaces

A workspace is an ordinary folder on this computer, chosen by the user.
Morion reads and writes the files inside it and nowhere else; nothing is
imported, copied or uploaded (`workspace.hint`, shown in the ☰ menu and on the
start screen). There is exactly one at a time. The page keeps its path in
petalite's store (`packages/petalite/src/files/useWorkspace.ts`), one singleton
read by the menu, the start screen, the Files panel, the search box, the host
and the Workspace security view; Rust keeps the same folder, canonicalised, as
the boundary every command checks (`WorkspaceState`,
`apps/morion/src-tauri/src/workspace.rs:38-54`). Rust holds it in process
memory only; the page's copy in `zinnia:workspace` is what survives a restart.

### Choosing one

Four controls open the same native folder picker, `workspace.pickRoot()`
(`useWorkspace.ts:272-288`): the ☰ menu's "Choose a folder…" or "Change
folder…" (`menu-workspace-pick`), the start screen card's button
(`start-workspace-pick`), the Files panel's "Choose a folder" (`files-pick`,
shown while there is no folder or it is unreadable) and the panel header's
"Change folder" (`files-change`). The picker is `@tauri-apps/plugin-dialog`'s
`open({ directory: true, multiple: false, recursive: true })`. Cancelling it
changes nothing except clearing any pending error text. Off the desktop there
is no picker: the store's error becomes "This needs the desktop app."
(`files.desktopOnly`), which only the Files panel shows.

A picked folder, or a row of the recent list, goes through `switchRoot(path)`
(`useWorkspace.ts:294-314`):

1. Rust's `workspace_open` canonicalises it (`workspace.rs`, `open_root`) and
   refuses a folder it cannot open ("cannot_open: cannot open that folder:
   <OS reason>") or a path that is not a folder ("cannot_open: that is not a
   folder"). A refusal leaves the current workspace exactly as it was and puts
   Rust's text in the store's `error`; the Files panel shows it as the
   sentence "That folder cannot be opened. It may have been moved or
   deleted." (`workspace.errors.cannot_open`; `files-error` while a folder is
   open, `files-pick-error` while none is), and nothing else on screen does.
2. Otherwise the canonical spelling becomes the root (a folder reached through
   a symbolic link is kept as the real folder it points at), the tree, its
   expanded folders and the padlock cache are emptied, the path is written to
   `zinnia:workspace` and put at the front of the recent list, and the root is
   read afresh.

Opening a workspace replaces the one Rust holds, so from then on anything
under the previous folder is refused as outside the workspace. Picking the
folder that is already open simply re-reads it, collapsed. Switching does not
close the open file or ask the discard question: the buffer stays in its
editor, but its path now lies outside the workspace, so Save answers "Could not
save. That path is outside the workspace.", the same for an encrypted file's
session. Save As can still put it into the new workspace. The Files panel's
search box is emptied, the Workspace security view reloads for the new folder,
and the Mana meters become the new folder's (see Security Mana).

### The recent list

`zinnia:workspaces:recent` holds the folders that have been the workspace,
most recent first, at most six, no duplicates (`useWorkspace.ts:107-112,
183-201`). Only a successful switch is added. The ☰ menu's Workspace fold-out
lists them minus the folder open now, by base name with the full path as the
tooltip (`App.vue:85, 332-341`), and a click switches through `switchRoot`
without a dialog. Nothing removes an entry: a folder deleted since stays listed
until newer folders push it off the end, and choosing it is refused as in
step 1.

### Reopening at launch

The store reads `zinnia:workspace` when it loads (`useWorkspace.ts:111,
164-173`). The Files panel is mounted at startup whether or not it is shown,
and it calls `refresh()` as soon as it sees a root with no rows
(`FilesPanel.vue:61-63`). The first refresh hands the path to Rust
(`workspace_open`) before reading anything (`useWorkspace.ts:381-392`), so the
remembered workspace comes back after a restart without a dialog; if Rust
answers a different canonical spelling, the store and `zinnia:workspace` take
it. If Rust refuses (the folder was moved, deleted, or is no longer a folder),
the panel shows "Can’t read this folder." with the picker. The store keeps the
path meanwhile, so the menu and the start screen still name the folder and
Open… stays enabled, but Rust holds no workspace, so any file command answers
"Choose a workspace folder first." until a folder is chosen. No file is
reopened: the app always starts on the start screen.

### The boundary

Every command resolves the path it is handed against the canonical root
(`resolve`, `workspace.rs:109-186`), applying these rules in this order, which
is also the order the comment above `resolve` lists them in:

1. no `..` anywhere: "outside_workspace: that path climbs out of the
   workspace", refused before the disk is looked at;
2. it must lie under the root; an absolute path elsewhere is refused
   ("outside_workspace: that path is not inside the workspace"), including a
   sibling whose name merely starts with the root's; a path spelled through a
   symbolic-linked spelling of the workspace folder itself is accepted in its
   canonical form;
3. nothing inside a folder named `.morion`, at any depth, the folder itself
   included: "metadata: that is Morion's own metadata folder". That is this
   workspace's metadata at the root, and a nested workspace's further down. A
   folder whose name merely starts with `.morion`, such as `.morion-notes`,
   is ordinary (`workspace.rs:119-122, 168-170`);
4. no component under the root may be a symbolic link, whatever it points at:
   "symlink: Morion does not follow symbolic links";
5. every component must exist, except the last one of a file about to be
   written: "not_found: no such file in the workspace: <relative path>".

Beyond resolving:

* Reads, as text or as bytes, refuse a folder ("not_found: that is a folder,
  not a file"), a file over 64 MB ("too_large: that file is too big to open
  here") and an encrypted file ("locked: that file is encrypted"), which opens
  only through the encrypted path. Text must be valid UTF-8 ("not_text: that
  file is not a text file"); it is never decoded lossily
  (`workspace.rs:239-263`).
* A write creates the file if it does not exist, but never a missing folder,
  and never writes plaintext over an encrypted file ("locked: that file is
  encrypted on disk; save it through its passphrase", `workspace.rs:268-277`).
  Every write, plain or encrypted, goes through a sibling temporary
  `<name>.zlock.tmp` that is flushed and renamed over the target, so a failed
  write leaves the file as it was (`crates/substrate/src/lib.rs:175-194`).
* A listing leaves out symbolic links and any entry named `.morion`, in
  every folder and not only at the root, puts folders first and compares names
  case-insensitively (`workspace.rs:197-237`).
* With no workspace open, every command answers "no_workspace: choose a
  workspace folder first" (`workspace.rs:47-53`).

The same resolution guards the encryption commands (`lock.rs:15-17`), in-memory
editing (`sealed.rs:81, 94, 110`), folder runs (`folder.rs:113, 130`), tags
(`meta.rs:111-117`) and the Mana ledger (`mana.rs:164-170`). The search and
folder runs walk down from their starting folder, never follow a link and never
enter a folder named `.morion`, at any depth (`folder.rs:72-110`). So a
`.morion` folder anywhere in the workspace is neither listed nor walked, and
no path into it is accepted. The sentences the app shows for these refusals are
listed under Opening, saving and discarding.

### `.morion/`

Each workspace carries Morion's own metadata at its root:
`.morion/metadata.json`, a small, pretty-printed JSON file holding the tags
and the Security Mana ledger in plain text (`meta.rs:1-16, 49-56`). It is
created the first time a tag is saved or a Mana charge or event is recorded,
and written atomically. The folder is hidden from the tree, the search, folder
encryption and the Workspace security counts, and every command that takes a
path refuses anything inside it, as it does inside any other folder of that
name further down (rule 3 above): picked in the Open dialog,
`.morion/metadata.json` gives "Could not open the file. That is Morion’s
own metadata folder." (`workspace.errors.metadata`), and Save As into it gives
"Could not save. That is Morion’s own metadata folder.". Only Rust's own
metadata code writes there (`meta.rs:64-85`). A file there that does not parse
is refused rather than overwritten, so a stray edit cannot erase every tag.
What it may and may never contain is under What is remembered.

## The files sidepanel

`apps/morion/src/files/FilesPanel.vue:222-355`, rendered from
`App.vue:520-522`. A 16rem-wide `<aside data-testid="files-panel">` mounted
once beside the content column and hidden with `v-show` when `filesOpen` is off
or a view stands in front of the editor (`App.vue:87`). It shows the workspace
as a lazily expanded tree with the one workspace search above it, and a shield
at the right of every row. It hands files to the host to open and cannot save,
rename or delete anything. The one thing it changes on disk is encryption: each
file row's shield encrypts or permanently decrypts that file, and each folder
row's shield opens the folder dialog (both described under Encryption). After a
row shield's action succeeds, and after every folder run, the panel emits
`security-changed` and App has the host ask Rust again about the file it holds
open, so the header's shield and the next save follow the disk
(`FilesPanel.vue:146, 179, 197`; `App.vue:522`).

### Header

| Control | Text, tooltip | Key | `data-testid` | Does | Shown | Source |
|---|---|---|---|---|---|---|
| Folder name (uppercase, truncated) | base name of the workspace, or "Files"; tooltip is the full path, or "Files" | `nav.files` | `files-root` | nothing | always | `FilesPanel.vue:227-230` |
| Refresh (icon `rotate-right`, spinning `spinner` while loading) | "Refresh" | `files.refresh` | `files-refresh` | Drops every cached listing, re-reads the root and every expanded folder in order of path length, so a folder is always read after its parent. An expanded folder that can no longer be read is silently collapsed. If the root fails, the panel switches to the unreadable state. The padlocks come back with the listings. | only while a folder is set and readable; disabled while loading | `FilesPanel.vue:231-237`; `packages/petalite/src/files/useWorkspace.ts:375-417` |
| Workspace security (icon `shield-halved`) | "Workspace security" | `security.workspace.open` | `files-security` | Emits `security`; App puts the Workspace security view in front of the editor, which hides this panel (`App.vue:522`). This is the only way to that view. | only while a folder is set and readable | `FilesPanel.vue:240-245` |
| Change folder (icon `folder-open`) | "Change folder" | `files.changeWorkspace` | `files-change` | `workspace.pickRoot()`: the native folder picker, then `switchRoot` (see Workspaces). | always | `FilesPanel.vue:246-251` |

### States

| State | `data-testid` | What shows | Source |
|---|---|---|---|
| No folder chosen | `files-empty` | Centred faded `folder-open` icon, "No workspace yet." (`files.noWorkspace`), and the accent-filled button "Choose a folder" (`files.pickWorkspace`, `files-pick`). Header reads "Files"; Refresh and the security shield hidden. No search box, no tree. | `FilesPanel.vue:263-278` |
| Folder remembered but unreadable | `files-empty` and `files-unreadable` | Shown when Rust refuses to open or list the remembered folder at launch or on Refresh (deleted, renamed, not a folder). "Can’t read this folder." (`files.unreadable`), the remembered path in 10px faded text, "Choose it again to let Morion read it." (`files.unreadableHint`), and "Choose a folder". The Rust reason is kept in the store's `error` but not displayed in this branch. Header shows the folder's base name; Refresh and the security shield hidden; expanded folders forgotten. Only Choose a folder and Change folder lead out. | `FilesPanel.vue:263-286`; `useWorkspace.ts:406-413` |
| Pick error | `files-pick-error` | Under the button, only in the no-folder branch (not the unreadable one): "This needs the desktop app." (`files.desktopOnly`) off Tauri, or, for a picked folder Rust refuses, "That folder cannot be opened. It may have been moved or deleted." (`workspace.errors.cannot_open`). While a folder is open the same refusal appears as `files-error` instead and the current folder stays. | `FilesPanel.vue:282-285`; `useWorkspace.ts:273-276, 301-304` |
| Tree with folder | `files-tree` | The search box, an optional error line, then the scrollable tree. On first mount with a remembered folder and no rows the panel calls `refresh()` itself; that is what reopens the remembered workspace at launch. | `FilesPanel.vue:61-63, 288-336` |
| Searching | none | While the search box holds text the tree is hidden and the results stand in its place; emptying the box brings the tree back exactly as it was (see Search). | `FilesPanel.vue:52, 291-292, 302` |
| Loading | none | During a Refresh the tree area is empty (cached listings are dropped before the re-read) and `files-nothing` is suppressed; the only sign is the Refresh icon spinning at 25% opacity. | `FilesPanel.vue:231-237, 331`; `useWorkspace.ts:377-379` |
| Error line | `files-error` | Warn-coloured line under the search box with the store's error, as its sentence when Rust's prefix has one (`workspace.errors.*`, through `shown` in `FilesPanel.vue`) and verbatim otherwise: a sub-folder that could not be read (it stays collapsed), or a folder switch Rust refused while a folder was open, whether from a picker or from the ☰ menu's Recent list. Cleared by Refresh, by a successful switch, or by expanding a folder that has not been read yet; collapsing a folder or reopening a cached one leaves it. It stays visible while searching. | `FilesPanel.vue:294-296`; `useWorkspace.ts:301-304, 378, 433-439` |
| Nothing to list | `files-nothing` | "Nothing here." (`files.emptyFolder`), centred and faded, when the tree has no rows and is not loading. | `FilesPanel.vue:331-334` |
| Open error | `files-open-error` | Warn line pinned at the panel's bottom with a top border, in any state. Rust's refusal of a clicked file or hit as its sentence (`workspace.errors.*`, as the host's Open… shows them): "That file is not a text file." (not UTF-8), "That file is too big to open here." (over 64 MB), "That file is not in the workspace.", or "That file is encrypted." for a file encrypted by something else since its row was listed; a message without a known prefix shows as it came (`FilesPanel.vue:101-105`). A row shield's decrypt that failed with the remembered passphrase shows a sentence here too, from `workspace.errors.*` or `lock.errors.*`. "Morion cannot open that kind of file." (`files.cannotOpen`) is unreachable, since the router never answers null when it has the bytes. Cleared when the next open or shield action starts. | `FilesPanel.vue:74-109, 128-159, 186-190, 217-219, 338-341` |
| Busy | none | While a clicked plain file is being read every tree row is disabled with no visual change (no `disabled:` style, no spinner); the search box, its hits, Refresh, the security shield and Change folder stay usable, so a second file can be requested through a search hit. | `FilesPanel.vue:53, 84, 107, 305` |

In a browser build with `zinnia:workspace` set, `refresh()` is a no-op
(`useWorkspace.ts:376`), so the tree branch appears with "Nothing here." and
working-looking Refresh, security shield and Change folder buttons; Change
folder answers "This needs the desktop app." in `files-error`, and every search
ends in "Nothing in the workspace matches.". The catalogue's
`files.pickWorkspaceHint` ("Pick a folder to work in. Morion will be able to
read that folder and nothing else on this machine.", `en.ts:28`) is rendered
nowhere; the sentence users see about what a workspace is comes from
`workspace.hint` in the ☰ menu and on the start screen.

### Tree rows

The tree is `packages/petalite/src/components/FileTree.vue:72-107`, one
`<button>` per entry, folders first then files. Indent is
`depth × 0.75rem + 0.5rem`. Each row's `data-testid` is `files-row-{name}`, the
bare NAME, not the path, so two same-named files in different folders share an
id (`FileTree.vue:82`); the shields' ids follow the same rule. The listing
comes from Rust and never contains symbolic links or an entry named
`.morion` (`workspace.rs:197-237`); a link cannot be expanded or opened from
here because Rust refuses it. Rust sorts case-insensitively, then the store
re-sorts each group with `localeCompare` (`useWorkspace.ts:318-333`), which is
the order shown.

* Folder row: a `chevron-right` that rotates 90° when expanded, a folder icon
  in the accent colour, the name, and at the right edge the folder shield
  (`folder-shield-{name}`): a 10px `shield-halved` at 40% opacity, full on
  hover, title and aria-label "Encrypt or decrypt this folder"
  (`folder.shield`). A click on the shield, or Enter while it has focus, opens
  the folder dialog for that folder and does not toggle the row
  (`FilesPanel.vue:308-314`). A click anywhere else on the row toggles it. The
  first expand reads the folder; the listing is cached until Refresh, so
  collapse and reopen is instant.
* File row: a blank spacer, then a `file` icon at 40% opacity, or a `lock`
  padlock at 70% when the file is encrypted; the name; the size via
  `formatSize` ("0 B", "512 B", "1.5 KB", "12.0 MB"; one decimal from KB up,
  units to TB; a file Rust could not stat also reads "0 B", because Rust then
  sends no size and `formatSize` counts that as zero,
  `packages/petalite/src/files/format.ts:7-13`); and at the right edge the row
  shield (`row-shield-{name}`): a 10px `shield-halved` at 40% opacity for a
  plain file, titled "Encrypt this file" (`shield.rowEncrypt`), or a `lock` in
  the accent colour for an encrypted one, titled "Decrypt this file
  permanently" (`shield.rowDecrypt`), the title doubling as aria-label. A click
  on it, or Enter while it has focus, runs it without opening the row
  (`FilesPanel.vue:315-326`).
* The name's hover title is the name, or "{name} — encrypted — opens with a
  passphrase" (`files.encryptedRow`) for an encrypted file
  (`FilesPanel.vue:211-213`).
* The last opened row is bold in the accent colour. It is set when a plain
  file's read succeeds, or at once when an encrypted row or hit is handed to
  the host, before any passphrase is typed and whether or not the open then
  succeeds. It is keyed by path, so it survives Refresh, and a failed plain
  read keeps the previous one. The panel is never told what the host opened by
  other means, so after Open…, New or Save As the bold row can name a file that
  is no longer the one in the header. Change folder leaves it set, but no row
  of the new tree matches it (`FilesPanel.vue:57, 78, 99, 305`).

The padlock comes with the listing: `workspace_list` reads each file's first
bytes in Rust and returns `sealed` on the row (`workspace.rs:227`), and
`probeAll` copies those answers into the cache in one step
(`useWorkspace.ts:340-348`), so the padlock appears together with the row. The
`is_file_locked` probe (`setSealProbe`, `main.ts:38`) is asked only for a path
the listing did not answer for: a search hit that was never listed
(`FilesPanel.vue:114-117`), and a file just encrypted or decrypted by a shield
(`reprobe`, `useWorkspace.ts:472-476`). Answers are cached by path; Refresh
refreshes them from the new listings, a workspace switch empties the cache
(`useWorkspace.ts:309`). Off Tauri the probe answers false, so the browser
build never shows padlocks.

What a click on a file does (`FilesPanel.vue:65-109`). A plain file's `open`
event is handled by `App.openFromFiles` (`App.vue:132-135`), which switches to
the editor view first, then calls `EditorHost.openLocal`; an encrypted one goes
out as `open-sealed` to `App.openSealedFromFiles` (`App.vue:139-142`) instead.

| File | Action |
|---|---|
| Encrypted (padlock) | Nothing is read here. The row is emitted as `open-sealed`; the host asks the discard question if the buffer is dirty, then decrypts the file into memory with the remembered passphrase (after the Mana confirmation) or through the passphrase dialog (`EditorHost.openSealed`, `EditorHost.vue:275-303`; see Encryption). Any kind opens: text in the editor its plaintext calls for, a picture in the image viewer. The open-error line is cleared. |
| Picture (`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico`, `avif`; `.svg` is deliberately not a picture, `packages/petalite/src/files/images.ts:14-33`) | Case-insensitive; a name that is only an extension, such as `.png`, is not treated as a picture and opens as text. Bytes are read through Rust (`workspace_read_bytes`, `files/fs.ts:73-78`) and turned into a `data:` URI; kind forced to `code`. The text editor shows an `<img>` instead of a buffer and the host treats the file as read-only. |
| Anything else | `workspace_read_text` (`files/fs.ts:69-71`), which refuses a file that is not UTF-8 (`not_text`), larger than 64 MB (`too_large`), encrypted on disk (`locked`, only if it was encrypted after the listing), reached through a symbolic link, or outside the workspace, instead of decoding it; then the host re-routes with `kindForFile(name, content)` and opens it WITH its path (`App.vue:132-135`, `EditorHost.openLocal`), so Save writes back to the same file. The panel computes a kind itself, but the host ignores it. |

There is NO discard prompt for a plain file on this path: opening a row or a
search hit goes through `openLocal` straight to `show()`, and unsaved changes
in the current buffer are silently replaced (`EditorHost.vue:594-596`). An
encrypted row or hit is the exception, since `openSealed` asks first
(`EditorHost.vue:276`).

There are no keyboard handlers in the panel beyond Enter on a shield. Rows are
native buttons, so Tab moves between them and Enter or Space activates one;
there is no arrow-key or type-ahead navigation. Each shield is a focusable
`<span role="button" tabindex="0">` inside its row, reached with Tab after the
row, and answers Enter only; Space on it does nothing. With focus in the search
box, Ctrl+O is ignored (`EditorHost.vue:572-573`).

### Remembering open and closed

`zinnia:files` holds "1" or "0"; anything other than "0" counts as open, so the
default is open (`App.vue:78-79`). Written on every toggle and forced on by the
start screen's "Search the workspace". The workspace path and the recent list
are described under Workspaces. The tree's expansion state is not persisted,
but it survives toggling the panel and visiting a view, because the panel is
never unmounted. The store is one singleton: the panel, the ☰ menu's Workspace
section (`App.vue:81-85`), the start screen's card (`EditorHost.vue:615`), the
search box, the Workspace security view and the host's `hasWorkspace` gate on
Open… and Save As (`EditorHost.vue:66-70`) all read it, so changing the folder
here changes what Open… defaults to and what the menu names.

## Search

One search box covers the whole workspace:
`apps/morion/src/files/WorkspaceSearch.vue:128-161`, mounted at the top of the
Files panel by `FilesPanel.vue:291-292`, above the error line and the tree, and
only while a folder is set and readable. It replaced both the old name filter
over loaded rows and the notes search. The block is
`data-testid="workspace-search-panel"`, with a rule under it.

The box is an `<input type="search">` with placeholder and aria-label "Search
the workspace…" (`search.placeholder`), `data-testid="workspace-search"`
(`WorkspaceSearch.vue:130-132`).

* It asks 200 ms after the last keystroke, with the text trimmed. An empty or
  whitespace query clears the results at once, and a sequence number drops any
  answer still in flight for an older question; the Rust walk itself is not
  interrupted (`WorkspaceSearch.vue:38, 59-96`).
* From the first character the tree is hidden and the results stand in its
  place: the box tells the panel on every change whether it holds text
  (`update:active`, `:84`; `FilesPanel.vue:52, 302`). Emptying the box brings
  the tree back exactly as it was. The panel's error line stays visible above
  the results.
* The same text is asked again when the algorithm changes in Settings (`:106`),
  whenever the padlock cache is replaced (any folder read, Refresh included, a
  shield's re-probe, or a workspace switch, `:110`), and after a folder run
  (`FilesPanel.vue:194-198`), so a line read from a body that has since been
  encrypted does not stay on screen.
* The query and results are cleared when the workspace changes (`:100-103`).
  They are kept while the panel is merely hidden (toggle, Workspace security,
  Settings), since the panel is mounted once, and lost when the folder becomes
  unreadable, since the box lives in the tree branch; a pending debounce is
  then cancelled (`:112-115`).
* Nothing is persisted, and results live only in the list on screen.
* The start screen's "Search the workspace" opens the panel and focuses the box
  (`App.vue:185-189`; `FilesPanel.vue:201-206`).

### What Rust does

Each search is one Rust command, `workspace_search(query, mode)`
(`apps/morion/src-tauri/src/search.rs:226-229`), which walks the workspace
afresh every time and keeps nothing between calls: no index, no cache, no
background work. The walk is the one folder encryption uses
(`folder.rs:72-110`): every regular file under the root, breadth first, each
folder's entries in bytewise name order (so capitals sort before lower case);
symbolic links are never followed or listed; any entry named `.morion` is
skipped; dotfiles and dotfolders are included; folders deeper than 32 levels
are not entered; and the walk stops after 20,000 files, with no sign of it on
screen. For every file walked, in every mode, Rust reads the first 16 bytes to
tell whether it is encrypted (`search.rs:197`;
`crates/substrate/src/lib.rs:134-156`). Tags come from
`.morion/metadata.json`, read once per search; a damaged metadata file means
no tags, not an error (`search.rs:191`).

A file matches on any of these, compared lower-cased against the trimmed,
lower-cased query (`search.rs:127-183`):

| Match | Test | Score | Badge (`search.by.*`) |
|---|---|---|---|
| name | the stem (the name minus its last extension, when that leaves something) equals the query | 100 | "name" |
| name | the stem starts with the query | 80 | "name" |
| name | the whole name contains the query | 60 | "name" |
| tag | one of the file's tags equals the query | 70 | "tag" |
| tag | one of its tags contains the query (the best tag counts, once) | 50 | "tag" |
| path | the path relative to the root contains the query; checked only when the name did not match | 40 | "path" |
| text | a line of the body contains the query; Full text and Hybrid only, text files only, never an encrypted file | 20, plus 2 for each further matching line, up to 5 more | "text" |

Scores add up across matches. The body is read only for a file whose name has
a stem and one of these extensions: `md`, `markdown`, `txt`, `json`, `xml`,
`pxml`, `svg`, `csv`, `py`, `js`, `mjs`, `cjs`, `ts`, `html`, `htm`, `css`,
`yml`, `yaml`, `sh`, `tex`, `sty`, `toml`, `ini`, `cfg`, `conf`, `rs`, `log`
(`search.rs:49-52`). Only the first 1 MiB is read, as lossy UTF-8, and the
snippet is the first matching line, trimmed and cut to 120 characters. A body
that cannot be read (deleted mid-walk) is not an error: the file can still
match by name, tag or path.

An encrypted file's body is never read, in any mode, and no passphrase is ever
asked for a search. It matches by name, tag and path only, carries `sealed` in
its hit, and is drawn with a padlock and no snippet (`search.rs:24-27,
168-177`). Encrypting a file therefore removes its body from the very next
search, because nothing from an earlier search was kept.

### The three algorithms

Chosen in Settings → Search algorithm and kept in `zinnia:searchMode`; Hybrid
is the default (`apps/morion/src/files/searchSettings.ts:7-34`).

| Setting | Mode | Matches on | Order | At most |
|---|---|---|---|---|
| "Quick" | `quick` | name, tag, path; never a body | walk order | 50: the walk stops at the 50th hit |
| "Full text" | `full` | name, tag, path, and the text of plain text files | walk order | 50: the walk stops at the 50th hit |
| "Hybrid" | `hybrid` | the same as Full text | by score, highest first; ties by relative path | 50: every file is scored, then the top 50 are kept |

(`search.rs:15-22, 41, 186-222`.) There is no "more results" indicator when the
cap is reached. Quick's note in Settings says it "Never reads what is inside a
file": it never reads a body, although, like the other two, it reads each
file's first 16 bytes to tell whether the file is encrypted.

### Results

| What | `data-testid` | Shows |
|---|---|---|
| Idle | none | The box alone, the tree below it. |
| Waiting | none | No spinner. From the first character the tree is hidden; until the first answer arrives nothing stands in its place, and after that the previous list stays until the new answer lands. A previous error line disappears as soon as a new search starts (`WorkspaceSearch.vue:67`). An answer or failure for a query since superseded is dropped without touching the list or the error. |
| Results list | `workspace-search-results` (the `<ul>`, capped at 60% of the window height and scrolling); each hit's `<button>`, inside a bare `<li>`, is `search-result-{i}`, 0-based | Per hit: a `lock` (encrypted) or `file` icon; the file name, bold and truncated; a small badge, `search-matched-{i}`, naming how it matched in the order name, tag, path, text, joined by " · " ("name", "tag", "path", "text", shown in capitals by CSS; Polish "nazwa", "tag", "ścieżka", "tekst"); the relative path in 10px when it differs from the name; the file's tags as small chips; and the snippet, `search-snippet-{i}`, in 11px at 70% opacity when there is one. The button's tooltip is the relative path. |
| No matches | `workspace-search-empty` | "Nothing in the workspace matches." (`files.searchNoHits`), centred and faded, when a search finished with no hits and no error. |
| Error | `workspace-search-error` | "Search failed." (`files.searchFailed`), a space, and the sentence for Rust's prefix (for example "Search failed. Choose a workspace folder first."), or Rust's text verbatim when the prefix has none. The list is cleared. |

Clicking a hit emits `open`; `FilesPanel.openHit` first asks the probe about
that path if the padlock cache has no answer for it (a hit may sit in a folder
the tree never expanded), then opens it exactly like a clicked row
(`FilesPanel.vue:114-117`): an encrypted hit goes to the passphrase flow, a
picture to the preview, anything else is read and routed through `kindForFile`.
A plain hit replaces the buffer without the discard prompt, as a row does. A
hit that opens becomes the tree's active row, which shows once the query is
cleared and only if its folder is expanded; the tree is not expanded to reveal
it. Hits are not disabled while a file is being read: clicking another hit
during a read starts a second read, and whichever finishes last is the file
left open.

Keyboard: the input has no handler beyond the debounce, so Enter does nothing
more. Hits are ordinary buttons: Tab moves into the list and Enter or Space
opens the focused hit; there is no arrow-key navigation and no shortcut that
opens the first hit. Whatever the webview offers to empty a `type="search"`
field (its clear button, Escape) goes through the same empty-query path as
deleting the text.

The browser build's `searchWorkspace` answers `[]` without calling Rust
(`apps/morion/src/files/search.ts:28-31`), so any query ends in "Nothing in
the workspace matches.".

## Opening, saving and discarding

The host (`EditorHost.vue`) owns the one open file: its path, name, content,
dirty flag, the busy, notice and error strings, and, while the file is
encrypted, the token of the Rust session that holds its key
(`EditorHost.vue:118-157`). Each editor owns only its buffer and implements
`markSaved` / `getContent` / `isDirty`
(`apps/morion/src/editors/types.ts:11-34`). The host binds `path`, `name`,
`content`, `busy`, `error` and `active` into whichever editor is mounted
(`types.ts:11-19`; `EditorHost.vue:621-738`) and listens for `save` (with the
serialised buffer), `update:dirty` and `open-as-text` (`types.ts:29-34`). The
Code, Markdown and bare text faces never emit `open-as-text`: plain text has
nothing to refuse (`TextEditor.vue:46-49`). No editor knows whether its file is
encrypted: the host decrypts before it mounts one and re-encrypts when it
saves.

Every read and write here goes through Rust and its workspace boundary (see
Workspaces): `workspace_read_text`, `workspace_read_bytes` and
`workspace_write_text` for a plain file
(`apps/morion/src/files/fs.ts:69-82`), `sealed_open`, `sealed_open_bytes` and
`sealed_write` for an encrypted one
(`apps/morion/src/security/sealed.ts:18-34`). The native dialogs only choose
a path; whether it may be read or written is Rust's answer. The same holds for
the two editor dialogs that bring a file's contents in: the Write editor's
Insert a table → "Load file…" and the Presentations block editor's "Import from
file…" open their dialog in the workspace root and read the pick through
`workspace_read_text` or `workspace_read_bytes`, so a file outside the
workspace or an encrypted one is refused there with its sentence
(`CsvTableModal.vue:85-105`; `PresentationEditor.vue:167-203`). The fs plugin
stays only for what is meant to leave the workspace: the CSV and PNG exports
write through it wherever their save dialog points.

### Open

Open… from the menu, the start screen's Open…, and Ctrl+O all call `openFile()`
(`EditorHost.vue:445-474`). The discard prompt comes first; only once it is
passed is the header's file error cleared, and that happens before the dialog
opens (`:446-447`), so cancelling the dialog still wipes a previous "Could not
open the file." or "Could not save.". Cancelling the discard prompt leaves the
error in place. Without a workspace nothing opens: the error reads "Choose a
workspace folder first." (`:452-455`); the menu and the start screen grey their
Open… in that case, so only Ctrl+O gets this far. Under Tauri the dialog is the
native single-file dialog, opened on the workspace root (`:460`), with two
filters:

| Filter | Extensions |
|---|---|
| "Supported files" (`file.supported`) | every extension in `ALL_EXTENSIONS`, that is the union of the kinds table in table order: `xml`, `pxml`, `txt`, `py`, `js`, `mjs`, `cjs`, `ts`, `json`, `html`, `htm`, `css`, `yml`, `yaml`, `sh`, `tex`, `sty`, `md`, `markdown`, `svg` |
| "All" (hard-coded literal) | `*` |

The dialog can wander anywhere; a file picked outside the workspace is refused
by Rust ("Could not open the file. That path is outside the workspace."), not
by the dialog. The picked file is read through Rust (`workspace_read_text`) and
routed by `kindForFile`. A file Rust reports as encrypted (`locked`) is handed
to `openSealed` instead (`:463-470`), which decrypts it into memory after the
passphrase or the remembered one (see Encryption); the discard question already
answered is not asked again (`openSealed(…, true)`, `:469`; `:275-276`). A file
inside a folder named `.morion`, at any depth, is refused with "Could not
open the file. That is Morion’s own metadata folder.". The name shown in the
header is the picked path's last `/`-separated segment (`:462`, and `:534` for
Save As); nothing splits on backslashes. Cancel returns silently. A refusal or
a thrown error sets the header's `file-error` to "Could not open the file.
<sentence>" (`:471-473`). Plain pictures are not in the "Supported files"
filter, and one picked through "All" is refused as `not_text` ("That file is
not a text file."), so a plain picture reaches the editor only from the Files
panel or a search hit. An encrypted picture picked there does open, because it
goes the encrypted way and is decrypted to bytes.

### Save and Save As

`saveFile()` (`EditorHost.vue:539-551`) is a no-op when busy, when no file is
open, or when the file is a picture. It sets busy, clears the error and the
notice, then writes the buffer to the file's path through `writeTo`
(`:486-506`): a plain file through `workspace_write_text`, an encrypted one
through `sealed_write` with its session token, which re-encrypts it in Rust
(`:496-497`; see Encryption). A file that was encrypted on disk while it was
open, by its row shield or a folder run, first gets its key back: the
remembered passphrase is tried silently, otherwise the passphrase dialog asks
for it; cancelling that dialog writes nothing, and the header's error line says
"Not saved: the file is encrypted and its passphrase was not given."
(`shield.saveCancelled`; `:488-493`; `adoptSessionForSave`, `:242-266`). The
buffer is the text the editor's own Ctrl+S emitted with `save` (every editor
emits its serialised content, `EditorHost.vue:632-736`), or, for Save from the
menu, `editor.getContent()`; the last fallback is the content the file was
opened with (`:545`). A file whose path is null (never saved) falls through to
`saveAs()`, which ignores the emitted text and re-reads `getContent()` itself
(`:510`). On success the editor's `markSaved()` runs, the dot clears and the
notice reads "Saved". On failure the header shows "Could not save. <sentence>"
and the same text appears as a warn strip inside the editor.

While Save is in flight `busy` is true (`EditorHost.vue:540-550`), and for a
never-saved file that covers the whole time the Save As dialog is open. During
it New, Open…, Save, Save As… and the export entries are greyed in the menu
(`App.vue:273-283, 384`), the file shield's buttons are disabled
(`App.vue:459, 465`), the start screen's kind buttons and Open… would sit at
40% (`StartView.vue:59, 70`), and every editor's Ctrl+S is ignored. `canSave`
is also false, so Save cannot be triggered twice.

`saveAs()` (`EditorHost.vue:508-537`) refuses when no file is open or the file
is a picture. Under Tauri it also refuses without a workspace (the header
error, `:522-525`), then opens the native save dialog with `defaultPath` the
file's own path, or `<workspace root>/<name>` for a never-saved file (`:528`),
and two filters: the open kind's own name and extensions (see the kinds table;
`[0]` is the default), then "All". The buffer is written to the picked path;
only on a successful write do the path and the header name change to the picked
path and its basename (`:531-535`), so a failed write leaves the old target in
place and shows "Could not save. <sentence>". A path outside the workspace is
refused like any other write. Cancel returns false with no change. Save As does
not remount the editor. A file forced to plain text keeps the ORIGINAL kind's
filter, since `openAsText` (`EditorHost.vue:377-380`) never touches `fileKind`
and `saveFilters()` (`:434-440`) reads it. For an encrypted file Save As writes
an encrypted copy under the same key, onto any other path, existing or not, and
from then on the session edits the copy (see Encryption). Tags are filed by
path, so the copy starts with none, and the header's tags follow it.

Save As from the menu calls `saveAs()` directly (`App.vue:214`), which, unlike
Save, neither sets busy nor clears the error and the notice, and `writeTo()`
only sets "Saved" on success without clearing the error
(`EditorHost.vue:486-506`). So after a failed Save, a successful Save As shows
"Saved" and the old "Could not save. <sentence>" side by side until the next
Save, Open or New. Because busy stays false, the menu and the editors' Ctrl+S
remain live while the Save As dialog is open.

Files opened from the Files panel or a search hit arrive with their path
(`openLocal`, `EditorHost.vue:594-596`), so Save writes them back in place
without a dialog; Rust's workspace boundary is what permits the write.

### What the refusals say

The host turns a Rust refusal into a sentence through its prefix: first the
workspace catalogue, then the encryption catalogue, and anything else (an
operating-system message such as a permission error) is shown as it came
(`explain`, `EditorHost.vue:74-78`; `fs.ts:18-37`;
`packages/padova/src/lock.ts:22-41`). These sentences follow "Could not open
the file." or "Could not save." in the header and the editor's strip.

| Rust prefix | Sentence | Key | Typical cause |
|---|---|---|---|
| `no_workspace` | "Choose a workspace folder first." | `workspace.errors.no_workspace` | no workspace open in Rust |
| `cannot_open` | "That folder cannot be opened. It may have been moved or deleted." | `workspace.errors.cannot_open` | a picked, remembered or recent folder that is gone or is not a folder |
| `outside_workspace` | "That path is outside the workspace." | `workspace.errors.outside_workspace` | a dialog pick elsewhere; a file left open from the previous workspace |
| `symlink` | "Morion does not follow symbolic links." | `workspace.errors.symlink` | a path through a link |
| `not_found` | "That file is not in the workspace." | `workspace.errors.not_found` | the file, or a folder on its path, was deleted or moved meanwhile |
| `locked` | "That file is encrypted." | `workspace.errors.locked` | a plain save over a file encrypted meanwhile outside Morion (a change made from the Files panel is followed instead, see Encryption) |
| `not_text` | "That file is not a text file." | `workspace.errors.not_text` | not UTF-8, including a plain picture picked through "All" |
| `too_large` | "That file is too big to open here." | `workspace.errors.too_large` | over 64 MB, or an encrypted file that decrypts to more |
| `no_session` | "That file is no longer open for editing. Open it again." | `workspace.errors.no_session` | an encrypted file's session is gone |
| `metadata` | "That is Morion’s own metadata folder." | `workspace.errors.metadata` | a path inside a folder named `.morion`, at any depth |
| `changed_on_disk` and the other encryption prefixes | see Encryption | `lock.errors.*` | an encrypted file changed on disk outside Morion while open, a wrong passphrase, … |

Elsewhere the mapping differs by place. The passphrase dialog turns the
encryption prefixes into sentences, and every action run in it, the host's and
the row shields', turns a workspace refusal into its sentence first; where a
prefix has both, encrypting keeps the encryption sentence and opening and
decrypting take the workspace one (`dialogErrorKey`, `fs.ts:39-47`). The folder
dialog turns both families into sentences, workspace first, for its preview, a
run and each failure. The Files panel's open-error line shows a workspace
sentence for an open, and a sentence from either family after a row shield's
decrypt with the remembered passphrase. Insert a table's "Load file…" and the
deck's "Import from file…" turn workspace refusals into sentences, and the tag
dialog its own four as well (see Tags). The search and the header's export
error show the text as it came.

### The discard prompt

`confirmDiscard()` (`EditorHost.vue:386-390`) runs before New (any kind, from
the menu or the start screen), before Open (menu, start screen, Ctrl+O) and
before opening an encrypted file from a row or a search hit (`:276`); an
encrypted file picked through Open… is asked about once, by Open. It only asks
while the buffer is dirty. The guard reads the host's `dirty` flag, which the
editor drives through `update:dirty`; the handle's `isDirty()` is never
consulted (`EditorHost.vue:387`, `types.ts:25`). A brand-new untitled file that
has not been typed in is therefore replaced by New or Open without any prompt,
even though Save is enabled for it. The modal (`EditorHost.vue:750-759`) is an
`OyaModal` with:

* title "Discard unsaved changes?" (`file.discardTitle`);
* body "This drawing has unsaved changes. Discard them?"
  (`file.discardBody`), the same wording for every file kind, drawing or not;
* secondary "Cancel" (`common.cancel`, `data-testid="discard-cancel"`) and
  primary "Discard" (`file.discardConfirm`, `data-testid="discard-confirm"`).

A click on the backdrop also counts as Cancel. Escape does not close the prompt
(`OyaModal` has no key handling), so the only ways out are the two buttons and
the backdrop. The modal is teleported to `<body>` at z-index 60 over a 70%
black overlay (`data-testid="oya-modal-overlay"`), fades in and out over 150
ms, and draws on a `max-w-sm` `ModalPanel` card
(`packages/rakotis/src/components/primitives/OyaModal.vue:17, 26-40`;
`packages/petalite/src/components/ModalPanel.vue:16-19`). The title is small
bold text and the body sits at 70% opacity; the two buttons are right-aligned.
Ctrl+O while the prompt is up is not blocked: it calls `openFile()` again,
which replaces the pending resolver (`EditorHost.vue:388-389, 574-577`); the
first request is dropped silently, and Cancel or Discard then answers only the
latest one. The ☰ menu cannot be reached meanwhile because the overlay covers
it. Opening a plain Files-panel row or search hit never shows this prompt;
opening an encrypted one does. Switching the workspace never shows it.

### Open as plain text

When a structured editor (Write, Presentations, Sheet, Drawing) cannot parse
the file it was routed to, it replaces its body with a centred refusal panel: a
`triangle-exclamation` icon, a bold title, a detail line, and one secondary
button "Open as plain text" (`file.openAsText`). Clicking it emits
`open-as-text`; the host sets `forceText` and bumps the generation, so the same
name, path and content remount in the bare `TextEditor` (no toolbar, no
picker) (`EditorHost.vue:141, 371-380, 725-738`). The header name, path and
Save As filter stay those of the original kind, and Save writes the text
buffer back over the original file; for an encrypted file the session is kept,
so that save still re-encrypts. The forced-text state lasts for that one open
only: `show()` resets `forceText`, the dirty flag, the error and the notice and
remounts on every Open, New, Files-panel row or search hit
(`EditorHost.vue:400-412`). The catalogue's `file.rawView` ("This file opened
as raw text so nothing gets lost. Editing it here is not supported yet.",
`en.ts:225`) is rendered nowhere; the bare text editor shows no notice about
why it is there, and the buffer IS editable and saveable. Each editor's title
and detail are given in its own section below.

### Read-only images

`readOnly` is `isImageName(name)` (`EditorHost.vue:558`). For a picture,
plain or encrypted, `canSave` is false and `saveFile()` and `saveAs()` return
at once, so Save is greyed in the menu and Save As looks enabled (`App.vue:280`
gates it only on a file and a workspace) but is a silent no-op: `saveAs`
returns before any dialog (`EditorHost.vue:509`). The dot can never appear,
because there is no buffer. An encrypted picture has no session at all; its
bytes were decrypted once, into memory, for display.

### Ctrl+O and Ctrl+S

Ctrl+O (Cmd+O on macOS) is the host's one window listener
(`EditorHost.vue:566-578, 603`). It is ignored while Workspace security or
Settings is on screen (`props.active === false`) and when the event target is
an `INPUT` or `TEXTAREA`. In practice that means Ctrl+O does nothing while the
cursor is in a Code, Markdown or plain-text buffer, because ACE types through a
hidden `<textarea>` (`ace_text-input`) and the editor focuses it on mount
(`TextEditor.vue:147`); it also does nothing while the workspace search box or
a field of the passphrase, folder or tag dialog has focus. It works from the
Write, Presentations, Sheet and Drawing editors and from the start screen.
There is no shell-level Ctrl+S: saving from the keyboard is each editor's own
`save` emit, with the gating described per editor and summarised in "Keyboard
shortcuts".

### Browser build differences

`isTauri` is `"__TAURI_INTERNALS__" in window` (`EditorHost.vue:105`). Without
it:

* No workspace exists or is needed. The menu's Open… and Save As… and the start
  screen's Open… ignore the workspace rule (`App.vue:276-281`;
  `StartView.vue:70`).
* Open…, Ctrl+O and the start screen's Open… click a hidden
  `<input type="file">` whose `accept` list is every editor extension
  (`EditorHost.vue:443, 448-451, 476-483, 612`). There are no filters. A
  browser `File` has no path, so the file is treated as never saved. The input
  is reset after every pick (`:479`), so choosing the same file twice in a row
  reopens it. Cancelling the picker does nothing. A failure in `file.text()` is
  not caught, so it never reaches `file-error`.
* Save and Save As never show a dialog. `saveAs()` builds a `Blob` typed by
  kind (`document` and `deck` `application/xml`, `code` `text/plain`,
  `markdown` `text/markdown`, `sheet` `application/json`, `sketch`
  `image/svg+xml`), clicks an `<a download="{name}">`, marks the buffer saved
  and shows "Saved" (`EditorHost.vue:109-116, 511-521`). Because the path stays
  null, Save is enabled for as long as a file is open and every Save is another
  download.
* Nothing is encrypted, tagged or charged: the file shield appears but Encrypt
  is always blocked with "Save the file first.", the tags button never
  appears, there are no padlocks, and the search finds nothing.
* The catalogue's `file.browserNote` ("Running in a browser — files open from
  and save to downloads.") exists but is rendered nowhere.
* `main.ts` wires the drawing engine's PNG writer to the Tauri fs plugin
  (`apps/morion/src/main.ts:1-5`), which a plain browser lacks; PNG export
  falls back to a download.

## Encryption

Morion encrypts files in place, each with a passphrase. There are three
places to do it, all beside the thing they act on: the file shield in the
header for the open file, the row shield at the right of every file row, and
the folder shield on every folder row, which encrypts or decrypts everything
under that folder. The Workspace security view only summarises; nothing there
encrypts anything. An encrypted file can be opened and edited in its own
editor without ever being decrypted on disk.

What a user can rely on (`crates/padova/src/lock.rs:1-53`):

* Each file is encrypted on its own, with a fresh random salt and key, the
  passphrase stretched with Argon2id. That takes most of a second per file,
  during which the window keeps painting (the commands are asynchronous). Two
  files under one passphrase share nothing, so each can be opened alone.
* Everything needed to open the file except the passphrase travels inside it,
  so it opens on any machine that has the passphrase and survives being
  renamed or moved.
* Whether a file is encrypted is read from its first bytes, by Rust: the
  listing's `sealed` flag, the `is_file_locked` probe, the search and the
  host's `locked` refusal all ask the same function
  (`crates/substrate/src/lib.rs:134-156`). The page never inspects bytes.
* A wrong passphrase changes nothing on disk.
* Encrypting, decrypting or opening a file over 256 MB is refused, and an
  encrypted file that decrypts to more than 64 MB cannot be opened
  (`crates/substrate/src/lib.rs:112, 196-203`; `sealed.rs:84-86`). Opening or
  decrypting says "That file is too big to open here."
  (`workspace.errors.too_large`), in the passphrase dialog as in the header or
  the Files panel; encrypting a single file says "That file is too big to
  encrypt." (`lock.errors.too_large`). A folder run words it by its
  direction in the same way: an encrypt run "too big to encrypt", a decrypt
  run "too big to open here" (see the folder dialog).
* Files encrypted by Enigma open with their passphrase and are written back in
  Enigma's own format; files encrypted by the old platform are shown with a
  padlock but refused ("This file was encrypted by the platform. Its key
  settings lived on the server, so it cannot be opened here.").

### The passphrase dialog

One dialog serves every single-file action: padova's `LockModal`
(`packages/padova/src/components/LockModal.vue:84-127`), in `open` mode
(decrypt into memory for editing), `lock` mode (encrypt) or `unlock` mode
(decrypt permanently). The host mounts one for the open file
(`EditorHost.vue:740-748`) and the Files panel another for its row shields
(`FilesPanel.vue:343-351`). It is an `OyaModal` on a `max-w-sm` card, closed by
a backdrop click unless a run is in flight; Escape does nothing. The password
field does not take focus by itself. Top to bottom:

| Element | `open` | `lock` | `unlock` | `data-testid` |
|---|---|---|---|---|
| Title | "Open encrypted file" (`lock.openTitle`) | "Encrypt this file" (`lock.lockTitle`) | "Decrypt this file permanently" (`lock.unlockTitle`) | none |
| File name | small, dim, truncated, no tooltip | same | same | none |
| Hint | "The file is decrypted in memory only. Saving writes it back encrypted; nothing unencrypted is written to disk." (`lock.openHint`) | "The password is never written into the file, and each file gets its own key. Everything needed to open this file again, except the password, travels inside it." (`lock.lockHint`) | "This rewrites the file as plain text on disk. To edit it without that, open it instead." (`lock.unlockHint`) | `lock-open-hint`, none, `lock-unlock-hint` |
| Notice (the `#notice` slot) | what opening does and what it costs (see Security Mana); when the key is fetched to save a file that was encrypted while open, "This file was encrypted while it was open. Enter its passphrase to save your changes encrypted." (`shield.encryptedWhileOpen`) and no price | nothing: encrypting is free | what decrypting does and what it costs | `lock-consequence`, `mana-cost` |
| Password | placeholder "Password" (`lock.password`), `type="password"`, autocomplete off, Enter submits | same | same | `lock-password` |
| Repeat | none | placeholder "Repeat the password" (`lock.confirm`), Enter submits | none | `lock-confirm` |
| Remember checkbox | "Remember this passphrase, so I am not asked again" (`lock.remember`); the whole label is clickable | same | same | `lock-remember` |
| Error line (warn colour) | | | | `lock-error` |
| Cancel | "Cancel" (`common.cancel`), disabled while running | same | same | none |
| Submit | "Open" (`lock.open`), icon `lock-open` | "Encrypt" (`lock.lock`), icon `lock` | "Decrypt" (`lock.unlock`), icon `lock-open` | `lock-submit` |

The price appears only when Rust could quote one (a workspace is open and its
metadata is readable); in the host's dialog the consequence line shows even
without a price, while the row shields' dialog shows neither without one
(`EditorHost.vue:744-747`; `FilesPanel.vue:345-350`). The submit button shows a
spinner while running and is disabled while running or while the password field
is empty. Every field resets each time the dialog opens. Before any call, an
empty password gives "Enter the password." (`lock.passwordRequired`; Enter
still reaches the check although the button is disabled) and, when encrypting,
fields that differ give "Those two do not match." (`lock.passwordMismatch`). A
second Enter or click while a run is in flight is ignored, the error line
clears when a new attempt starts, and both password fields are emptied after
every attempt, success or failure (`LockModal.vue:40-81`). Success closes the
dialog. A failure keeps it open with the error: an encryption prefix becomes
its sentence, anything else is shown verbatim. The dialog itself knows only the
encryption sentences, so every action run in it, the host's four (opening,
fetching the key for a save, encrypting, decrypting) and both row-shield
actions, first turns a workspace refusal into its own sentence (`inDialog`,
`EditorHost.vue:80-87, 258-265, 294-299, 313-317, 358-362`;
`FilesPanel.vue:165-173`; `dialogErrorKey`,
`apps/morion/src/files/fs.ts:39-47`). So an encrypted file that is not text
says "That file is not a text file.", and a file left open from a previous
workspace "That path is outside the workspace.". Where a prefix has a sentence
in both catalogues (`too_large`), encrypting keeps the encryption one and
opening and decrypting take the workspace one.

| Rust prefix | Sentence (`lock.errors.*`) |
|---|---|
| `wrong_password` | "Wrong password, or the file is damaged. Nothing was changed." |
| `legacy_format` | "This file was encrypted by the platform. Its key settings lived on the server, so it cannot be opened here." |
| `already_locked` | "That file is already encrypted." |
| `not_locked` | "That file is not encrypted." |
| `too_large` | "That file is too big to encrypt." |
| `crypto` | "That encrypted file is damaged. Nothing was changed." |
| `no_passphrase` | "No password was given, and none is remembered." |
| `changed_on_disk` | "That file changed on disk while it was open. Nothing was written; open it again." |

(`packages/padova/src/lock.ts:22-41`; `packages/padova/src/i18n/en.ts:26-35`.)

The Remember box is shown by the host's dialog on the desktop
(`offer-remember="isTauri"`, `EditorHost.vue:741`) and always by the row
shields' dialog (`FilesPanel.vue:344`), and it is honoured in every use:
opening, encrypting, decrypting, fetching the key for a save, and both row
shield actions. The passphrase goes to the keyring only after the action
succeeded, so one that did not open the file is never remembered
(`EditorHost.vue:264, 301, 324, 365`; `FilesPanel.vue:177-178`).

### Opening an encrypted file

An encrypted file is opened by clicking its row or its search hit, or by
picking it in the Open dialog (Rust's `locked` answer redirects it). All three
end in `openSealed` (`EditorHost.vue:275-303`):

1. The discard prompt, if the buffer is dirty. Through Open… it was answered
   there already and is not asked again (`EditorHost.vue:446, 469, 276`).
2. The header error is cleared.
3. If a passphrase is remembered, the Mana confirmation for opening comes
   first; Cancel stops here and costs nothing. Continue decrypts with the
   remembered passphrase and no dialog. If that passphrase is not this file's
   (`wrong_password`), or none is actually held (`no_passphrase`), the flow
   falls through to step 4; any other refusal ends with "Could not open the
   file. <sentence>" in the header.
4. Otherwise the passphrase dialog in `open` mode, carrying the consequence
   "The file is decrypted into memory while it is open. Nothing unencrypted is
   written to disk." and the price. A wrong passphrase keeps the dialog open
   with its sentence; Cancel or the backdrop ends it and costs nothing.
5. On success (`adoptSealed`, `EditorHost.vue:209-219`): a text file is
   decrypted by Rust into memory, and the host receives the plaintext and a
   session token, routes the text through `kindForFile` and mounts that
   editor, exactly as for a plain file. A picture is decrypted to bytes and
   shown read-only in the image viewer, with no session. Nothing on disk
   changes. The Mana charge follows the successful open, and a ticked Remember
   box hands the passphrase to the keyring after that.

Any kind opens: a note in Markdown, a `.pxml` or `<presentation>` in
Presentations, a workbook `.json` in Sheet, an `.svg` in Drawing, a document
in Write, anything else in Code, and the same refusal panels and "Open as
plain text" apply after decryption. A file that is not UTF-8 text once
decrypted, and not a picture (an encrypted PDF, say), cannot be opened: with a
remembered passphrase the header reads "Could not open the file. That file is
not a text file."; in the dialog the error line reads "That file is not a text
file.". Either way nothing is charged.

The header then shows the file's name and a filled shield, and the shield
panel reads "Encrypted on disk. It is decrypted in memory only; saving writes
it back encrypted." (or, for a picture, "Encrypted on disk. Shown from memory;
nothing is written.").

### Editing and saving in memory

While an encrypted text file is open, Rust keeps its key, never the
passphrase, in a session the page knows only by a number
(`apps/morion/src-tauri/src/sealed.rs:25-63`), and the plaintext exists only
in the editor.

* Save hands the text and the token to Rust (`sealed_write`), which re-encrypts
  it under the same key and header with a fresh nonce and writes it through a
  temporary that holds only ciphertext. Nothing unencrypted reaches the disk,
  no passphrase is asked, and no Mana is spent (`EditorHost.vue:486-506`;
  `sealed.rs:102-112`; `crates/padova/src/lock.rs:114-140`).
* Save As writes an encrypted copy under the same key, so the same passphrase
  opens it. Picked onto the file the session edits, it is an ordinary save;
  onto any other path it is a copy, and an existing file there is replaced,
  plain or encrypted, since the save dialog has already asked about it. From
  then on the session edits the copy: later saves go to it and are checked as
  below, and the original stays as it was (`crates/padova/src/lock.rs:100-104,
  123-126, 138`).
* Writing to the file the session edits (the one it was opened from, or the
  last Save As target) checks first that the file on disk still carries the
  session's key. If it does not, because it was encrypted again with another
  passphrase, decrypted or replaced behind Morion's back, Save refuses and
  writes nothing: "Could not save. That file changed on disk while it was open.
  Nothing was written; open it again." (`lock.rs:128-134`). A change made from
  the Files panel does not end here, because the host follows it (see The open
  file follows the pane).
* "Could not save. That file is no longer open for editing. Open it again."
  (`no_session`) means the token no longer names a session. The host drops
  token and session together, so the UI does not normally reach it.
* The session ends, and the key is dropped, when another file is opened or New
  replaces this one, when the file is decrypted permanently (from the header's
  shield, or from the Files panel, which the host then follows), and when the
  app closes (`EditorHost.vue:159-165, 221-240, 402, 603-607`). "Open as plain
  text" keeps it.
* An export from an encrypted file (CSV, PNG) writes plaintext outside the
  workspace and costs Mana (see Security Mana).

### The file shield

The shield panel's two buttons act on the open file (`App.vue:159-166`):

* "Encrypt with a passphrase…", for a plain file that has a path and no
  unsaved changes, since the bytes on disk are what get encrypted
  (`encryptFile`, `EditorHost.vue:308-330`). It always opens the dialog in
  `lock` mode: the remembered passphrase is never used to encrypt, and the
  passphrase is always typed twice. On success Rust encrypts the file in
  place; for a text file the host then opens a session on it with the same
  passphrase, a second derivation of about a second, so editing continues
  encrypted without a reload; for a picture it simply marks it as shown from
  memory. The file is encrypted from the moment Rust answers, so if that
  session cannot be had the dialog still closes as a success and the file is
  marked encrypted while open: the next save asks for the passphrase. A ticked Remember box is honoured, the padlock is refreshed, and the
  history records "Encrypted a file" at no cost.
* "Decrypt permanently…", for an encrypted file with no unsaved changes
  (`decryptFile`, `EditorHost.vue:334-367`). With a remembered passphrase the
  Mana confirmation comes first and no dialog follows; otherwise, or if the
  remembered passphrase is not the file's, the dialog in `unlock` mode with the
  price. On success the file on disk is rewritten as plaintext, the session is
  dropped (the editor already holds the plaintext, so nothing reloads), later
  saves are plain again, the padlock goes, the Mana charge follows, and a
  ticked Remember box is honoured. With the remembered passphrase, a refusal
  other than a wrong passphrase shows its bare sentence in the header error.

Either button is disabled while its blocker line shows ("Save the file first."
or "Save your changes first.") and while a Save is in flight.

### Row shields

Every file row carries a shield (`FilesPanel.vue:318-326`), so any file can be
encrypted or decrypted from the pane, including files no editor here opens,
such as a PDF (`shieldFile`, `FilesPanel.vue:128-159`):

* A plain file's shield ("Encrypt this file") always opens the dialog in `lock`
  mode, passphrase typed twice. On success the file is encrypted in place, its
  padlock is re-probed and the history records "Encrypted a file"
  (`lockAction`, `FilesPanel.vue:161-166, 174-175`).
* An encrypted file's shield ("Decrypt this file permanently"): with a
  remembered passphrase, the Mana confirmation, then the decrypt with no
  dialog; a refusal other than a wrong passphrase appears in the panel's
  `files-open-error` line as its sentence. Without one, or when it is not the
  file's, the dialog in `unlock` mode with the price inside it. On success the
  file is plaintext on disk, its padlock goes and the Mana charge follows
  (`FilesPanel.vue:137-159, 161-167, 174-176`).
* In either dialog a ticked Remember box is honoured once the action succeeded
  (`FilesPanel.vue:177-178`).

### The open file follows the pane

After every successful row shield action, and after every folder run, the panel
emits `security-changed` and App calls the host's `resync`, which asks Rust
again whether the open file is encrypted on disk (`FilesPanel.vue:146, 179,
197`; `App.vue:522`; `EditorHost.vue:221-240`). The editor's buffer is never
replaced, so unsaved edits survive either way:

* Plain on disk now: whatever the host held for the file, a session, an
  encrypted picture or the mark of a file encrypted while open, is dropped; the
  header shield turns to "Not encrypted" and later saves are plain. So a file
  encrypted from its row and decrypted again before any save simply ends plain
  (`EditorHost.vue:232-235`).
* Encrypted underneath while the host held it as plain: the header shield turns
  to encrypted at once. A picture is then shown as an encrypted picture from
  memory, with its status line. For a text file the status line is the ordinary
  encrypted one, and the next Save first fetches the file's key: the remembered
  passphrase is tried silently; otherwise the dialog opens in `open` mode, with
  the notice "This file was encrypted while it was open. Enter its passphrase
  to save your changes encrypted." (`shield.encryptedWhileOpen`) and no price,
  since the plaintext was already on screen. Then the buffer, unsaved edits
  included, is written back encrypted. Cancelling the dialog writes nothing,
  the header's error line says "Not saved: the file is encrypted and its
  passphrase was not given." (`shield.saveCancelled`), and the file stays
  marked encrypted (`adoptSessionForSave`, `EditorHost.vue:242-266, 488-493`).
  Save As fetches the key from the original file in the same way and writes an
  encrypted copy.
* A change to some other file leaves the open file as it was.

### Folder shields and the folder dialog

A folder row's shield (`folder-shield-{name}`, "Encrypt or decrypt this
folder") opens `FolderLockModal` (`apps/morion/src/security/FolderLockModal.vue`,
mounted by `FilesPanel.vue:352-353`) for that folder. The folder is not
expanded. On opening, the dialog asks Rust what is there
(`folder_preview`) and whether a passphrase is remembered, and offers the
direction that has something to do: "Decrypt all" when nothing under the
folder is plain and something is encrypted, otherwise "Encrypt all"
(`FolderLockModal.vue:45-67`). It is an `OyaModal` on a `max-w-sm` card; the
backdrop closes it unless a run is in flight; Escape does nothing.

| Element | Text | Key | `data-testid` | Notes |
|---|---|---|---|---|
| Title | "Encrypt or decrypt everything in “{name}”" | `folder.title` | none | |
| Folder path | the full path, truncated, tooltip the path | | none | |
| Preview | "Loading…" (`common.loading`) until Rust answers, then "{files} files here: {plain} plain, {sealed} encrypted.", followed when relevant by "{n} symbolic links are left alone." (60% opacity) and, in warn colour, "The folder is larger than one run covers; run again afterwards." | `folder.preview`, `folder.links`, `folder.truncated` | `folder-preview` | A failed preview shows its sentence in `folder-preview-error` (a workspace or encryption prefix; anything else as it came), and no form follows (`FolderLockModal.vue:64-66`). |
| Direction | two radio buttons, "Encrypt all" and "Decrypt all" | `folder.encryptAll`, `folder.decryptAll` | `folder-mode-lock`, `folder-mode-unlock` | disabled while running |
| Note | encrypting: "Every plain file below this folder is encrypted with this one passphrase, each with its own key; files already encrypted are skipped." decrypting: "Every encrypted file below this folder is decrypted permanently with this passphrase; plain files are skipped. If a file does not open with it, the run stops there: files already decrypted stay decrypted and the rest are left as they were." Both then: "Symbolic links are not followed and Morion’s own .morion folder is not touched. A file that fails is reported and does not undo the others. Each file takes about a second." | `folder.noteLock`, `folder.noteUnlock`, `folder.noteCommon` | `folder-note` | |
| Price | decrypting only, and only when something is encrypted: "Every encrypted file in this folder is rewritten unencrypted on disk. The cost follows how many files are actually decrypted." and the price quoted for every encrypted file under the folder | `mana.consequence.decrypt_folder` | `folder-consequence`, `mana-cost` | |
| Password | placeholder "Password", or, when decrypting with a remembered passphrase, "Remembered passphrase (or type another)"; Enter runs | `lock.password`, `folder.rememberedPlaceholder` | `folder-password` | |
| Repeat | "Repeat the password"; encrypting only; Enter runs | `lock.confirm` | `folder-confirm` | |
| Mismatch line (warn colour) | "Those two do not match." | `lock.passwordMismatch` | `folder-mismatch` | encrypting only, shown while the repeat field holds something that differs from the first |
| Error line | a workspace or encryption prefix as its sentence, the workspace one first, anything else verbatim | `workspace.errors.*`, `lock.errors.*` | `folder-error` | the form stays for another try |
| Report (replaces the form after a run) | "{n} files changed.", then "{n} files were already as requested and were skipped." (70% opacity), then, in warn colour, "{n} files were not tried after the wrong passphrase and are still encrypted." and "{n} files failed and were left as they were:" with one line per failure, "relative/path: sentence", in a list that scrolls past 8rem. A failure's sentence follows the run's direction as the passphrase dialog does (`dialogErrorKey`): an encrypt run says "That file is too big to encrypt.", a decrypt run "That file is too big to open here."; anything without a known prefix shows verbatim | `folder.reportDone`, `folder.reportSkipped`, `folder.reportUntried`, `folder.reportFailed` | `folder-report`, the untried line `folder-untried`, each failure `folder-failure` | The untried line shows only when a run stopped early, which only a decrypt run with a wrong passphrase does. |
| Cancel, then Close | "Cancel" before a run, "Close" after it; disabled while running | `common.cancel`, `common.close` | `folder-close` | |
| Run | "Encrypt all" (icon `lock`) or "Decrypt all" (icon `lock-open`), spinner while running | | `folder-run` | Enabled only once the preview has loaded and, to encrypt, both fields hold the same passphrase, or, to decrypt, a passphrase is typed or one is remembered. Hidden after the run. |

There is no Remember box: encrypting always takes a typed passphrase, twice,
and decrypting may leave the field empty to use the remembered one. Enter in a
field runs only when the button would be enabled. While encrypting, "Those two
do not match." appears under the fields as soon as the repeat field holds
something different from the first, and goes once the two agree; the button
stays disabled meanwhile (`FolderLockModal.vue:71-79, 157`). Both fields are
emptied after every run, success or failure (`FolderLockModal.vue:101-104`).

What a run does (`apps/morion/src-tauri/src/folder.rs:72-174`): every regular
file below the folder, walked breadth first as the search walks, with links
counted and never followed, `.morion` never entered, folders deeper than 32
levels not entered, and at most 20,000 files per run. Each file is encrypted or
decrypted on its own, exactly as a single file would be, about a second each. A
file already in the requested state is skipped. A file that fails is recorded
with its error and the run goes on; nothing that succeeded is undone. When
decrypting, the first wrong passphrase (or a missing remembered one) stops the
run: that file is reported as failed, and every encrypted file after it is
reported as not tried, in its own line of the report, while plain files met
after it still count as skipped. Files decrypted before that point stay
decrypted, as the note says (`folder.rs:143-171`).

After a run the report stays until Close, the Files panel re-reads the tree so
every padlock is right, the search asks again, and the open file follows as it
does after a row shield (`FilesPanel.vue:194-198`). Decrypting is charged by
the number of files actually decrypted, nothing when none were; encrypting
records "Encrypted a folder" at no cost when at least one file was encrypted
(`FolderLockModal.vue:88-106`).

### The remembered passphrase

One passphrase can be remembered for the whole app, so that opening and
decrypting stop asking.

* It is set only by ticking "Remember this passphrase, so I am not asked again"
  in a passphrase dialog whose action then succeeded: opening an encrypted
  file, encrypting or decrypting from the file shield or a row shield, or
  fetching the key to save a file encrypted while open. The host's dialog
  offers the box on the desktop only; the folder dialog has none. A new one
  replaces the old.
* It is used to open an encrypted file (no dialog, only the Mana
  confirmation), to decrypt from the file shield or a row shield (the same),
  and for a folder decrypt whose field is left empty. It is never used to
  encrypt.
* If it is not the file's passphrase, opening and single-file decrypting fall
  back to the dialog; a folder decrypt stops at the first such file.
* It is kept in the system keyring (service `com.spectrumaipl.zinnia`, account
  `file-passphrase`, one entry for the whole app), or, where no keyring is
  available, in the app's memory until it closes. The page can ask only
  whether one is remembered and where, and forget it; nothing hands it back
  (`packages/padova/src/lock.ts:79-118`;
  `apps/morion/src-tauri/src/secrets.rs:9-29`;
  `crates/padova/src/secrets.rs:60-118`).
* Its status, and "Forget it", are in the Workspace security view.

### What encryption does not hide

The shield panel and the Workspace security view both say it: "Encryption
protects the contents of a file. Its name, its folder, its size and dates, and
any tags stay visible." (`shield.limits`). In practice:

* The tree lists an encrypted file by name, size and folder like any other.
* The search finds encrypted files by name, path and tag.
* Tags are plain text in `.morion/metadata.json`, and the Security Mana
  ledger there records, with the time, the workspace-relative path of every
  encrypted file opened, exported or given a new tag, and of every file or
  folder encrypted or decrypted.
* The keyring entry's name reveals only that the app is installed.

## Tags

A file can carry up to three tags: short words about it, kept in plain text
beside it and never encrypted, so a tag on an encrypted file is a deliberate
word about it in the clear. They are filed by the file's path relative to the
workspace root in `.morion/metadata.json` (`apps/morion/src-tauri/src/meta.rs:1-16`).

The header's tags button (`file-tags`, see The header) shows the open file's
tags as chips, or "No tags", and opens the tag dialog. It exists only in the
editor view and only for a file with a path, so a new, unsaved file cannot be
tagged until it is saved. Folders cannot be tagged, and there is no other
place in the UI to add or remove a tag. Tags show again as chips in search
results, and every search mode matches them.

### The tag dialog

`apps/morion/src/files/TagModal.vue:83-117`, mounted by `App.vue:487-488`. An
`OyaModal` on a `max-w-sm` card titled "Tags" (`tags.title`); a backdrop click
closes it unless it is loading or saving, and Escape does nothing. On opening
it reads the file's current tags from Rust (`tags_get`) into the fields and,
for an encrypted file, asks Rust for the price (`TagModal.vue:48-62`).

| Element | Text | Key | `data-testid` | Notes |
|---|---|---|---|---|
| Title | "Tags" | `tags.title` | none | |
| File name | small, dim, truncated | | none | |
| Three fields | placeholders "Tag 1", "Tag 2", "Tag 3"; at most 32 characters each (`maxlength`); disabled while loading or saving; Enter saves | `tags.placeholder` | `tag-field-0`, `tag-field-1`, `tag-field-2` | filled with the current tags in order |
| Note | "Up to three tags. They are kept in plain text in the workspace’s .morion/metadata.json, beside the file, and are never encrypted." | `tags.note` | `tags-note` | always |
| Sharper note (warn colour, inside the same line) | "This file is encrypted; a tag is one word about it that stays readable." | `tags.sealedNote` | `tags-sealed-note` | only for an encrypted file |
| Consequence | "A new tag on an encrypted file is a word about it in plain text." | `mana.consequence.tag_sealed` | `tags-consequence` | only for an encrypted file, when Rust could quote; directly above the price (`TagModal.vue:98-101`) |
| Price | "Costs 3 Mana" and what would be left (see Security Mana) | `mana.*` | `mana-cost` | only for an encrypted file, when Rust could quote |
| Error line (warn colour) | a Rust refusal as its sentence, anything else as it came (`TagModal.vue:41-46`) | `workspace.errors.*` | `tags-error` | the dialog stays open; shown for a failed read on opening as well as for a failed save |
| Cancel | "Cancel" | `common.cancel` | none | disabled while loading or saving |
| Save | "Save" | `common.save` | `tags-save` | disabled while loading or saving |

Save hands all three fields to Rust (`tags_set`), which trims each one, drops
empty ones and repeats (compared case-insensitively for ASCII letters), and
refuses a tag over 32 characters ("A tag can have at most 32 characters.",
`tag_too_long`), more than three tags ("A file can have at most three tags.",
`too_many_tags`) and a folder ("Only files can be tagged, not folders.",
`tag_folder`); a refusal writes nothing (`meta.rs:87-135`). The dialog's three
32-character fields cannot produce the first two, and the header offers tags
only for a file, so in practice the sentences met here are "The workspace’s
.morion/metadata.json is damaged, so tags cannot be changed. Nothing was
changed." (`meta_damaged`) when the metadata file does not parse, and "That
path is outside the workspace." for a file left open from a previous workspace.
Saving three empty fields removes the file's entry. On success the header's
chips become the saved tags and the dialog closes (`App.vue:488`).

For an encrypted file the price is shown whenever the dialog opens, but Mana
is charged only after a successful save that contains at least one tag that
was not there when the dialog opened (compared without regard to case).
Keeping or removing tags costs nothing, and so does tagging a plain file
(`TagModal.vue:64-80`).

Because tags are keyed by path, they do not follow a file: one renamed or
moved outside Morion loses them (the old entry stays behind in the metadata
file), and a Save As copy starts with none. The header reads a file's tags
again whenever the open file's path changes (`App.vue:174-182`).

## Security Mana

Security Mana is an advisory budget for plaintext exposure: a number the user
can read, spent when they deliberately make encrypted content readable. It is
not a security score and not an enforcement mechanism: nothing is gated,
delayed or weakened by it, an exhausted budget only warns, and encrypting earns
nothing, so there is no credit to farm, only spending and time
(`apps/morion/src-tauri/src/mana.rs:1-33`). The words on screen say the same:
"Mana is an advisory budget for plaintext exposure, not a security score. It
never blocks anything, and it comes back with time." (`mana.advisory`).

The prices live in Rust and only there: the page names an action and a count,
never an amount (`apps/morion/src/security/mana.ts:1-10`). Everything needs
the desktop and an open workspace; without either there is no price to show,
no confirmation and no charge.

### The meters

Two meters, shown in the Workspace security view: "Today", out of 100, and
"This week", out of 700 (`mana.rs:42-45`). Each is a rolling window derived
from the ledger, never a stored counter: today's meter is 100 minus what was
spent in the last 24 hours, the week's is 700 minus what was spent in the last
7 days, neither going below zero (`mana.rs:88-118`). A charge simply ages out
of each window, so nothing is written when Mana comes back, and time with the
app closed counts like any other. A charge dated in the future (a clock set
back) counts as now rather than escaping the window. The budget is exhausted
when either meter reaches zero. The ledger lives in the workspace's
`.morion/metadata.json`, so each workspace has its own meters and switching
workspace switches them.

### The price table

(`mana.rs:59-72`)

| Action id | What it is | Price | Charged after | The price is shown in |
|---|---|---|---|---|
| `unlock_temp` | opening an encrypted file (text or picture): its plaintext is in memory and on screen while it is open | 5 | the file opened | the passphrase dialog "Open encrypted file", or, with a remembered passphrase, the confirmation |
| `decrypt_file` | decrypting one file permanently, from the file shield or a row shield | 15 | the file was decrypted | the passphrase dialog "Decrypt this file permanently", or, with a remembered passphrase, the confirmation |
| `decrypt_folder` | decrypting everything under a folder | 15, plus 5 for each file after the first, at most 100 | the run, for the number of files actually decrypted; nothing when none were | the folder dialog, quoted for every encrypted file under the folder |
| `export_plain` | an export (CSV, PNG) from an encrypted file: plaintext written outside the workspace's protection | 10 | a file was written | the confirmation |
| `tag_sealed` | a new plain-text tag on an encrypted file | 3 | tags were saved including at least one new one | the tag dialog |

Two further actions cost nothing and are only recorded, so the history shows
them: encrypting a file ("Encrypted a file", from the file shield or a row
shield) and encrypting a folder ("Encrypted a folder", a folder run that
encrypted at least one file) (`mana.rs:74-75`).

### Quote before, charge after

Every priced action shows its price before it runs and is charged only after it
succeeded (`mana.ts:59-80`). The quote says what the action costs now, the two
maxima, what is left, and what would be left after paying (`mana.rs:120-152`).
The charge is written to the ledger by Rust after the fact; if writing it fails
(a damaged metadata file) the action is not undone and nothing is shown.

One action never needs two dialogs. Where a dialog is already on screen for the
action, the price goes inside it: the passphrase dialog when opening or
decrypting with a typed passphrase, the folder dialog, the tag dialog. Where no
dialog would otherwise appear, the one confirmation dialog asks first: opening
or decrypting with a remembered passphrase, and exporting from an encrypted
file. The exception is a remembered passphrase that turns out not to be the
file's: the price was confirmed, then the passphrase dialog shows it again, and
still only one charge follows a success.

Never charged:

* anything cancelled, at the confirmation or in a dialog;
* anything that failed: a wrong passphrase, a refusal, a cancelled save
  dialog, an export that wrote nothing or failed, a folder run that decrypted
  nothing;
* encrypting a file or a folder;
* saving an encrypted file, or Save As from one (the copy is encrypted too);
* fetching the key to save a file that was encrypted while it was open, since
  its plaintext was already on screen (`EditorHost.vue:242-266`);
* exports from a plain file, which was never protected (`App.vue:225-241`);
* removing or keeping tags, and any tag on a plain file;
* searching, which never reads an encrypted body.

An exhausted budget warns and never blocks: every button stays enabled.

### The confirmation dialog

`apps/morion/src/security/ManaConfirm.vue`, mounted once in the header
(`App.vue:486`) and opened by `askMana` (`mana.ts:97-128`). An `OyaModal` on a
`max-w-sm` card; a backdrop click is Cancel; Escape does nothing.

| Element | Text | Key | `data-testid` |
|---|---|---|---|
| Title | "This uses Security Mana" | `mana.confirmTitle` | none |
| Subtitle | the file's name, small and dim | | none |
| Consequence | opening: "The file is decrypted into memory while it is open. Nothing unencrypted is written to disk."; decrypting: "The file is rewritten unencrypted on disk and stays readable until you encrypt it again."; exporting: "An unencrypted copy of this encrypted file is written wherever you choose, outside the workspace’s protection." | `mana.consequence.unlock_temp`, `.decrypt_file`, `.export_plain` | `mana-consequence` |
| The price block | see below | | `mana-cost` |
| Cancel | "Cancel" | `common.cancel` | `mana-cancel` |
| Continue | "Continue", never disabled | `mana.continue` | `mana-continue` |

The consequences for a folder decrypt ("Every encrypted file in this folder is
rewritten unencrypted on disk. The cost follows how many files are actually
decrypted.") and for a tag ("A new tag on an encrypted file is a word about it
in plain text.") are never shown in the confirmation: the first is shown inside
the folder dialog, the second inside the tag dialog, each above its price.

### The price block

`apps/morion/src/security/ManaCost.vue:12-24`, the same block in the
confirmation and inside the passphrase, folder and tag dialogs
(`data-testid="mana-cost"`, a bordered box of small text):

1. a `droplet` icon and "Costs {cost} Mana" (`mana.cost`), bold;
2. "Leaves {daily} of {dailyMax} for today and {weekly} of {weeklyMax} for the
   week." (`mana.after`, `data-testid="mana-after"`), with what would be left
   after paying, never below zero, and the two maxima as the quote carries them
   (today 100, the week 700);
3. in the warn colour, when the budget is already exhausted or paying would
   bring either meter to zero: "Your exposure budget is used up. You can still
   go ahead; this is a warning, not a lock." (`mana.exhausted`,
   `data-testid="mana-exhausted"`);
4. at 50% opacity, the advisory sentence (`mana.advisory`).

### The ledger

The ledger is the list `ledger` in `.morion/metadata.json`, appended by Rust
on every charge and every recorded event (`mana.rs:161-209`;
`meta.rs:34-47`). Each row holds:

* `ts`: when, in milliseconds since the epoch;
* `action`: one of the five priced action ids or the two events;
* `path`: the file's or folder's path relative to the workspace root, with
  forward slashes, or nothing; a path that does not resolve inside the
  workspace is dropped rather than kept;
* `cost`: the Mana spent, 0 for an event;
* `note`: a catalogue key, `mana.notes.{action}`, which the view renders
  ("Opened an encrypted file for editing", "Decrypted a file permanently",
  "Decrypted a folder permanently", "Exported an encrypted file as plaintext",
  "Added a plain-text tag to an encrypted file", "Encrypted a file",
  "Encrypted a folder").

It never contains a passphrase, a byte of a file's contents, a search result
or snippet, or an absolute path. The newest 500 rows are kept and older ones
drop off; the Workspace security view shows the newest 100 (`meta.rs:30-32`;
`mana.rs:46-47, 251-258`).

## Workspace security

`apps/morion/src/views/WorkspaceSecurity.vue:89-211`, mounted by
`App.vue:529-530` (`v-if="visited.has('security')"` plus `v-show`) the first
time it is asked for and kept afterwards. It is reached only from the shield
in the Files sidepanel's header (`files-security`, "Workspace security",
`FilesPanel.vue:240-245`), which exists only while a workspace is open and
readable and the panel is showing; it is no longer in the ☰ menu. While it is
up the header shows a `shield-halved` icon and "Workspace security"
(`security.workspace.title`) with the × that returns to the editor, and the
Files panel is hidden. It is a summary of the open workspace and changes
nothing but the remembered passphrase: every control that encrypts or decrypts
sits beside the files. The view scrolls; its content is a centred column of at
most 42rem with 24px padding and 32px between sections
(`WorkspaceSecurity.vue:90-91`).

Top to bottom:

| Element | Text | Key | `data-testid` | Does | Source |
|---|---|---|---|---|---|
| Heading (`shield-halved` icon, 60% opacity) | "Workspace security" | `security.workspace.title` | none | | `WorkspaceSecurity.vue:93-96` |
| Workspace name | the folder's base name, or "No workspace open" | `workspace.none` | `security-workspace-name` | | `:97-99` |
| No workspace | "Choose a workspace folder first." | `workspace.errors.no_workspace` | `security-no-workspace` | Replaces every section below. Unreachable in practice: the shield that opens the view needs a workspace, and nothing in the UI ever empties the store's root once set. | `:102-104` |
| "Files" (uppercase heading) and three counts, each in its own bordered box: the number of encrypted files ("encrypted"), plain files ("not encrypted") and all files ("files in all") | "Files", "encrypted", "not encrypted", "files in all" | `security.workspace.filesTitle`, `.sealed`, `.plain`, `.total` | `security-summary` (section), `security-count-sealed`, `security-count-plain`, `security-count-files` | Counted by Rust over the whole workspace with the folder-run walk (`folder_preview` of the root): links not followed, `.morion` skipped in every folder, at most 20,000 files and 32 levels. A failure shows its sentence (`workspace.errors.*`) in place of the boxes, or Rust's text when the prefix has none. | `:108-124`; `folder.rs:112-126` |
| Links line (small, 60%) | "{n} symbolic links are left alone." | `folder.links` | none | Only when the walk met any. | `:125` |
| Count stopped early (small, warn colour) | "The workspace is larger than one count covers; these numbers are for its first 20,000 files." | `security.workspace.truncated` | `security-truncated` | Only when the walk reached 20,000 files and stopped. | `:126-128` |
| Where to act (small, 60%) | "Encrypt or decrypt with the shields beside each file and folder in the file pane, or beside the open file’s name." | `security.workspace.where` | none | | `:129` |
| "Passphrase" heading and a bordered row with a `lock-open` icon (remembered) or `lock` (not) | remembered: "A passphrase is remembered. Opening and decrypting use it without asking; encrypting always asks for one." then, dimmed, "Kept in the system keyring." or "Kept until this app closes — no system keyring was available."; otherwise "No passphrase is remembered. You will be asked each time." | `security.workspace.passphraseTitle`, `security.workspace.secretHeld`; `security.secret.keychain`, `.memory`, `.none` (padova's catalogue) | `security-passphrase` (section), `security-secret-status` (sentence) | Read from Rust (`secret_status`) each time the view loads; a failed read shows the "not remembered" sentence. Only the fact and the place are ever read, never the passphrase. | `:133-142`; `packages/padova/src/i18n/en.ts:48-54` |
| "Forget it" (small bordered button) | | `security.secret.forget` | `security-forget` | Asks Rust to forget the passphrase, from the keyring and from memory, with no confirmation, then reads the status again, so the row turns to "No passphrase is remembered. You will be asked each time." and the button goes. | `:143-146, 68-71` |
| "Security Mana" heading and explanation | "Mana is an advisory budget for plaintext exposure, not a security score. It never blocks anything, and it comes back with time. It is spent when you deliberately make encrypted content readable; encrypting never earns any. Each charge counts against today for 24 hours and against the week for 7 days." | `mana.title`, `mana.advisory`, `security.workspace.manaHow` | `security-mana` (section) | | `:151-153` |
| Two meters: "Today" and "This week", each "{left} / {max}" above a bar filled in proportion | "Today", "This week" | `security.workspace.meter.daily`, `.weekly` | `mana-meter-daily`, `mana-meter-weekly` | From Rust's `mana_status`, shared with every charge made anywhere in the app (see Security Mana). Absent when the status could not be read. | `:154-165, 73-80`; `mana.ts:47-57` |
| Exhausted warning (warn colour) | "Your exposure budget is used up. You can still go ahead; this is a warning, not a lock." | `mana.exhausted` | `security-mana-exhausted` | When either meter is at zero. | `:166-168` |
| Price table, one row per priced action in Rust's order | labels "Opened an encrypted file for editing", "Decrypted a file permanently", "Decrypted a folder permanently", "Exported an encrypted file as plaintext", "Added a plain-text tag to an encrypted file"; prices "5", "15", "15 + 5 per file, at most 100", "10", "3" | `mana.notes.*` for the labels, `security.workspace.pricePerItem` for a per-file price | `mana-prices` (table), `mana-price-{id}` (each price cell) | Read from Rust (`mana_prices`), so the numbers on screen are the numbers charged. The labels are the history's past-tense notes reused. | `:170-179`; `mana.rs:244-249` |
| "Recent security actions" heading and list | "Nothing yet." when empty; otherwise one row per ledger entry, newest first: the time, the note, the relative path beneath it when there is one, and the cost as "−15" (a minus sign) or "0" | `security.workspace.historyTitle`, `.historyEmpty`, `mana.notes.*` | `security-history` (section), `security-history-empty`, `security-history-{i}` (0-based) | The newest 100 ledger rows (`mana_ledger`). The time is `toLocaleString` in the app's current language (EN or PL), so it follows the header's language button. | `:183-199, 82-84` |
| "What encryption does not hide" (dashed box) | "Encryption protects the contents of a file. Its name, its folder, its size and dates, and any tags stay visible." then "Morion keeps tags and this history in .morion/metadata.json inside the workspace, in plain text. It never keeps a passphrase, decrypted contents or search results there." | `security.workspace.limitsTitle`, `shield.limits`, `security.workspace.limitsMore` | `security-limits` | | `:202-207` |

The view reads everything (counts, passphrase status, ledger, prices, meters)
when it is first mounted, every time it is shown again (App passes `active`,
true while the view is on screen), when the workspace changes, and whenever the
padlock cache is replaced: after any encryption or decryption from a shield,
after a folder run, and on any folder read in the Files panel, Refresh or
expanding a folder included (`WorkspaceSecurity.vue:41-66`; `App.vue:529-530`).
The one charge that can happen while the view is on screen is an export chosen
from the ☰ menu, which runs without leaving the view (see The ☰ menu): the
meters move at once, because the status is shared, but its history row appears
the next time the view is shown. The view does not poll either: meters that
regenerate while it stays on screen show it the next time it is shown.

Padova's `security.title`, `security.intro`, `security.files.*` and
`security.secret.held` strings belong to its own Security view, which Morion
no longer mounts, and are rendered nowhere; the passphrase row uses Morion's
own `security.workspace.secretHeld` with padova's storage and "none" sentences.
In the browser build the shield that opens this view shows only with a stale
`zinnia:workspace`; the view then reads nothing, so it shows the name, the
"where" line, "No passphrase is remembered. You will be asked each time.", the
explanation, "Nothing yet." and the limits, with no counts, meters or prices.

## The Write editor

`apps/morion/src/editors/DocumentEditor.vue`, mounted by
`EditorHost.vue:621-635` when the kind is `document`: the bytes sniff as
`<document …>`, or New document was chosen. An encrypted document opens here
too: the host decrypts it into memory first and the editor never knows (see
Encryption). A Cyprian document is an envelope (title, font, margins, contents
page, cover sheet) around a CDATA body. The body is edited in TipTap with
Cyprian's schema (`apps/morion/src/editors/cyprianSchema.ts`); the envelope
lives in the Page setup dialog.

The screen is one toolbar over a bordered, shadowed, transparent box
(`.cy-doc`, `max-w-3xl`, `p-10`) on a sunken desk (`bg-sunken-light` /
`dark:bg-sunken-dark`, `DocumentEditor.vue:424-434`). There is no paper
colour: `--cy-paper` (`apps/morion/src/document.css:33, 55`) is consumed
only by `.cy-page` (`:139-147`), which the editor never renders, so the "sheet"
shows the desk colour through it. Ink is fixed black in light mode and white
in dark mode (`.dark .cy-doc`, `document.css:53-60, 128`) regardless of the
app's text token, and dark mode swaps the border to `accent-1/40`. Every
icon-only toolbar control has a custom tooltip bubble drawn from `data-tip` on
hover or keyboard focus (`:focus-visible`, `apps/morion/src/style.css:59-85`)
plus the native `title`; the Editor/Source pill is the exception: its two
buttons are labelled by their visible text and have no tooltip, title or
aria-label (`DocumentEditor.vue:401-416`). No control uses the right-aligned
`oya-tip-end` variant (`style.css:87`), so the Page setup bubble is centred and
can be clipped at the window's right edge. The toolbar wraps onto further rows
when the window is narrow (`flex-wrap`, `:319`). Any host `fileError` shows as
a warn line above the toolbar (`DocumentEditor.vue:303-305`;
`EditorHost.vue:629`): "Could not save. …" after a failed write, but also
"Could not open the file. …" or the no-workspace message when an Open…
attempted from this document fails, or the sentence of a permanent decrypt
that failed from the file shield. It stays until the next Open, Save or
file-shield action clears or replaces it, or another file mounts.

### Toolbar, left to right

Groups are separated by thin vertical dividers. Bold, Italic, Underline, the
two lists, Quote and Code block show their active state as a
primary-background fill (`OyaIconButton.vue:28`), while the heading and
callout buttons fill with accent and dim to 60% when inactive
(`DocumentEditor.vue:339, 374`).

| Control | Icon | Label (`data-tip`, title, aria-label) | Key | `data-testid` | Does | Source |
|---|---|---|---|---|---|---|
| Undo | `rotate-left` | "Undo" | `doc.undo` | none | TipTap undo. Never disabled. | `DocumentEditor.vue:320` |
| Redo | `rotate-right` | "Redo" | `doc.redo` | none | TipTap redo. | `:321` |
| Bold | `bold` | "Bold" | `doc.bold` | none | `toggleBold`; highlighted while active. | `:324-325` |
| Italic | `italic` | "Italic" | `doc.italic` | none | `toggleItalic`. | `:326-327` |
| Underline | `underline` | "Underline" | `doc.underline` | none | `toggleUnderline`. | `:328-329` |
| Heading 1, 2, 3 | `heading` plus a `1`, `2` or `3` glyph | literally "doc.heading": the button calls `t('doc.heading', {level})` but no such key exists in `en.ts` or `pl.ts`, and petalite's `createI18n` sets no missing handler | `doc.heading` (missing) | none | `toggleHeading({level})`. Accent-filled while the cursor is in a heading of that level, else 60% opacity. Levels 4 and up are not offered and the schema drops them. | `:334-343`; `cyprianSchema.ts:167` |
| Bulleted list | `list-ul` | "Bulleted list" | `doc.bulletList` | none | `toggleBulletList`. | `:346-347` |
| Numbered list | `list-ol` | "Numbered list" | `doc.orderedList` | none | `toggleOrderedList`. | `:348-349` |
| Quote | `quote-right` | "Quote" | `doc.quote` | none | `toggleBlockquote`. | `:350-351` |
| Code block | `code` | "Code block" | `doc.code` | none | `toggleCodeBlock`. | `:352-353` |
| Accent, Success, Warning ink | round swatches filled with `var(--sys-accent)`, `--sys-success`, `--sys-warning` (the Settings system colours) | "Accent", "Success", "Warning" | `doc.ink.accent`, `doc.ink.success`, `doc.ink.warn` | `ink-accent`, `ink-success`, `ink-warn` | Applies the `cyInk` mark (class `cy-ink-{ink}`) to the selection. No active state, and no toolbar control removes an ink. | `:360-365`; `cyprianSchema.ts:69` |
| Note, Warning, Tip, Quote callouts | `circle-info`, `triangle-exclamation`, `lightbulb`, `quote-left` | "Note", "Warning", "Tip", "Quote" | `doc.tone.note`, `.warn`, `.tip`, `.quote` | `tone-note`, `tone-warn`, `tone-tip`, `tone-quote` | `toggleWrap('callout', {tone})`: wraps the current block in a callout box (blue, orange, green 4px left rule with a matching tint; quote keeps the same 4px rule in grey, italic, no tint) or unwraps it. Accent-filled while inside a callout of that tone. Note that two controls read "Quote": this one and the blockquote button. | `:368-377`; `document.css:352-365` |
| Formula | `square-root-variable` | "Formula" | `doc.formula` | `doc-formula` | Opens the Formula dialog. | `:380-381` |
| Table | `table` | "Table" | `doc.table` | `doc-table` | Opens the "Insert a table" dialog. | `:382-383` |
| Page break | `scissors` | "Page break" | `doc.pageBreak` | none | Inserts a `pageBreak` node. It occupies no space on screen (`document.css:380`); only Source view shows the `<div class="cy-pagebreak">`. | `:384-385` |
| New block below | `square-plus` | "New block below" | `doc.blockAdd` | `blk-add` | Inserts an empty paragraph after the top-level block under the cursor and moves the cursor into it. | `:388-389, 107-115` |
| Move block up | `arrow-up` | "Move block up" | `doc.blockUp` | `blk-up` | Swaps the top-level block with the one above; no-op on the first. | `:390-391, 77-92` |
| Move block down | `arrow-down` | "Move block down" | `doc.blockDown` | `blk-down` | Swaps with the one below; no-op on the last. | `:392-393` |
| Delete block | `trash` | "Delete block" | `doc.blockDelete` | `blk-del` | Deletes the top-level block. The only block is reset to one empty paragraph instead: a document is never empty. That reset goes through `setContent` without `emitUpdate`, so it does not update the dirty flag (deleting one of several blocks does). | `:394-395, 94-105` |
| (spacer) | | | | | | |
| Editor | `pen-nib` + "Editor", left half of a two-view pill | | `doc.viewEditor` | `view-wysiwyg` | Switches to WYSIWYG. Coming from Source, the textarea's HTML is applied through TipTap's schema (`setContent`, `:131`), so markup the schema does not know (`<script>`, `h4`, style attributes) is silently dropped. TipTap 2's `setContent` defaults to `emitUpdate = false` (`@tiptap/core` 2.27.3, `dist/index.js:2515`), so this switch does NOT run the dirty check, whatever the comment at `:132` says: the dropped markup, and any typing done in the Source textarea, leaves the dirty flag as it was until the next WYSIWYG edit or Page setup change. Ctrl+S still writes the current text regardless of the flag. | `:401-408, 126-135` |
| Source | `code` + "Source", right half | | `doc.viewSource` | `view-source` | Shows the body as raw HTML in a monospace textarea (`doc-source`) inside the same sheet; the WYSIWYG surface is hidden with `v-show`. Switching never saves. | `:409-416, 436-439` |
| Page setup | `gear` | "Page setup" | `doc.pageSetup` | `doc-setup` | Opens the Page setup dialog. | `:419-420` |

Block operations act on the top-level ProseMirror node under the cursor, so a
whole table, list or callout counts as one block.

The schema accepts more than the toolbar offers. Links open on neither click
nor Ctrl-click and are never auto-linked (`cyprianSchema.ts:170`); images,
including base64 `data:` sources, are kept from Source view or pasted HTML but
there is no insert, paste-file or drop handler (`:171`); the `cy-size-sm` /
`cy-size-lg` text-size mark (`:25, 70`; `document.css:303-304`),
strikethrough, inline code and horizontal rules survive a round trip but can
only be produced by keyboard shortcut, input rule or Source view.
`CyHighlight` (`:154`) is an empty extension and does nothing.

While Source is open every other toolbar button (formatting, headings, inks,
callouts, Formula, Table, Page break, block operations) still runs against the
hidden WYSIWYG editor and refocuses it (`chain()` is
`editor.chain().focus()`, `DocumentEditor.vue:223`); switching back to Editor
replaces that document with the textarea's HTML (`:131`), so those actions are
silently lost. Only Page setup and the view pill take effect in Source view.

### The sheet

`data-testid="doc-body"` is the TipTap `EditorContent`
(`DocumentEditor.vue:424-441`); `data-testid="doc-source"` is the Source
textarea (spellcheck off, min-height 60vh, vertically resizable). While Source
is open, Ctrl+S writes the textarea text, not a stale WYSIWYG body
(`:147-152`).

The body carries class `cy-body`, not `cy-content`, and `document.css` styles
blockquotes, code blocks, tables, images and horizontal rules only under
`.cy-content` (`document.css:231-242, 254-285, 308-338, 372-376`), which the
PDF path alone emits (`pdf/documentHtml.ts:88`); nothing styles `.cy-body`. In
the editor a Quote has no left rule or italics, a Code block has no block
background (each `<code>` inside gets only the inline-code chip from `.cy-doc
code`, `:209-215`), an inserted table has no cell borders or header shading,
an `<hr>` is Tailwind preflight's bare line, and `data-width`/`data-align` on
images are ignored. Headings use the larger `.cy-doc` sizes (2em / 1.5em /
1.22em, `:173-175`), lists get disc and decimal markers (`:201-206`), and
callouts, formulas, inks and page breaks look as described because their
selectors are unscoped (`:299-304, 342-365, 380`).

The TipTap surface draws no focus ring: `style.css:95-98` removes
ProseMirror's, and the accent replacement at `:99-103` targets only the deck's
`.rich-payload`. Every toolbar button returns focus to the body after acting
(`DocumentEditor.vue:223`), so the caret is the only sign of where typing
goes.

A new document is one empty paragraph. The Placeholder extension is configured
with "Write…" (`doc.placeholder`) but no stylesheet renders
`data-placeholder` for this editor, so an empty document looks blank.

Dirty is computed by comparing the re-serialised document (envelope plus
current body) with the last opened or saved serialisation
(`DocumentEditor.vue:137-161, 186-189`). Opening never marks dirty; Page setup
changes do. Typing in the Source textarea does not: `touch()` is only wired to
TipTap's `onUpdate` and to Page setup (`:159-161, 178, 186-189`), and nothing
watches `sourceText`, so a document edited only in Source view stays reported
as clean (the host will discard it without asking) until the next WYSIWYG
keystroke or envelope change. Ctrl+S and the menu's Save As still write the
textarea text (`:147-152, 283`), but for a file that already has a path the
menu's Save stays greyed and the header dot stays clear until then.

### Page setup dialog

`DocumentEditor.vue:445-488`, an `OyaModal` (overlay
`data-testid="oya-modal-overlay"`) that closes on backdrop click or its Close
button. Escape does nothing. Changes apply live. The dialog has no card
surface: its controls sit in a bare `max-w-sm` div directly over the 70% black
backdrop (`DocumentEditor.vue:446`; `OyaModal.vue:35`), unlike the Insert a
table and Formula dialogs, which draw on a bordered `ModalPanel` card
(`CsvTableModal.vue:116`, `DocumentEditor.vue:493`,
`packages/petalite/src/components/ModalPanel.vue`).

| Control | Text | Key | `data-testid` | Effect | Source |
|---|---|---|---|---|---|
| Heading | "Page setup" | `doc.pageSetup` | none | | `:447` |
| Title field | "Title" | `doc.title` | `doc-title` | Sets the envelope title; marks dirty. No visible effect on the sheet. | `:449-451` |
| Font | five small buttons showing the raw values `sans`, `serif`, `mono`, `rounded`, `condensed` (not translated); label "Font" | `doc.font` | none | Sets the envelope font and changes the sheet's font family at once through `cy-font-{f}`. Default `serif`. | `:453-459`; `document.css:108-122` |
| Margins | three buttons `normal`, `narrow`, `wide` (raw values); label "Margins" | `doc.margins` | none | Persisted in the file, but changes nothing on screen: `data-margins` only drives `--cy-margin-*`, which `.cy-page` consumes and the editor sheet does not use. | `:461-467`; `document.css:95-96, 139-147` |
| Contents page | checkbox | `doc.toc` | `doc-toc` | Sets `toc` in the envelope. No effect on the sheet. | `:469-473` |
| Cover sheet | checkbox | `doc.cover` | none | Sets `cover`. No effect on the sheet. | `:474-478` |
| Outline count | "{n} heading(s) in the outline" | `doc.outlineCount` | none | Shown only when the body has at least one non-empty h1 to h3. The count is evaluated the first time Page setup opens and never again: the computed reads a non-reactive `shallowRef` editor and `getHTML()` (`DocumentEditor.vue:55, 196`), so headings added or removed afterwards do not change it, and a document with no headings at first open never shows the line. | `:480-482`; `document.ts:330-349` |
| Close | "Close" | `common.close` | none | Closes. | `:484-486` |

Title, Contents page and Cover sheet are stored in the file but never visibly
used, because the PDF path that would consume them is not reachable.

### Insert a table dialog

`apps/morion/src/editors/CsvTableModal.vue:115-191`, opened from
`DocumentEditor.vue:490`. Titled "Insert a table" (`doc.csvTitle`). Text,
separator, header choice and error reset each time it opens. Closes on Cancel,
Insert table, or backdrop click; Escape does nothing.

| Control | Text | Key | `data-testid` | Does | Source |
|---|---|---|---|---|---|
| Intro | "Paste rows from a spreadsheet, or load a .csv file." | `doc.csvIntro` | none | | `CsvTableModal.vue:117` |
| CSV textarea | placeholder "name,quantity" / "Widget,3" | `doc.csvPlaceholder` | `csv-input` | Parsed live with petalite's `parseCsv` using the chosen or sniffed delimiter. | `:119-125, 55-60` |
| Load file… | | `doc.csvLoadFile` | `csv-load` | Native open dialog, starting in the workspace root, filtered to `csv`, `tsv`, `txt`. The pick is read through Rust (`workspace_read_text`), so the workspace boundary holds, and its text replaces the textarea. A Rust refusal lands in the error line as its sentence, for example "That path is outside the workspace.", "That file is encrypted." or, with no workspace open, "Choose a workspace folder first."; any other failure, including no Tauri, as its raw text. Cancelling the dialog changes nothing. | `:128-130, 82-105` |
| Separator select | options "Detect", "Comma", "Semicolon", "Tab" | `doc.csvDelimiter`; `doc.csvAuto`, `doc.csvComma`, `doc.csvSemicolon`, `doc.csvTab` | `csv-delimiter` | Empty value means the sniffed delimiter; a choice overrides parsing. | `:132-143, 48-53` |
| First row is a header | checkbox, default on | `doc.csvHeaderRow` | `csv-header` | Row 0 becomes `tableHeader` cells, shown bold in the preview. | `:145-148` |
| Error line (warn colour) | the load error | `workspace.errors.*` for a refusal | `csv-error` | Shown when Load file… failed; cleared when it is pressed again. | `:151` |
| Preview | "Separator: {d}", "{rows} rows × {cols} columns", an 8 by 8 excerpt, "…and {rows} more rows, {cols} more columns" | `doc.csvDetected`, `doc.csvSize`, `doc.csvMore` | `csv-preview` | Visible once anything parses. The separator line always reports the SNIFFED delimiter, even after the select overrides it; a sniffed tab is printed as the word "tab" (`:157`). Preview cells are clipped at 12rem with an ellipsis (`:167`); the CSV textarea is six rows tall (`:122`). The "more" line appears only when something is hidden. | `:155-176` |
| Too big | "That is too large to insert — the limit is 200 rows and 50 columns." | `doc.csvTooBig` | `csv-too-big` | Rows over 200 or first-row columns over 50 disable Insert rather than truncating. | `:178-180, 36-37` |
| Cancel | | `common.cancel` | none | Closes without inserting. | `:183-185` |
| Insert table | | `doc.csvInsert` | `csv-insert` | Inserts ONE table node at the cursor, padding every row to the widest row with empty cells, as a single undo step, then closes. Disabled unless at least one row parsed and not too big. Tables are not resizable and the toolbar has no row or column controls. | `:186-188`; `DocumentEditor.vue:230-248` |

### Formula dialog

`DocumentEditor.vue:492-502` with
`apps/morion/src/components/FormulaPreview.vue`. Titled "Formula"
(`doc.formula`). Closes on Cancel, a successful Save, or backdrop click; Escape
does nothing.

| Control | `data-testid` | Does |
|---|---|---|
| LaTeX field (monospace), placeholder `e^{i\pi}+1=0` (a literal, not i18n) | `formula-input` | Enter confirms. |
| Preview box (dashed), headed "Preview" (`common.preview`) | `formula-preview` | Live KaTeX rendering with `throwOnError: false`, so partial input renders what it can with errors in red. "Nothing to show yet." (`common.previewEmpty`) while empty; "Could not render this." (`common.previewFailed`) only if KaTeX itself fails. |
| Cancel (`common.cancel`) | none | Closes. The typed LaTeX is kept for the next open; only a successful insert clears it. |
| Save (`common.save`) | none | Renders with KaTeX and inserts a block formula node (`data-latex` plus cached rendering) at the cursor, then closes and clears the field. Empty input is a silent no-op and the dialog stays open. The inserted formula is an atom: it cannot be edited in place, only deleted and re-inserted. |

### Refusal panel

`DocumentEditor.vue:308-315`. Shown when `loads()` threw on non-empty text,
for example a `.xml` whose head sniffs as `<document` but is malformed. A
warning icon, "This is not a Cyprian document" (`doc.notADocument`), the parser
message ("Invalid document: …" or "Expected root <document>, found <x>",
`document.ts:121-126`) at `data-testid="doc-parse-error"`, and "Open as plain
text" (no test id on this button). Ctrl+S is still listened for here and would
emit a fresh empty document's serialisation, so do not press it.

### Shortcuts and exports

Ctrl+S / Cmd+S is a window listener (`DocumentEditor.vue:265, 277-285`) gated
only on the host's `busy` and the editor's `active` flag; it is NOT gated on
the focus target, so it fires from inside the CSV textarea and the formula
field too. TipTap's own keymaps apply inside the body: Mod-Z / Mod-Shift-Z /
Mod-Y undo and redo; Mod-B, Mod-I, Mod-U; Mod-Shift-S strikethrough and Mod-E
inline code (marks with no toolbar button and no document.css rule); Mod-Alt-1
to 3 and Mod-Alt-0 back to a paragraph; Mod-Shift-8 and Mod-Shift-7;
Mod-Shift-B; Mod-Alt-C; Shift-Enter or Mod-Enter for a line break (Mod-Enter
also leaves a code block, as does a third Enter or Down at its end); Mod-A
selects all; in a list Enter splits, Tab indents and Shift-Tab outdents an
item; in a table Tab and Shift-Tab move between cells, Tab in the last cell
appends a row, and Backspace or Delete with every cell selected deletes the
table (`cyprianSchema.ts:164-175`; TipTap 2.27.3 defaults). Markdown-style
input rules also fire as you type at the start of a line (`# `, `## `,
`### `, `- `, `1. `, `> `, three backticks or tildes, `---` for a horizontal
rule) and inline (`**bold**`, `*italic*`, backticked code, `~~strike~~`,
`![alt](src)`). Dragging a block shows a drop cursor and a gap cursor lets the
caret sit before or after a formula, page break or table. The editor offers no
exports; there is no PDF entry.

The only thing this editor persists is the `.xml` file itself: `<document
version="3" title font margins toc cover>` around the CDATA body
(`document.ts:79-109`). Opening a v1 or v2 file converts its `<section>`s to
h1 to h3 plus body and its v1 `<block>`s to HTML (`document.ts:156-157,
180-199, 248-315`); the baseline is taken after conversion, so the file is not
dirty, but the first save rewrites it as version 3. A `<document>` without a
`toc` attribute opens with Contents page CHECKED (`:140`); an unknown font or
margins value falls back to `serif` / `normal` and the title is cut to 400
characters on load only (`:171-175`); the body is truncated at 8 MiB (`:36,
155, 164`). `<meta>` fields and unknown root attributes or child elements are
preserved through a save (`:95-106, 128-131, 148-161`).

## The Presentations editor

`apps/morion/src/editors/PresentationEditor.vue`, mounted by
`EditorHost.vue:637-651` when the kind is `deck` (`src/files/openWith.ts:31,
87`): a `.pxml`, any file whose bytes sniff as `<presentation …>`, or New
presentation. An encrypted deck opens here too, decrypted into memory first.
A deck is an ordered list of slides; a slide has a title, a LAYOUT (a fixed
set of named boxes called slots) and typed blocks placed in those boxes.
Nothing is dragged or resized.

The screen is a toolbar, a filmstrip on the left, and the current slide's
boxes on the right. Blocks are edited in a modal, the deck's title, theme and
font in a settings modal, and "Present" opens a full-window reveal.js player.
An empty or whitespace-only file opens as a new one-slide deck, not as an error
(`PresentationEditor.vue:95`; `presentation.ts:184-194`). A version-1 deck
shows each slide's non-empty body as a single `html` block (a slide with an
empty or missing `<body>` opens with no blocks, `presentation.ts:394`) and is
written back in v2 form on the first save (`presentation.ts:282-285,
377-406`). A host file error (an open that failed, a save that failed, a
permanent decrypt that failed, or no workspace) shows as a warn strip above
the toolbar (`:375-377`; `EditorHost.vue:288, 351, 453, 472, 503, 523`).

### Toolbar

| Control | Icon | Label | Key | `data-testid` | Does | Disabled when | Source |
|---|---|---|---|---|---|---|---|
| New slide | `file-circle-plus` | "New slide" | `deck.addSlide` | `add-slide` | Inserts a slide with the default layout (`title-content`) and one empty text block AFTER the current slide, and selects it. | never | `PresentationEditor.vue:391-392, 108-115` |
| Delete slide | `trash` | "Delete slide" | `deck.deleteSlide` | none | Removes the current slide; selection moves to the previous slide, or stays on the first position (the slide that was second) when the first slide is deleted. A deck is never emptied. | fewer than 2 slides (40% opacity) | `:393-394, 117-121` |
| Move slide back | `arrow-left` | "Move slide back" | `deck.moveBack` | none | Swaps with the earlier slide, keeps it selected. Silent no-op on the first slide. | never | `:395, 123-131` |
| Move slide forward | `arrow-right` | "Move slide forward" | `deck.moveForward` | none | Swaps with the later slide. Silent no-op on the last. | never | `:396` |
| (divider) | 1px vertical rule | | | none | Separates the slide buttons from the Layout group. | | `:397` |
| "Layout" label and dropdown | | shows the current layout id | `deck.layout` | `layout-select` (wrapper); inside it `select-trigger`, `select-panel`, `select-option-{layout}` | A petalite `SelectMenu`. Options in order: `title-content`, `section`, `quote`, `full-bleed`, `two-column`, `three-column`, `image-left`, `image-right`, `two-row`, `grid`, `lead` (raw ids, not translated). The trigger shows the value plus a `chevron-down` and carries `aria-haspopup="listbox"` / `aria-expanded`; the panel is a `role="listbox"` that scrolls past 15rem, with the current option bold in the accent colour and `aria-selected`. Picking the current value just closes the list, with no mutation, so the deck does not go dirty (`SelectMenu.vue:29-32, 37-71`). Blocks are never lost on a layout change: one whose slot the new layout lacks is shown in the first box and keeps its old slot in the file. Closes on option click, backdrop click, or Esc. | never | `:399-405, 137-141`; `presentation.ts:32-45, 142-145`; `packages/petalite/src/components/SelectMenu.vue:36-73` |
| Present | `play` | "Present" | `deck.play` | `deck-play` | Opens the player starting at the current slide. | never | `:407-408, 321-324` |
| (spacer) | | | | | | | |
| Slide counter | text "{current+1} / {count}" | | | `slide-counter` | Read-only. | | `:411-413` |
| Deck settings | `gear` | "Deck settings" | `deck.settings` | `deck-setup` | Opens the Deck settings modal. | never | `:414-415` |

Opening always selects slide 1 (`:100`); a Save As rename is deliberately
ignored (`:357`). The toolbar wraps onto more lines on a narrow window
(`:390`). Every icon button carries its label as aria-label, native tooltip
and `.oya-tip` bubble (`OyaIconButton.vue:24-25`).

### Filmstrip and canvas

The canvas column scrolls vertically; its content is centred and at most
56rem wide (`:433-434`).

| Element | `data-testid` | Behaviour | Source |
|---|---|---|---|
| Filmstrip buttons "{n}. {title}" or "{n}. (untitled)" (`deck.untitledSlide`) | `filmstrip-{index}`, 0-based | Selects that slide. The current one has an accent border and bubble background; others sit at 60% opacity and rise to full opacity on hover. Fixed 10rem column, scrolls vertically. | `:420-430` |
| Slide title field, placeholder "Slide title" (`deck.slideTitle`) | `slide-title` | Edits the slide's `<title>`; every keystroke is a mutation. | `:435-437, 133-135` |
| Slot boxes, one dashed box per slot, side by side | none; each carries `data-slot="{slot}"` | Named slots have a tiny uppercase caption; the unnamed slot has none. The grid has as many columns as the layout has slots. | `:439-444, 104-105` |
| Block card (rendered preview via `SlideBlock`, plus the type name in monospace) | `block-{blockId}` | A preview of the block's content in the app's own font and colours, NOT the presented look: the canvas never wraps blocks in `.memo-slide`, so the deck's theme, font, 44px base size, uppercase headings, the code background and the quote rule from `slide.css` apply only in the player (`slide.css:36-58, 96-115, 121-192, 411-457`; the class is used only in `DeckPlayer.vue:105`). Layout, scale (`--memo-block-scale`) and the image/svg sizing rules do apply. A control row above it is invisible until the card is hovered; the row is only transparent, not removed (`:449`), so its buttons stay in the tab order and can be pressed from the keyboard while invisible. | `:446-465` |
| Edit (`pencil`, "Edit", `deck.editBlock`) | `edit-{blockId}` | Opens the Block editor modal. | `:451-452` |
| Move up / Move down (`arrow-up`, `arrow-down`; `deck.moveUp`, `deck.moveDown`) | none | Moves the block one place in the slide's block order (global across slots; visually within its box). No-op at the ends. | `:453-456, 241-250` |
| Slot dropdown (a `SelectMenu` showing the block's slot name) | `select-trigger`, `select-panel`, `select-option-{slot}` inside the card (these ids are shared with the toolbar's layout dropdown; scope a query through `layout-select` or the `block-{blockId}` card) | Moves the block to another box of the current layout. Rendered only when the layout has more than one slot. Its aria-label is the MISSING key `deck.slot`, so assistive tech reads "deck.slot". For a block whose slot the layout lacks the trigger reads `—` (slot "") or the old slot's raw name (for example `media` on `two-column`) while the block sits in the first box; the list offers only this layout's slots, so the shown value is not among the options until one is picked (`SelectMenu.vue:27`; `presentation.ts:142-145`). | `:457-460, 252-257` |
| Delete block (`trash`, "Delete block", `deck.deleteBlock`) | none | Removes the block immediately, no confirmation. | `:461-462, 234-239` |
| Add-block chips at the bottom of every slot box: nine 7 by 7 icon buttons | `add-{type}-{slot}`, with the unnamed slot spelled `main` (for example `add-text-main`, `add-image-left`) | `heading` "Heading", `align-left` "Text", `list-ul` "List", `image` "Image", `pencil` "Drawing", `code` "Code", `quote-left` "Quote", `square-root-variable` "Formula", `file-code` "HTML" (`deck.blockTypes.*`). Appends a block of that type in that slot: a text block starts as `<p></p>`, a list with one empty item, everything else empty. Chips sit at 50% opacity until hovered and carry `title`, `aria-label` and `data-tip`. | `:467-478, 144-152, 267-277` |

The canvas arrangement is only a hint. Every layout is drawn on the canvas as
N equal columns side by side (`:439-440`), whereas the player stacks `two-row`
(top over bottom), draws `grid` as a 2×2 (a b / c d) and stacks `lead` over
`body` with the lead box centred at 2.6em bold; `image-left` and `image-right`
give the media box the wider (1.15fr) column with its content centred;
`full-bleed` drops the slide padding and stretches an image block to cover the
whole slide (`slide.css:238-305, 328-347`).

How `SlideBlock` (`apps/morion/src/editors/SlideBlock.vue:31-116`) draws
each type, in both the editor and the player: `heading` is h1, h2, h3 or h4 by
`attrs.level` (1, 3, 4; anything else h2); `text` is rich HTML; `list` is
`<ol>` when `attrs.ordered` is "true", else `<ul>`; `image` is an `<img>` (nothing
when the payload is empty) with `alt` from `attrs.alt` and `data-fit` from
`attrs.fit` (default `contain`); `svg` is the markup inline (or in a shadow
root, see Settings), as `role="img"` with `aria-label` from `attrs.alt`;
`code` is an escaped `<pre>`, never rendered as markup, carrying
`attrs.language` as `data-language` without any highlighting; `formula` is the
cached KaTeX render when the block has one, else the LaTeX source in `<code
class="memo-formula-source">`; `quote` is a `<blockquote>` plus a `<cite>`
when `attrs.cite` is set; `html` is rendered live (both surfaces pass
`trust-html`, so the untranslated placeholder "Legacy HTML slide" is
unreachable); an unknown type shows its type name. Every block carries
`data-type` and `data-block-id`. `attrs.scale` (for example "auto:0.80" or
"1.2") sets `--memo-block-scale`. `slide.css` also ships memo's editor
affordances (`.memo-editing` focus rings, overflow markers, placeholders, drag
handles, `.memo-stage`, `.memo-print`, `[data-unknown]`, `slide.css:462,
499-633`); this editor sets none of those classes, so there is no
drag-and-drop, no overflow warning and no per-slide print pagination here.

Open silently truncates to 500 slides, 40 blocks per slide and 60 list items
(`presentation.ts:65-67, 310, 334, 362`); anything beyond is dropped from what
the editor shows and would be lost on save. Open also normalises: an unknown
theme or font shows as `black` / `sans` in Deck settings, an unknown layout as
`title-content` in the Layout dropdown, an unknown slot becomes the unnamed
slot, and a block or slide id that is malformed or repeated gets a fresh one;
all of these are written back on the first save. A file counts as version 2
when it says `version="2"` or contains any `<block>`; a v1 slide with an empty
`<body>` opens with no blocks. Elements the parser does not know (anything but
`<slide>` under the root, anything but `<title>`/`<block>` in a slide) and
unknown block attributes are invisible in the editor but survive a save
(`presentation.ts:120-130, 285, 301-302, 305-308, 329, 337-339, 347, 358,
394`).

Dirty is measured against the re-serialised deck (`:75-90`), so opening never
marks dirty and undoing an edit by hand returns to clean.

### Block editor modal

Opened by Edit on a block (`PresentationEditor.vue:489-535, 285-316,
154-232`). An `OyaModal` (backdrop click cancels) with a wide `ModalPanel`
whose title is the block's RAW type string ("text", "svg", "html"), not the
translated chip name. The body depends on the type:

| Type | Body | `data-testid` |
|---|---|---|
| `list` | One single-line text field per item, each with a trash icon button labelled "—" that removes the row, plus a secondary "+ item" button (`deck.item`) that adds a row. Items cannot be reordered; "+ item" appends an unfocused empty row; Enter in a row does nothing. Whitespace-only items are kept on Save; only exactly-empty ones are dropped (`:312, 492-496`). | none |
| `text`, `quote`, `html` | `RichPayloadEditor` (`apps/morion/src/editors/RichPayloadEditor.vue`): a TipTap field with buttons bold, italic, underline, a divider, bullet list, numbered list; active marks are accent-filled. No headings, code blocks, blockquotes or rules can be inserted from the buttons; the content area scrolls at 16rem. Opening a block here parses its payload into TipTap's schema and Save writes TipTap's serialisation back: tables, images, `<div>`/`<span>` wrappers, inline styles, classes and headings are dropped or flattened to paragraphs, so a legacy `html` block loses its markup the first time it is saved through this modal. An emptied field saves `<p></p>`, never an empty string (`RichPayloadEditor.vue:25-43`). | `block-rich`; `rich-bold`, `rich-italic`, `rich-underline`, `rich-ul`, `rich-ol` |
| `heading` | The same rich editor in inline mode: bold, italic, underline buttons only. | same |
| `image`, `svg` | A bordered "Import from file…" button (`deck.importFile`, icon `folder-open`; spinner and disabled while importing), an error line when the read fails, and a 6-row monospace textarea that stays editable so an `<img>` or SVG can be typed by hand. Under Tauri the import is the native dialog, starting in the workspace root, with a filter "SVG" (`svg`) or "Image" (`deck.blockTypes.image`; `png`, `jpg`, `jpeg`, `gif`, `webp`), and the pick is read through Rust (`workspace_read_text` for an svg, `workspace_read_bytes` for an image), so a file outside the workspace, an encrypted one or one over 64 MB is refused and the error line shows its sentence ("That path is outside the workspace.", "That file is encrypted.", "That file is too big to open here."); other failures show their raw text. In a browser it is a hidden `<input type="file">` (`.svg` or `image/*`). An svg import puts the file's text in the payload; an image import produces `<img src="data:…" alt="" />` with the image embedded, never a path. Clicking Import clears the error line first; cancelling the dialog changes nothing. A successful import replaces whatever the textarea held. Nothing is written to the block until Save, so Cancel discards the import. In the browser build the same file can be picked twice in a row and a read failure shows the literal `unreadable` (`:161-232`). | `block-import`, `block-import-error`, `block-payload` |
| `formula` | A 4-row monospace textarea holding LaTeX with a live `FormulaPreview` beneath ("Preview", "Nothing to show yet.", "Could not render this."). | `block-payload`, `formula-preview` |
| `code` | An 8-row monospace textarea. | `block-payload` |

Inside the rich field TipTap's defaults still apply: Mod-B, Mod-I, Mod-U,
Mod-Shift-S (strike-through) and Mod-E (inline `<code>`) toggle marks,
Mod-Shift-8 / Mod-Shift-7 toggle bullet / numbered lists, Mod-Alt-0 returns to
a paragraph, Shift-Enter or Mod-Enter inserts a line break, Mod-Z / Mod-Shift-Z
/ Mod-Y undo and redo, and typing `**x**`, `*x*`, `~~x~~`, backticked `x`,
`- ` or `1. ` at a line start converts as in the Write editor. Strike-through
and inline code therefore CAN be inserted even though they have no buttons,
and a heading block accepts a bullet list through `- ` or Mod-Shift-8 even
though its toolbar hides the list buttons (`RichPayloadEditor.vue:28-34, 64`).

Footer: secondary "Cancel" (`common.cancel`) discards the draft; primary
"Save" (`common.save`, `data-testid="block-commit"`) commits: list to items,
formula to payload plus a KaTeX render cached into the block (so exports keep
formulas), everything else to payload. For a formula the cached render comes
from the trimmed source while the payload keeps its whitespace; a blank
formula, or a KaTeX load failure, stores no render and the source shows
instead. Save on any non-list block also clears a `<render>` the file may
have carried for that block. Save is asynchronous and the modal stays open,
without a spinner, until KaTeX has loaded (`PresentationEditor.vue:295-316`).
The modal closes on commit. Escape does not close it. A formula block in a file
that has no `<render>` shows its LaTeX source until it is re-saved through this
modal.

### Deck settings modal

Opened by the gear (`PresentationEditor.vue:538-565, 326-331`). A narrow
(24rem) `ModalPanel`, unlike the block editor's 32rem one. Titled "Deck
settings" (`deck.settings`). "Title" (`deck.title`) over a text field
(`data-testid="deck-title"`, no placeholder) that edits the presentation title
the player header shows. "Theme" (`deck.theme`) over two toggle buttons
labelled with the raw ids `black` and `white`. "Font" (`deck.font`) over five
buttons `sans`, `serif`, `mono`, `rounded`, `condensed`. The chosen button is
accent-filled, the others at 60% opacity; the buttons carry no `aria-pressed`,
so the selection is conveyed by colour only. A primary "Close"
(`common.close`); the backdrop also closes. Every change applies at once and
marks the deck dirty.

### Presenting mode

`apps/morion/src/editors/DeckPlayer.vue:90-117`, mounted from
`PresentationEditor.vue:486` after Present. A fixed full-window overlay
(`z-50`) until closed.

* reveal.js and its stylesheet load on first Present (`DeckPlayer.vue:36-39`),
  so the stage is briefly blank. The player runs embedded and never touches
  the URL (`hash: false`, `embedded: true`, `:58, 62`). Only the current slide
  takes clicks (`slide.css:492`); links inside a slide are live (`:183-184`).
* Header text: the deck title, or "(untitled)" (`deck.untitledSlide`), one
  line, 70% opacity (`DeckPlayer.vue:93-94`).
* Close button (icon `xmark`, tooltip "Exit (Esc)", `deck.exitPlay`,
  `data-testid="player-close"`, bubble right-aligned with `oya-tip-end`):
  closes the player. The editor's selected slide is whatever it was; the player
  does not write its position back.
* The reveal.js stage: a 1280 by 720 logical slide scaled to the window, 4%
  margin, "slide" transition, on-screen arrow controls, a progress bar and the
  slide number as "current/total". It starts on the slide current in the
  editor. Each slide is a `.memo-slide` with the deck's theme and font classes
  and `data-layout`; the slide title is an `<h2 class="memo-title">` when set;
  blocks flow in one `.memo-flow` per slot. The backdrop colour follows the
  theme (`#191919` for black, `#fff` for white, `apps/morion/src/slide.css:36-58`).
* The `section` and `quote` layouts do not draw the slide title and centre
  their content; `full-bleed` draws the title over the bottom of the slide on a
  dark scrim in white (`slide.css:311-346`). The editor canvas shows the title
  field regardless.

Keys in the player: Esc closes it, captured on `window` before reveal sees it
(`DeckPlayer.vue:26-33, 69`), so Esc closes the whole player even while
reveal's overview or help overlay is up. reveal's own navigation (Right, L,
Down, J, Space, N, PageDown for next; Left, H, Up, K, P, Shift+Space, PageUp
for previous; Home or Shift+Left for the first slide, End or Shift+Right for
the last) works only after the stage has been clicked: the deck is `embedded`
with `keyboardCondition: "focused"`, and reveal starts an embedded deck
blurred and focuses it on a pointerdown, losing it again on a click outside
(reveal.js 5.2.1, `controllers/focus.js`); the on-screen arrows always work.
With the stage focused reveal also answers B, V, `.`, `/`, `;` (black pause
screen), F (fullscreen of the stage), G (reveal's jump-to-slide box), ? or F1
(reveal's help overlay), C (close that overlay) and O (slide overview), and
ignores every key while Ctrl or Cmd is held or focus is in an input or a
contenteditable (`controllers/keyboard.js`). Swiping on the stage also
navigates. The editor's own window listener keeps running during Present, so
PageUp and PageDown also move the editor's selected slide behind the overlay
and Ctrl+S still saves.

### Refusal panel

`PresentationEditor.vue:379-386`. Shown when the bytes fail to parse: "Invalid
presentation document: …" or "Expected root <presentation>, found <…>"
(`presentation.ts:273, 278-279`). A warning icon, "This is not a presentation"
(`deck.notADeck`), the parser message at `data-testid="deck-parse-error"`, and
a secondary button "Open as plain text" (`file.openAsText`, emits
`open-as-text`; no test id). The error strip still shows above it.

### Shortcuts and exports

One window listener (`PresentationEditor.vue:334-354`), inert while the editor
is not `active` and when focus is inside an `<input>` or `<textarea>`. Only
the save branch is muted while `busy` (the key is still swallowed with
preventDefault); PageUp and PageDown keep working during a save. TipTap's
contenteditable in the block modal is neither an input nor a textarea, so
PageDown there changes the slide behind the modal and Ctrl+S saves the deck
without the uncommitted draft. If PageUp or PageDown has moved the selected
slide while the modal is open, Save can no longer find the block on the
now-current slide and silently closes the modal, discarding the draft
(`:309-315`).

| Keys | Action |
|---|---|
| Ctrl+S / Cmd+S | Emits `save` with the current serialisation. |
| PageDown | Next slide, no wrap. |
| PageUp | Previous slide, no wrap. |
| Esc | Closes an open `SelectMenu`. Does not close the block or settings modal. |

The editor offers no exports. The `pdf.exportDeck` string never reaches the
menu.

The three markup-safety switches in Settings affect `svg` and `html` blocks in
both the editor canvas and the player, live, without reopening the file
(`SlideBlock.vue:47-51, 82-86, 105-110`; `apps/morion/src/security/useMarkupSafety.ts:54-72`).
See "Settings". `heading`, `text`, `quote` and every `list` item are also
injected as raw HTML from the file (`SlideBlock.vue:60-75, 99-103`), but none
of the three switches touches them: they are never scrubbed and never
isolated. Only `svg` and `html` payloads pass through `scrub` and
`ShadowHtml`.

## The Sheet editor

`apps/morion/src/editors/SheetEditor.vue`, mounted by
`EditorHost.vue:691-705` when the kind is `sheet`: a file whose bytes pass
`isSheet` regardless of extension (an encrypted one after decryption into
memory), or New spreadsheet. It mounts a Univer workbook
(`UniverSheetsCorePreset`, `en-US` locale) into
`data-testid="univer-host"` (`SheetEditor.vue:132-150, 302-304`). The ribbon,
formula bar, grid and sheet tabs are all Univer's; the only thing Morion
adds is the host's file error ("Could not open the file. …" / "Could not save.
…"), drawn as a small warn-coloured strip across the top of the editor's body,
above the grid or above either refusal panel (`SheetEditor.vue:280-282`), which
clears when the host clears `fileError`. The editor only takes the snapshot in
(`createWorkbook`) and out (`workbook.save()`). There is no loading indicator:
from mount until Univer's dynamically imported chunk and stylesheet arrive
(`SheetEditor.vue:132-137`; the first open of a sheet in a session is the slow
one) the editor area is simply blank. The ribbon, formula bar, context menus
and dialogs are always in English: Univer is built with the en-US pack only and
is never told about the header's PL/EN toggle, which affects only the refusal
panels and the menu entry (`:139-141`).

New spreadsheet does not arrive blank: the host seeds it with a serialised
`newWorkbook("untitled-sheet")` (`EditorHost.vue:100`), so it takes the ordinary
`loads` path like an opened file. The workbook is `wb-<8 random hex>`, name
"untitled-sheet", one sheet `sheet-1` named "Sheet1" with an empty tab colour,
100 rows by 26 columns, locale `enUS`, `appVersion 0.25.1` (`sheet.ts:16,
35-38, 41-64`). The editor's own blank-buffer branch (`SheetEditor.vue:108-109`,
seeding `newWorkbook(<name without extension> || "New sheet")`) is only
reachable if the host were told `sheet` with empty text, which no route does:
the router sends empty content to `code` (`openWith.ts:86-104`). Either way the
snapshot is baselined at once, so a new sheet is not dirty until edited.

Univer is created with `darkMode = isDark()` and `toggleDarkMode` is called on
every theme change, so a grid left open behind Settings switches theme with the
app; explicit cell fills from the snapshot are meant to stay as saved (Univer's
own dark theme recolours only its chrome and default surfaces;
`SheetEditor.vue:142-145, 155-161`).

Dirty is polled: every 1000 ms the editor serialises `workbook.save()` with
Python-style separators (`", "` and `": "`, so files round-trip byte-identical
with the Python side, except that a Python-written integral float such as
`1.0` comes back as `1`, `sheet.ts:109-139`; this cannot arise from an edit in
the grid, only from a hand-written or seeded file, and it shows up as changed
bytes on the next Save, not as a dirty dot) and compares it with the text as
of the last save (`SheetEditor.vue:90-96, 162-171`). The Save item can
therefore lag an edit by up to a second. The baseline is Univer's normalised
snapshot, so an opened sheet is not dirty until edited. After a successful
save the baseline is taken from the grid as it is THEN, not from the text that
was written (`:261-265`), so an edit made during the write itself is counted
as saved and the dot does not reappear for it. A Ctrl+S before the grid has
mounted saves the pending snapshot, never an empty file (`:61-65, 83-88`).
Save As only renames; the grid is not remounted and its undo history survives
(`:219-220`).

### Refusal panels

| Panel | When | Contents | `data-testid` | Source |
|---|---|---|---|---|
| Not a sheet | content non-empty and `isSheet()` false. Unreachable in practice: the router (`openWith.ts:86-89`) only answers `sheet` when the bytes pass `isSheet`, and New (`EditorHost.vue:100`) seeds a valid workbook | warning icon, "This is not a spreadsheet" (`sheet.notASheet`), "The file is JSON, but not a Univer workbook. Open it as plain text to see what it holds." (`sheet.notASheetBody`), "Open as plain text" | `sheet-open-text` (the button) | `SheetEditor.vue:110-112, 284-291` |
| Grid failed | the container never got a non-zero box within 60 animation frames ("The grid has no room to draw here.", `sheet.noRoom`, which can happen if the editor view is hidden while the file is opened), or Univer threw (its message) | warning icon, "The grid could not start" (`sheet.gridFailed`), the message in small monospace, "Open as plain text" | `sheet-mount-error` (the message); the button has no test id | `:127-130, 172-174, 181-190, 293-300` |

`univer-host` stays in the DOM (hidden with `v-show`) behind either panel
(`:303-304`). On unmount the poll and theme watcher stop and Univer is disposed
inside a try/catch, so a grid that will not dispose never blocks opening the
next file (`:207-217`).

### Export

"Export sheet as CSV…" (`sheet.exportCsv`, icon `file-csv`) is the editor's
one export (`SheetEditor.vue:274`), rendered in the ☰ menu as `menu-export`
while this editor is mounted and disabled while the host is busy
(`App.vue:379-388`); the command itself is `SheetEditor.vue:228-259`. It
takes the ACTIVE worksheet only: computed values from Univer's facade
`getActiveSheet().getDataRange().getValues()` when the grid is up, else
`sheetOrder[0]` of the pending snapshot. The CSV
(`apps/morion/src/formats/csv.ts`) is RFC 4180: fields quoted only when they
contain a comma, double quote, CR or LF, embedded quotes doubled, CRLF between
records, no trailing newline, computed `v` never the formula `f`. In the
snapshot fallback a merged range writes its value into the top-left cell and
blanks the rest, and the extent is the highest row and column that has any
cell, so empty rows between populated rows are kept but nothing after the last
populated one is emitted (`csv.ts:82-98, 119-141`); when the grid is up the
rows are the facade's `getDataRange().getValues()` written as returned, with
no merge or extent handling of Morion's own (`csv.ts:110`). Under Tauri it
opens the native save dialog with `defaultPath` "<stem>.csv" (stem is the name
minus a trailing `.json`, or "sheet") and a single "CSV" filter, then
`writeTextFile`; cancel does nothing. Unlike Save As, the dialog does not open
in the workspace (`defaultPath` is the bare file name, so it opens wherever the
OS last was), and the write goes straight through the Tauri fs plugin rather
than the Rust workspace boundary (`:256-257`), so a CSV can be written anywhere
the dialog allows and needs no workspace to be open (the entry is never
disabled for lack of one). In a browser it downloads a `text/csv` blob named
"<stem>.csv" with no dialog. The command answers whether it wrote a file:
`true` after the write (or the download), `false` when the dialog was cancelled
or there was nothing to export (`:231, 248, 255, 258`). The menu uses that
answer only for Security Mana: from an encrypted workbook the Mana confirmation
for a plaintext export (10) comes first, and the charge follows only a written
file (`App.vue:225-241`). A successful write shows no "Saved" notice. A failed
write (a read-only folder, say) is not caught by the editor: the menu's handler
catches it and the header shows "Could not export." (`file.exportFailed`)
followed by the error's own text in its `export-error` line, and nothing is
charged (`App.vue:225-246`). The entry stays in the menu while a refusal panel
is up: on the not-a-sheet panel it writes nothing (no dialog, no message, since
`pending` was never set, `:110-112, 116, 229-231`), after the Mana confirmation
if the file is encrypted, and costs nothing; on the grid-failed panel it still
exports the first sheet of the snapshot that was read. Styles, other sheets and
formulas are lost; the open file and its dirty state are untouched.

### Shortcuts

Ctrl+S / Cmd+S is a window listener (`SheetEditor.vue:192-200`, busy gate at
`:98-101`): it works anywhere in the editor view, including with focus in
Univer's grid, and is inert behind Workspace security and Settings and while
busy. It is not gated on the focus target, so it also fires from the files
sidepanel's search box, from the passphrase, folder and tag dialogs' fields and
from inputs inside Univer's own dialogs. Nor is it gated on
dirty: Ctrl+S on an unchanged sheet writes the file again and shows "Saved".
It stays live on both refusal panels: on the not-a-sheet panel it writes the
original bytes back unchanged; on the grid-failed panel it writes the
re-serialised snapshot, which may normalise the file's whitespace without any
edit having been made (`:83-88`). Univer's own shortcuts apply inside the
grid.

## The Drawing editor

`apps/morion/src/editors/SketchEditor.vue`, mounted by
`apps/morion/src/views/EditorHost.vue:673-687` when the kind is `sketch` (a
`.svg`, `files/openWith.ts:44`, or New drawing; an encrypted `.svg` opens here
too, decrypted into memory first). The toolbar and canvas come from wisteria
(`packages/wisteria/src/components/SketchToolbar.vue`, `SketchCanvas.vue`) over
the `useSketch` model (`packages/wisteria/src/useSketch.ts`). It is a single-board vector editor
whose board size is the file's own `viewBox`, or, when that is absent or
invalid, its numeric `width`/`height` attributes, or 1920 by 1080 when neither
is usable, clamped to 1 to 6480 per axis
(`packages/wisteria/src/svgDocument.ts:329-349`); an empty buffer opens as a
fresh 1920 by 1080 board.

Nothing in this editor is persisted outside the file: zoom, tool, colours,
sticky and the undo history are session-only and die with the component. Only
shapes, board colour and background image mark the file dirty; changing the
tool, zoom, pen colour, width, opacity, fill, head width or sticky does not
(`SketchEditor.vue:115-121`). The default tool on open is Draw, not Select
(`:177`).

Above the toolbar: a warn line for a host file error (`:260-262`). Below it,
only when there is something to say: a one-line strip with a grey notice
("Saved." after a PNG export) or a red local error (background-image import
failures or an export exception) (`:289-292`). The strip persists until the
next PNG export or background-image pick clears it; drawing, saving or
changing tools does not (`:146, 161-162`). Then, when the opened file had
parts the model cannot represent, a grey info line "{n} parts of this file
can't be edited here — they'll be kept exactly as they are."
(`sketch.opaqueNotice`, `data-testid="svg-opaque-notice"`, `:298-301`). Such
nodes are kept as parsed DOM and re-serialised on save with `XMLSerializer`
(`svgDocument.ts:369-378`), structurally identical but not byte-identical
(quoting and attribute spacing are normalised and an `xmlns` declaration may
be added to each opaque element); the canvas renders only model shapes plus
the background (`SketchCanvas.vue:484` iterates `sketch.shapes` alone), so
they are NOT drawn on the board, and the template comment saying they are
"still drawn" is stale. What makes a node opaque (only rect, ellipse, circle,
line, polygon, polyline, path, text, g and image can be; any other tag goes to
the prologue instead): a `polyline`, an `image` without `data-en-bgimg`, a
`style` attribute, a transform other than a single `rotate(a cx cy)`, a rect
with `rx`/`ry`, a path without `data-en-pts`, a polygon without
`data-en-kind="triangle"`, text with child elements, no font-size or no
content, a `g` without `data-en-kind="arrow"` or without a `<line>` inside,
percent or unit lengths, a stroke that is not a 6-digit `#rrggbb`, a
stroke-width outside 0.5 to 64, or any coordinate outside -6480 to 12960
(`svgDocument.ts:112-260, 264`; `sketchModel.ts:723-749`). An unparseable
`fill` is dropped to none rather than making the node opaque.

### Toolbar, left to right

A wrapping row (`SketchToolbar.vue:146-563`). Tool buttons are `OyaIconButton`
size sm; the label is the title and aria-label; the active tool has a filled
background. Switching tools cancels an in-progress stroke and, when the new
tool is not Select, clears the selection (`SketchCanvas.vue:309-317`).

| Control | Icon | Label | Key | `data-testid` | Does | Shown / enabled | Source |
|---|---|---|---|---|---|---|---|
| Select and move | `arrow-pointer` | "Select and move" | `sketch.tools.select` | none | Select tool. | always | `packages/wisteria/src/tools.ts:29` |
| Draw freehand | `pencil` | "Draw freehand" | `sketch.tools.draw` | none | Freehand tool; the default. | always | `tools.ts:30` |
| Rectangle | `square` | "Rectangle" | `sketch.tools.rect` | none | Drag out a box. | always | `tools.ts:31` |
| Circle | `circle` | "Circle" | `sketch.tools.circle` | none | Ellipse tool (id `ellipse`), inscribed in the dragged box. | always | `tools.ts:32` |
| Triangle | `play` | "Triangle" | `sketch.tools.triangle` | none | Apex at top-centre of the box, base along the bottom. | always | `tools.ts:33` |
| Line | `slash` | "Line" | `sketch.tools.line` | none | Straight line, no head; saved as a bare `<line>`. | always | `tools.ts:34` |
| Arrow | `arrow-right` | "Arrow" | `sketch.tools.arrow` | none | Line plus a filled head; head width for NEW arrows comes from the Brush picker. | always | `tools.ts:35` |
| Text | `font` | "Text" | `sketch.tools.text` | none | A click on the canvas opens Add text at that point. | always | `tools.ts:36` |
| Eraser | `eraser` | "Eraser" | `sketch.tools.eraser` | none | Press or drag removes every shape hit within a 10-unit radius; one sweep is one undo step. | always | `tools.ts:37` |
| Zoom trigger | `magnifying-glass` + "100%" + `chevron-down` | "Zoom" | `sketch.zoom` | `trigger-zoom` | Toggles the Zoom picker. Triggers carry `aria-haspopup="dialog"` and `aria-expanded`. | always | `SketchToolbar.vue:163-171` |
| Brush trigger | a dot in the current colour and opacity, sized to the stroke width (capped at 12px), then the width number | "Brush" | `sketch.brush` | `trigger-brush` | Toggles the Brush picker. | always | `:198-215` |
| Pen colour trigger | round swatch of the pen colour | "Pen colour" | `sketch.color` | `trigger-pen` | Toggles the Pen colour picker. Default black `#000000`. | always | `:331-341` |
| Fill trigger | square swatch of the fill, or a `ban` icon when none | "Fill" | `sketch.fill` | `trigger-fill` | Toggles the Fill picker. Default no fill. | only when a selected shape is a rect, ellipse or triangle, or (no selection) the active tool is one of those; an open Fill picker closes when this stops being true | `:370-383, 120-129` |
| Background trigger | square swatch of the board colour, or `ban` when transparent | "Background" | `sketch.background` | `trigger-board` | Toggles the Board picker. The value is a document property. | always | `:426-438` |
| Rotation | `rotate` icon, number input (0 to 359, step 1, aria-label "Rotation"), suffix "°" | "Rotation" | `sketch.rotation`, `sketch.degrees` | none | Shows and sets the selected shape's angle. Bound `.lazy.number`, so it commits on change or blur as ONE undo step. A typed value is normalised into 0 to 359.9 (360 and 720 become 0, -10 becomes 350) and rounded to 0.1°; a blank or non-numeric entry is ignored (`useSketch.ts:501-504`, `sketchModel.ts:305-308`); the min/max attributes do not stop out-of-range typing. The input's border is always the light-theme `border-accent-2`: the toolbar's `darkMode` prop is never passed by `SketchEditor.vue:275-287` (`SketchToolbar.vue:39, 532`). | only while a shape is selected | `:523-536, 131-137` |
| (right-aligned) Undo | `rotate-left` | "Undo" | `sketch.undo` | none | Whole-document snapshot undo (shapes, board colour, background image); history capped at 100. If an undo or redo removes the selected shape, the selection is cleared, and the Rotation field and Delete button go with it (`useSketch.ts:236-242`). | when there is something to undo | `:540-546`; `useSketch.ts:55` |
| Redo | `rotate-right` | "Redo" | `sketch.redo` | none | Any fresh edit clears the redo stack. | when there is something to redo | `:547-553` |
| Delete selection | `trash` | "Delete selection" | `sketch.deleteSelected` | none | Deletes the selected shape (undoable). | when a shape is selected | `:554-560` |
| Clear board | `broom` | "Clear board" | `sketch.clear` | none | Removes every shape at once, with NO confirmation (`sketch.clearConfirm` is unused here). Undoable; board colour and image untouched. On an already empty board it does nothing and adds no history (`useSketch.ts:560-565`). | always | `:561`; `SketchEditor.vue:285` |

The wisteria catalogue also carries strings this editor never shows:
`sketch.exportSvg` "Export as SVG", `sketch.boardFull`, `sketch.shapeCount`,
`sketch.loadFailed`, `sketch.openAsXml` "Open as XML instead", `sketch.cancel`
and the whole `sketch.colorNames.*` set; there is no SVG export, no board-full
message and no shape counter (`packages/wisteria/src/i18n/index.ts:43-106`). Of
the `sketch.*` keys only `sketch.newDrawing` reaches another screen, the ☰
menu's New entry.

Picking a pen colour, stroke width, transparency or fill while a shape is
selected restyles THAT shape as one undo step; text size and arrow head do not
restyle, and arrow head only affects arrows drawn afterwards
(`SketchToolbar.vue:61-78, 303`; `useSketch.ts:132-135, 486-504`). Each pick
writes all four current toolbar values (colour, width, transparency, fill) onto
the selected shape at once, not only the one just picked: a shape drawn
earlier with width 16 becomes width 4 the moment a colour is chosen for it
while the Brush still says 4. A pick that changes nothing records no undo step
(`useSketch.ts:486-498`).

### Pickers

Every picker is a `SketchPickerModal` (`packages/wisteria/src/components/SketchPickerModal.vue:30-56`):
`role="dialog"`, `aria-modal`, `aria-label` its title, focused on open through
`tabindex="-1"`, with a footer "Close" (`common.close`,
`data-testid="picker-close"`). Escape inside the panel closes it; clicking the
dark backdrop closes it (`oya-modal-overlay`). All five triggers end with a
`chevron-down` and show an accent border while their picker is open; their
title and aria-label are the label in the toolbar table
(`SketchPickerTrigger.vue:17-29`). Stroke-width buttons are labelled "2", "4",
"8", "16" for screen readers (`SketchToolbar.vue:237`).

| Picker | Title | Contents and ids | Source |
|---|---|---|---|
| Zoom (`modal-zoom`) | "Choose how close the board looks" (`sketch.zoomTitle`) | A 4-column grid: "50%", "75%", "100%", "150%", "200%", "300%", "400%" (`zoom-0.5`, `zoom-0.75`, `zoom-1`, `zoom-1.5`, `zoom-2`, `zoom-3`, `zoom-4`); the current one ring-highlighted; a pick sets zoom and closes. Zoom is display-only: the `<svg>` is sized to zoom × 100% inside a scrolling wrapper; the viewBox and file never change. At 50% and 75% the smaller `<svg>` sits in the top-left of the canvas area, not centred; above 100% the area gains scrollbars (`SketchCanvas.vue:443-448`). | `SketchToolbar.vue:173-195`; `sketchModel.ts:139` |
| Brush (`modal-brush`) | "Choose how the brush draws" (`sketch.brushTitle`) | Stays open across picks. "Stroke width" (`sketch.size`): four square buttons with dots of 2, 4, 8, 16 px (`width-2` … `width-16`; default 4). "Transparency" (`sketch.opacity`): "25%", "50%", "75%", "100%" (`opacity-0.25` … `opacity-1`; default 100%). "Text size" (`sketch.textSize`): "16", "24", "36", "56" (`textsize-16` … `textsize-56`; default 24; used by the next Add text). "Arrow head" (`sketch.headWidth`): "Narrow" 2.4×, "Normal" 3.6×, "Wide" 5.4× of the stroke width (`headwidth-2.4`, `headwidth-3.6`, `headwidth-5.4`). Below a divider, checkbox "Sticky" (`sketch.sticky`, `brush-sticky`) with hint "Snap to the corners and edge centres of nearby shapes." (`sketch.stickyHint`); default off. | `:217-328`; `sketchModel.ts:140-142, 414` |
| Pen colour (`modal-pen`) | "Choose the colour you draw with" (`sketch.penColorTitle`) | Heading "Colours" (`sketch.palette`) over a 7-column row of round swatches: black `#000000`, white `#ffffff`, then the five Settings roles accent, warning, success, highlight, mute, live from Settings (`swatch-black`, `swatch-white`, `swatch-accent`, `swatch-warning`, `swatch-success`, `swatch-highlight`, `swatch-mute`). Tooltips "Black", "White", "Accent", "Warning", "Success", "Highlight", "Muted" (`sketch.roleNames.*`). A colour from a file that is not in this list highlights no swatch. A pick sets the pen colour, restyles the selection if any, and closes. | `:343-367`; `packages/wisteria/src/sketchPalette.ts:22-43` |
| Fill (`modal-fill`) | "Choose what fills the inside of a shape" (`sketch.fillTitle`) | A `ban` button "No fill" (`sketch.noFill`, `fill-none`), highlighted when fill is null; then "Colours" over the same seven square swatches (`fill-swatch-{role}`). Every choice restyles the selection and closes. | `:385-423` |
| Board (`modal-board`) | "Choose the colour of the board itself" (`sketch.backgroundTitle`) | (1) `ban` button "Transparent" (`sketch.noBackground`, `board-none`). (2) "Plain paper" (`sketch.paperGroup`): swatches `#ffffff` (tooltip "White", `board-ffffff`) and `#111827` (tooltip is the raw hex, since it is not in the palette, `board-111827`). (3) "Colours": the seven swatches (`board-swatch-{role}`). Any colour pick sets the board colour (undoable, dirty) and closes. (4) Below a divider: icon button `file-image` "Background image…" (`sketch.chooseImage`, `board-image`), disabled while the host is busy, which opens a hidden `<input type="file" accept="image/*">`; and, only when an image is set, `xmark` "Remove background image" (`sketch.removeImage`, `board-image-remove`). Both image buttons leave the picker open; removing the image is undoable and marks the file dirty like setting one (`useSketch.ts:553-558`). | `:440-520`; `SketchEditor.vue:137-139, 294` |

A picked background image is cover-cropped to 1920 by 1080 and re-encoded
(PNG, or JPEG at quality 0.85 when the PNG data URL exceeds 1.5M characters and
has no transparency), then embedded inline
(`packages/wisteria/src/sketchExport.ts:65-91`). Errors show in the red strip:
"That file could not be read." (`sketch.imageUnreadable`) for a FileReader
failure; "That file is not an image we can read." (`sketch.imageNotAnImage`)
for a non-image MIME or an undecodable image; "That image could not be used."
(`sketch.imageFailed`) for anything else (`SketchEditor.vue:132-153`).

### Add text

Opened when the Text tool is active and the user presses on the canvas
(`SketchCanvas.vue:194-196`; `SketchEditor.vue:306-315`). An `OyaModal` with
a plain `ModalPanel` (no `role="dialog"`, unlike the pickers): title "Add
text" (`sketch.addText`); a text field with placeholder "Type something…"
(`sketch.textPlaceholder`), not focused automatically, so click into it first;
Enter confirms;
"Cancel" (`common.cancel`) and "Save" (`common.save`, not the catalogue's
`sketch.save` "Add"). Confirm trims the text and ignores an empty result (the
modal stays open); the text is placed with its baseline at the click point, at
the Brush picker's text size, truncated to 200 characters. At the 1000-shape
cap Save closes the modal and adds nothing, with no message
(`SketchEditor.vue:194-201`; `useSketch.ts:395-397`). The backdrop closes
it; Escape does NOT (the editor's key handler returns early while it is open
and `OyaModal` has no Escape handling). While it is open all editor shortcuts
are held.

### The canvas

`SketchCanvas.vue:442-709`. A scrollable wrapper holding one `<svg>` with
`viewBox="0 0 boardW boardH"`, `preserveAspectRatio="xMidYMid meet"`, sized to
zoom × 100%. Board colour paints a full rect when set; a background image is
drawn `xMidYMid slice` over the colour and under the shapes. With a board
colour or image set, the `<svg>` gets a sunken tint and inner shadow (visible
in the letterbox margins and rounded corners); a transparent board has none,
so the panel behind shows through untouched (`:435-439`). The cursor is `move`
for Select, `text` for Text, hidden and replaced by a red ring for Eraser, and
a crosshair for every drawing tool (`:424-429`). Input is pointer events, so
touch and pen draw too; a cancelled pointer (system gesture, lost capture) is
treated as a release and commits. Only the primary button starts any gesture,
for every tool (`:167, 449-455`). Hit-testing (eraser 10 units, select 8) adds
half the shape's stroke width to the radius; text uses its measured box with
no allowance. A filled rect, circle or triangle is hit anywhere inside, an
unfilled one only near its outline; a line only along its shaft, an arrow also
on its head (`sketchModel.ts:625-715`).

* Draw: press, drag, release commits a path (one undo step); points closer
  than 1.5 units are thinned.
* Rectangle, Circle, Triangle, Arrow: a translucent preview (opacity 0.8, in
  the current pen colour, width and fill) follows the drag; on release the
  shape is added. Line shows NO preview while dragging: the line appears only
  on release (`SketchCanvas.vue:596-637` has no `line` branch). Rect and
  triangle need at least 1 unit in both axes, ellipse 0.5 radius, line and
  arrow 2 units, else nothing is added. With Sticky on, both ends snap to a
  target within 12 units (`SNAP_RADIUS`, `sketchModel.ts:417`); the rings
  appear earlier, within 72 (`SketchCanvas.vue:330`). What a shape offers
  (`sketchModel.ts:434-483`): a rect its four corners and four edge centres; a
  triangle its three vertices and three edge midpoints; an ellipse its four
  quadrant points; a line or arrow both ends and the midpoint; a freehand path
  only its two end points; text nothing. Points follow the shape's rotation,
  and only committed shapes offer them, so a drag never snaps to itself.
* Eraser: a red ring (radius 10) follows the pointer and disappears when the
  pointer leaves the board; the path is sampled every 4 units so fast flicks
  do not skip. One press-to-release sweep is one undo step; an empty sweep
  records nothing.
* Select: a click within 8 units of a shape selects the topmost hit; dragging
  moves it (one undo step). Clicking empty space clears the selection
  (`selectAt` stores the null hit, `useSketch.ts:412-415`); Escape or switching
  to another tool clears it too. The selected shape shows a dashed blue box
  (`#3b82f6`, 4-unit margin), a blue square resize handle (14 units) at the
  bottom-right corner, and a stalk with a round rotate knob 34 units above the
  top centre; the chrome rotates with the shape. The corner handle scales
  about the top-left (minimum 1 by 1); resizing a text shape scales its font
  size by the mean of the horizontal and vertical factors (never below 4), so
  text cannot be stretched in one axis (`sketchModel.ts:569-578`). The knob
  rotates about the pivot, and Shift snaps to 15°. Drags that change nothing
  add no history.

At 1000 shapes (`MAX_SHAPES`) new shapes are silently refused; no message is
rendered (`useSketch.ts:273-277`). The canvas carries `peer-live` and
`peer-cursor` elements for a collaboration session Morion never starts; they
never render (`SketchCanvas.vue:570-594`).

### Refusal panel

`SketchEditor.vue:265-272`. Shown when `parseSvgDocument` refuses the file on
open: a red warning icon, "This drawing can't be opened here"
(`sketch.refusedTitle`), a grey sentence at `data-testid="svg-refusal"`, and
"Open as plain text" (`data-testid="svg-open-text"`). The reasons
(`svgDocument.ts:61-65, 83-105, 273-284`): doctype is checked first, then
not-svg; then one pass over the elements in document order reports the first
offence found, so active-content and external-reference are not ranked
against each other: whichever appears earlier in the file (tag first, then
attributes in order) is the one shown.

| Reason | Trigger | Sentence |
|---|---|---|
| doctype | the text contains `<!DOCTYPE` or `<!ENTITY` | "It declares XML entities, which this editor will not expand." (`sketch.refusedDoctype`) |
| not-svg | DOMParser error, or the root element is not `<svg>` | "It isn't a readable SVG file." (`sketch.refusedNotSvg`) |
| active-content | any `<script>`, `<foreignObject>`, `<use>`, `<animate>`, `<set>`, or any attribute whose name starts with `on` | "It contains active content ({what}), which this editor will not run." (`sketch.refusedActive`), `{what}` like `<script>` or `tag[onclick]` |
| external-reference | a `style` attribute containing `url(`, or an `href`/`xlink:href` that is not `#…` or a `data:image/(png\|jpeg\|webp);base64,` URL | "It points at something outside the file ({what}), which this app will not fetch." (`sketch.refusedExternal`) |

The refusal is all or nothing: one offending node refuses the whole file, and
nothing is stripped.

### Export

"Export as PNG" (`sketch.exportPng`, icon `file-image`) is the editor's one
export (`SketchEditor.vue:254`), rendered in the ☰ menu as `menu-export` and
disabled while the host is busy (`App.vue:220, 379-388`); the handler is
`SketchEditor.vue:155-174`. It rasterises the board through Canvas2D at 1×
(`sketchExport.ts:184-310`; a transparent board gives a transparent PNG),
except that the PNG width is clamped to at least 540 and at most 6480 units
(`boardWidth`, `sketchModel.ts:56-59`): a board narrower than 540 units exports
540 pixels wide with empty space on the right, while the height is the board's
own. It saves as `<name without .svg>.png` (or `drawing.png` if the stem is
empty). Under Tauri that is the native save dialog with a "PNG" filter, written
through the writer `main.ts` installs; cancelling shows nothing. In a browser
it is a download. Success shows the notice "Saved." (`sketch.exportDone`); a
thrown error shows its raw message in red in the editor (for example "Canvas is
unavailable."), so a failed PNG export never reaches the header's
`export-error` line. Re-entry while an export is running is ignored. The
handler answers whether a PNG was written: `true` only when the writer reports
a file, `false` for a cancelled dialog, a caught error, a re-entry or the
refusal panel (`:157-174`). From an encrypted drawing the menu shows the Mana
confirmation for a plaintext export (10) first and charges only when the answer
is `true` (`App.vue:225-241`); from a plain drawing the export is free.

### What Save writes

Plain SVG (`svgDocument.ts:353-374, 385-400`): the root attributes exactly as
the file arrived, then the prologue (every root child whose tag is not
rect/ellipse/circle/line/polygon/polyline/path/text/g/image: `<defs>`,
`<style>`, `<title>`, `<metadata>`, gradients, filters, markers, …),
re-serialised and moved ahead of the background and all drawable nodes
regardless of where it sat (`:264, 297-302, 360, 372`), then the nodes in
paint order, opaque nodes re-serialised (see above) and editable shapes
regenerated. Top-level XML comments are dropped on save, since only element
children are read. A new drawing gets `xmlns`, `width="1920"
height="1080" viewBox="0 0 1920 1080"`. Whitespace and attribute order are
normalised, so the first save of a foreign file changes bytes even without
edits (it does not open dirty). The engine's own hints
(`packages/wisteria/src/sketchModel.ts:864-926`): `data-en-bg="1"` on the
full-board `<rect>` that is the board colour (absent when transparent);
`data-en-bgimg="1"` on the embedded `<image>`; `data-en-pts` on a freehand
`<path>` alongside the smoothed `d`; `data-en-kind="triangle"` on a
`<polygon>` and `data-en-kind="arrow"` on a `<g>`; `data-en-headw` on an arrow
`<g>` when the head width differs from 3.6. Rotation is
`transform="rotate(deg cx cy)"`, `fill="none"` when unfilled, coordinates
quantised to 0.1. A plain `<line>` from another tool opens as a Line; a
`<circle>` opens as an ellipse and is written back as `<ellipse>`.

### Shortcuts

One window listener (`SketchEditor.vue:204-231`), active only while the editor
is `active`, a document is open (no refusal), no picker and no Add text modal is
open, and focus is not in an `INPUT` or `TEXTAREA`.

| Keys | Action |
|---|---|
| Ctrl+S / Cmd+S | Emits `save` with the serialised SVG, unless busy. |
| Ctrl+Z / Cmd+Z | Undo. |
| Ctrl+Shift+Z / Cmd+Shift+Z, Ctrl+Y / Cmd+Y | Redo. |
| Delete or Backspace | Delete the selected shape (only when something is selected). |
| Escape | Clear the selection. Inside an open picker it closes the picker instead. Does not close Add text. |
| Shift while dragging the rotate knob | Snap rotation to 15°. |
| Enter in the Add text field | Confirm. |

## The Markdown and Code editors

`apps/morion/src/editors/TextEditor.vue` is one ACE editor that the host
mounts in three faces, chosen by the HOST's props, never by the file:

| Face | Host mounts it as | When | Toolbar | Source |
|---|---|---|---|---|
| Code | `<TextEditor with-picker>` | kind `code`: every extension the table maps to code, anything unclaimed, New text, and a picture (from the Files panel or a search hit, or an encrypted one decrypted into memory) | undo/redo strip, a divider, "Language" label and dropdown | `EditorHost.vue:654-668` |
| Markdown | `<TextEditor toolbar>` | kind `markdown`: `.md`, `.markdown` (unless the bytes sniff as a deck, document or workbook, which win first: `openWith.ts:86-94`), New Markdown note | undo/redo strip only; the name already said Markdown | `EditorHost.vue:709-723` |
| Bare | `<TextEditor>` | kind `text`: only after "Open as plain text" from a refusal | none; ACE's own Ctrl+Z and Ctrl+Shift+Z still work, there are just no buttons | `EditorHost.vue:725-738` |

Encrypted files of any of these kinds open in the same faces, decrypted into
memory first; the editor cannot tell (see Encryption).

The Markdown face is a source editor only: the note is highlighted in ACE's
markdown mode but never rendered, there is no preview pane or toggle, and no
HTML or PDF export reaches the ☰ menu from it.

The buffer is `data-testid="ace-host"` (`TextEditor.vue:228`), mounted with
font size 13, no print margin, soft wrap on, soft tabs, tab size 2, and the
`github` theme in light mode or `github_dark` in dark mode, following the
`.dark` class live (`apps/morion/src/editors/aceSetup.ts:51-52`;
`packages/petalite/src/theme/theme.ts:15-34`). The host's file error shows as
a warn line above the buffer or the image (`TextEditor.vue:217-219`). On every
ACE `change` the editor compares `getValue()` with the text as of the last
save and emits `update:dirty`; opening never starts dirty. Dirt is measured by
value, not by undo depth: undoing (or retyping) back to the saved text clears
the header dot, and a save re-baselines to the buffer as it was at that moment
(`TextEditor.vue:138-140, 176-179`).

The buffer takes focus the moment it mounts (`TextEditor.vue:147`), so a
freshly opened or New file is ready to type into and Ctrl+S works at once.
Because ACE reads keys through a hidden `<textarea>`, the host's Ctrl+O is
ignored while the buffer has focus (`EditorHost.vue:572-573`); click the
toolbar or header first, or use the ☰ menu. The host also passes `active`, but
this editor declares no such prop (`TextEditor.vue:32-42`); Ctrl+S is gated by
ACE focus alone, which is enough because the editor view is hidden with
`v-show` while Workspace security or Settings is up.

### Toolbar (code and markdown faces)

The strip is a bottom-bordered row that wraps, so at narrow widths the
Language label and dropdown drop to a second line under the buttons
(`TextEditor.vue:191-192`).

| Control | Icon | Label | Key | `data-testid` | Does | Enabled when | Source |
|---|---|---|---|---|---|---|---|
| Undo | `rotate-left` | icon-only; "Undo" is the tooltip (`title`) and aria-label | `code.undo` | `editor-undo` | `editor.undo()`, refreshes the history flags, refocuses ACE. A small bordered square like the dropdown trigger. | ACE's `UndoManager.hasUndo()`; a just-opened file starts disabled (30% opacity) | `TextEditor.vue:194-199` |
| Redo | `rotate-right` | icon-only; "Redo" is the tooltip and aria-label | `code.redo` | `editor-redo` | `editor.redo()`. | `hasRedo()`; typing after an undo clears it | `:200-205` |
| Divider | | | | none | Only with the picker. | | `:207` |
| "Language" label and dropdown | `chevron-down` | aria-label "Language" | `code.language`; `code.plainText` for the empty option | `language-select` (root); inside it `select-trigger`, `select-panel`, `select-option-empty` for Plain text and `select-option-{Label}` for the rest (for example `select-option-Python`) | `pickLanguage(label)` switches the ACE session mode. A pick outlives a later Save As rename; until then a rename re-detects the mode from the new name. Choosing the already-selected option emits nothing. Esc or a backdrop click closes the list. The trigger is `aria-haspopup="listbox"` with `aria-expanded`; the panel is `role="listbox"` and each entry a `role="option"` button with `aria-selected`, the current one bold in the accent colour. The panel opens under the trigger, is capped at 15rem and scrolls, so the last entries (TypeScript, XML, YAML) are below the fold. There is no arrow-key navigation: Tab walks the option buttons, Enter or Space picks, Esc closes only while focus is inside the dropdown, and clicking the trigger again closes it (`SelectMenu.vue:36-71`). | code face, not an image | `:71-74, 102-107, 160-166, 211-214` |

The language list, in this exact order (`aceSetup.ts:119-132`): "Plain text",
"CSS", "HTML", "JavaScript", "JSON", "LaTeX", "Markdown", "Python", "Shell",
"TypeScript", "XML", "YAML". The default is the language detected from the file
name; "Plain text" for anything not on the list. Only "Plain text" and the
toolbar words are translated (Polish: "Zwykły tekst", "Cofnij", "Ponów",
"Język", `pl.ts:35-38`); the language names are proper nouns and read the same
in every locale (`aceSetup.ts:99-103`).

Detection knows more than the picker offers (`aceSetup.ts:54-92`): `txt` plain
text; `md`, `markdown`; `json`; `yml`, `yaml`; `toml`; `ini`, `cfg`, `conf`;
`xml`, `pxml`, `svg` as xml; `js`, `mjs`, `cjs`; `ts`, `mts`, `cts`; `py`;
`rs`; `sh`, `bash`, `zsh`; `html`, `htm`; `css`; `tex`, `sty` as latex;
anything else plain text. The extension is whatever follows the last dot,
lower-cased, and a leading dot does not count: `.env`, `.bashrc` and names
without an extension are plain text, while `NOTES.MD` is markdown
(`aceSetup.ts:88-91`). So a `.rs`, `.toml` or `.ini` file is highlighted
correctly while the dropdown reads "Plain text" until the user picks
something. Only these modes are bundled. Six syntax-check workers are bundled
(json, javascript, which also serves typescript, css, html, xml, yaml;
`aceSetup.ts:42-49`), served from bundled assets and never a CDN; in those
modes ACE marks problems with error and warning icons in the line-number
gutter. Python, Rust, Shell, TOML, INI, LaTeX, Markdown and plain text get
highlighting only, never diagnostics.

### Image viewer

When the file name's extension is `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`,
`ico` or `avif` (`packages/petalite/src/files/images.ts:14-33`; `.svg` is not
an image here), no ACE is created. The buffer area is replaced by a centred,
`object-contain` `<img>` (`data-testid="image-preview"`) inside
`data-testid="image-view"` whose `src` is the content (a `data:` URI: the
bytes the Files panel read, or, for an encrypted picture, the bytes Rust
decrypted into memory) and `alt` is the file name (`TextEditor.vue:221-225`). A picture
larger than the area is shrunk to fit with 1rem padding; a smaller one is
shown at its natural size, never enlarged. The undo and redo buttons, divider,
label and dropdown are all omitted, but the toolbar strip itself still renders
as an empty bordered bar in the code face. The host marks the file read-only
(`EditorHost.vue:558`), so Save is greyed in the menu and Ctrl+S does nothing;
Save As stays enabled in the menu (`App.vue:280` gates it only on a file and a
workspace) but is a silent no-op, since `saveAs` returns before any dialog
(`EditorHost.vue:509`). On the desktop build a plain picture reaches this view
only from the Files panel or a search hit: the Open dialog's "All" filter can
select one, but Rust refuses to read it as text (`workspace.rs:261-263`,
`not_text`). An encrypted picture picked there does open, because Rust's
`locked` answer sends it through the passphrase and it is decrypted to bytes
(`EditorHost.vue:463-470, 209-215`); the header's shield then reads
"Encrypted on disk. Shown from memory; nothing is written.". The browser
build's Open input (`EditorHost.vue:476-483`) has no such guard and would show
a broken image whose `src` is the decoded text.

### Shortcuts

Ctrl+S / Cmd+S is an ACE command (`TextEditor.vue:142-146`), so it fires only
while the buffer has focus; it emits `save` unless the host is busy. `busy`
gates Ctrl+S alone: the buffer stays editable and Undo/Redo stay clickable
while a write is in flight (`TextEditor.vue:118-121, 197, 203`). Ctrl+Z and
Ctrl+Shift+Z are ACE's undo and redo, mirrored by the buttons; Ctrl+Y also
redoes. ACE's default keymap (ace-builds 1.44.0) is otherwise untouched:
Ctrl+H (Cmd+Option+F) opens the search box in replace mode, Ctrl+D deletes the
current line, Ctrl+/ toggles a line comment in the current mode, and the rest
of ACE's defaults apply while the buffer has focus (the full list is in
Keyboard shortcuts). Ctrl+L (go to line), F1 (command palette) and Ctrl+,
(ACE's settings menu) are bound by ACE but depend on `ext-prompt` and
`ext-settings_menu`, which `aceSetup.ts:12-33` does not bundle; pressing them
makes ACE try to load the extension at runtime from a relative URL the app does
not ship, never a CDN, so nothing visible should happen (unverified by a run).
These faces offer no exports and persist nothing of their own.

### Find and replace (ACE's search box)

Ctrl+F (Ctrl+H for replace) drops ACE's own panel into the top-right of the
buffer (`aceSetup.ts:33`, `ext-searchbox`): a "Search for" field, an "All"
button, and in replace mode a "Replace with" field with "Replace" and "All".
Four toggles carry tooltips "RegExp Search" (Alt+R), "CaseSensitive Search"
(Alt+C), "Whole Word Search" (Alt+B) and "Search In Selection", plus "Toggle
Replace mode". Enter and Shift+Enter step to the next and previous match,
Alt+Enter selects all matches, Esc closes the box. These strings are ACE's, in
English only, and carry no test ids.

## Settings

`apps/morion/src/views/SettingsView.vue:41-132`, mounted by
`App.vue:532-533` (`showView`, `:58-63`) on the first ☰ → Settings
(`menu-settings`, `App.vue:391-397`) and kept afterwards. The header shows a
`gear` icon and "Settings" (`nav.settings`) with the ×. Every change applies
immediately; there is no Save or Apply button. While it is up the Files panel
is hidden (its toggle still works and persists), and the editor stays mounted
underneath with its `active` flag off (`App.vue:87, 520, 526, 532-533`). The
view scrolls vertically; its content sits in a centred column of at most 42rem
with 24px padding: System colours first, then Search algorithm, then the markup
switches, each heading 40px below the section before it
(`SettingsView.vue:42-43, 84, 108`).

### System colours

| Control | Text | Key | `data-testid` | Does | Source |
|---|---|---|---|---|---|
| Heading (`gear` icon, dimmed) and help | "System colours"; "The five colours documents, drawings and slides use for emphasis. One value each — pick shades that read on light and dark alike, because whatever you choose is stored in the file exactly as it is." | `settings.colors.title`, `.help` | none | | `SettingsView.vue:44-48` |
| Five colour rows, in order accent, warning, success, highlight, mute | an `<input type="color">` (aria-label the role name, tooltip the hex), the bold role name "Accent", "Warning", "Success", "Highlight", "Muted", and the hex in `<code>` | `settings.colors.roles.*` | `role-{role}` (row), `color-{role}` (input) | A pick is validated as `#rgb` or `#rrggbb`, then sets `--sys-{role}` on `<html>` and saves the palette to `zinnia:systemColors`. Applied on every `input` event, so the swatch, the hex and every open editor recolour live while a shade is being dragged in the native picker, and each step is saved; a value that fails validation is ignored silently and nothing changes (`SettingsView.vue:35-38, 60`). Defaults: accent `#3b82f6`, warning `#ef4444`, success `#10b981`, highlight `#f59e0b`, mute `#6b7280`. | `:35-38, 50-66`; `packages/petalite/src/theme/systemColors.ts:21, 33-39, 44, 50-54, 91-104`; `useSystemColors.ts:30-34` |
| "Body text" row (dashed box) | "Always black on light and white on dark — not adjustable." with a small round swatch | `settings.colors.primaryText`, `.primaryTextNote` | `primary-text` | Read-only. The swatch is `#000000` in light mode and `#ffffff` in dark, following the header toggle live through a MutationObserver on the `.dark` class. | `:69-75`; `systemColors.ts:42`; `useSystemColors.ts:28`; `theme.ts:20-34, 43-47` |
| "Restore defaults" (`rotate-left`) | | `settings.colors.reset` | `colors-reset` | Resets the five roles, re-applies the properties and saves. Colours only; the switches below are untouched. | `:77-81` |

The roles have one value each, no light or dark variant. They feed the Write
editor's three ink swatches (accent, success, warning; `DocumentEditor.vue:45-49`,
`document.css:299-301`) and the Drawing editor's seven-colour palette
(`packages/wisteria/src/sketchPalette.ts:22, 32-40`) live. A drawing stores
the literal hex; a Write document stores a `cy-ink-*` class that resolves to
the current palette when rendered (`cyprianSchema.ts:69`). `--sys-highlight`
and `--sys-mute` have no consumer outside the drawing palette.

### Search algorithm

What the search box in the Files panel looks at. The three algorithms
themselves are described under Search.

| Control | Text | Key | `data-testid` | Does | Source |
|---|---|---|---|---|---|
| Heading (`magnifying-glass` icon, dimmed) and help | "Search algorithm"; "What the search box looks at. Every algorithm walks the workspace on each search; nothing is indexed or kept." | `settings.search.title`, `.help` | none | | `SettingsView.vue:84-88` |
| Three radio rows in a bordered card, in the order Quick, Full text, Hybrid, each a bold label over a note | "Quick": "File names, paths and tags. Never reads what is inside a file."; "Full text": "Names, paths and tags, plus the contents of plain text files, in folder order."; "Hybrid": "Both, ranked: a matching name or tag comes before a matching path, and a line of text comes last." | `settings.search.modes.{quick,full,hybrid}.label`, `.note` | `search-modes` (the card, `role="radiogroup"`), `search-mode-row-{quick,full,hybrid}` (a row), `search-mode-{quick,full,hybrid}` (its radio, `name="search-mode"`) | Picking one sets the shared mode and writes `zinnia:searchMode`; a query on screen in the Files panel is asked again at once with the new algorithm (`WorkspaceSearch.vue:106`). Hybrid is checked on a fresh install, and a stored value that is not one of the three reads as Hybrid. Each row is one `<label>`, so a click anywhere on it picks. | `SettingsView.vue:90-104`; `apps/morion/src/files/searchSettings.ts:7-34` |
| Privacy note (small, dimmed) | "An encrypted file is found by its name, path and tags only. Its contents are never read for a search, and no passphrase is ever asked for one." | `settings.search.privacy` | `search-privacy-note` | | `SettingsView.vue:105` |

Quick's "Never reads what is inside a file" holds for what a file says, not for
its first bytes: every algorithm, Quick included, reads each file's first 16
bytes to tell whether it is encrypted (see Search). In Polish the three read
"Szybki", "Pełnotekstowy" and "Hybrydowy", and Quick's note "Nazwy plików,
ścieżki i tagi. Nigdy nie czyta zawartości pliku."
(`apps/morion/src/i18n/pl.ts:96-98`).

### What a file may bring with it

| Control | Text | Key | `data-testid` | Does | Source |
|---|---|---|---|---|---|
| Heading (`shield-halved` icon, dimmed) and help | "What a file may bring with it"; "A presentation can carry raw markup — a drawing, or a legacy HTML block. These decide what happens to it. All three are off to begin with: the first costs a little to draw, and the other two change how somebody else's document looks." | `settings.markup.title`, `.help` | none | | `:108-112` |
| Checkbox "Render a file’s own markup in isolation" | note: "Puts those blocks in a scope of their own, so a stylesheet inside one cannot restyle the app around it. An inline drawing does not scope its own styles, so without this it reaches the whole window. Costs a little to draw, which is why it is off to begin with." | `settings.markup.isolate.label`, `.note` | `switch-isolate` (row `switch-row-isolate`, card `markup-safety`) | Writes `zinnia:sandbox` = "1" on, "0" off. On, a deck's `svg` and `html` payloads are painted inside an open shadow root (`ShadowHtml`, `data-testid="shadow-host"`) with a tiny reset: `:host { display: contents }` plus `img, svg { max-width: 100%; max-height: 100%; height: auto }`; inherited properties (font, colour, block scale) still cross the boundary. The root is attached once per block and its contents replaced whenever the payload or a switch changes (`ShadowHtml.vue:28-31, 33-53`). If `attachShadow` throws, the block renders as nothing rather than falling back. An `html` block is only isolated, or painted at all, when the surface also passes `trust-html` (both the editor canvas and the player do); a surface that does not shows the hard-coded placeholder "Legacy HTML slide" whatever the switch says (`SlideBlock.vue:107-109`). | `:114-128`; `useMarkupSafety.ts:30-34, 62-69`; `SlideBlock.vue:84-85, 107-108` |
| Checkbox "Block style sheets" | note: "Takes stylesheets out of that markup before it is drawn at all. A deck that styles itself will come out plain." | `settings.markup.blockStyles.label`, `.note` | `switch-blockStyles` (row `switch-row-blockStyles`) | Writes `zinnia:blockStyles` = "1" on, "0" off. On, `<style>` elements and `<link rel=stylesheet>` are removed from `svg` and `html` payloads before drawing; style attributes are kept. The file is never changed. | `apps/morion/src/security/scrub.ts:40-60` |
| Checkbox "Block scripts" | note: "Takes scripts, event handlers and javascript: links out of it. They already cannot run — the window only executes the app’s own files — so this is for keeping them out of the page entirely." | `settings.markup.blockScripts.label`, `.note` | `switch-blockScripts` (row `switch-row-blockScripts`) | Writes `zinnia:blockScripts` = "1" on, "0" off. On, `<script>` elements are dropped, every attribute whose name starts with `on` is removed, and `href`, `src` and `xlink:href` are removed when their value is `javascript:` after any leading whitespace or control characters (so `java\tscript:` is caught). Other attributes are never inspected. | `scrub.ts:25-28, 62-74` |

Each row is one `<label>`, so a click anywhere on the row, the bold label or
the note, toggles its checkbox (`SettingsView.vue:116-127`). The three switches
reach only `svg` and `html` blocks. A deck's `heading`, `text`, `list` and
`quote` payloads are rich HTML from the file too, but they are rendered with
`v-html` in the page itself, unscrubbed and outside any shadow root, whatever
the switches say (`SlideBlock.vue:60-75, 99-103`). When isolation and a
blocker are both on, it is the scrubbed payload that goes into the shadow root
(`:51, 84, 107`). With either blocker on, the payload is parsed as an HTML
document and what is drawn is the parser's reserialised `<body>`, so the block
shows normalised markup rather than the file's bytes; with both off the
payload is passed through untouched. Where `DOMParser` does not exist the
blockers silently do nothing (`scrub.ts:41-44, 83`).

All three are off on a fresh install; a stored value other than the exact
string "1" reads as off. They are module-level refs shared with every
`SlideBlock`, so a toggle repaints open deck blocks at once. `settings.empty`
("Nothing here yet. Theme and language will move here.") and
`settings.colors.role` ("Role") are in the catalogue but unused. If browser
storage is blocked or full, a pick or a toggle still takes effect for the
session (the property is set and the switch ref flips before the write) and is
only not remembered (`systemColors.ts:91-97`; `useMarkupSafety.ts:62-69`).
Nothing in Settings has a key binding, and Settings behaves the same in a
browser, where the search setting is kept too although the browser build's
search finds nothing.

## Keyboard shortcuts

"Active flag" means the editor's `active` prop, which is false while Workspace
security or Settings is in front; a shortcut gated by it is inert there even
though the editor stays mounted.

The window handlers test only Ctrl/Cmd plus the letter, never Shift or Alt:
Ctrl+Shift+S and Ctrl+Alt+S save, Ctrl+Shift+O opens, and in the Drawing
editor Ctrl+Shift+Y redoes (`DocumentEditor.vue:281`,
`PresentationEditor.vue:340`, `SheetEditor.vue:196`, `SketchEditor.vue:215,
222`, `EditorHost.vue:574`). In the Write body Ctrl+Shift+S also toggles
TipTap's strike-through (no toolbar button) on the way to saving. Only ACE's
Ctrl+S is exact.

| Keys | Action | Where it applies | Gated by active | Other gates | Source |
|---|---|---|---|---|---|
| Escape | Close the ☰ menu | focus inside the menu wrapper | no | not stopped: with a drawing open the same Escape also clears the shape selection | `App.vue:294` |
| Escape | Close the file shield's panel | focus inside the shield's wrapper, as it is right after the shield was clicked | no | same drawing note | `App.vue:432` |
| Ctrl+O / Cmd+O | Open… (discard prompt first if dirty) | window, any editor or the start screen | yes | not when focus is in an `INPUT` or `TEXTAREA`, which includes ACE's hidden input textarea (so in the Code, Markdown and bare text editors it only works after focus has left the buffer, which is focused on open), the workspace search box and the fields of the passphrase, folder and tag dialogs; with no workspace it shows "Choose a workspace folder first." in the header instead, although the menu's Open… is greyed then; in the browser build it opens the hidden file input; not gated by the discard prompt (pressed while the prompt is open it re-arms the prompt for Open and the action that first raised it is abandoned) or by the other dialogs; works during Present | `EditorHost.vue:566-578, 603` |
| Ctrl+S / Cmd+S | Save the document | Write editor, window | yes | not while busy; fires from dialog inputs (including the passphrase, folder and tag dialogs), the workspace search box and the header too; NOT gated on the "not a document" panel: there it emits a serialised blank document and the host writes it over the file (the menu's Save is disabled on that panel, Ctrl+S is not) | `DocumentEditor.vue:277-285, 147-152, 163-181` |
| Enter | Insert the formula | Write editor, Formula dialog field | n/a | on key release (`OyaTextField`'s keyup), with any modifier held; an empty field is ignored | `DocumentEditor.vue:495`; `OyaTextField.vue:30` |
| Mod-Z, Mod-Shift-Z, Mod-Y, Mod-B, Mod-I, Mod-U, Mod-Alt-1 to 3, Mod-Shift-8, Mod-Shift-7, Mod-Shift-B, Mod-Alt-C, Mod-Shift-S, Mod-E, Shift-Enter / Mod-Enter | TipTap defaults: undo, redo, bold, italic, underline, headings, bullet list, numbered list, blockquote, code block, strikethrough, inline code, hard line break | Write editor body, focus inside | n/a | | `cyprianSchema.ts:164-175` |
| Mod-Alt-0 | Back to a paragraph | Write editor body | n/a | | `@tiptap/extension-paragraph` |
| Enter, Tab, Shift-Tab | In a list: new item, indent, outdent | Write editor body, cursor in a list item | n/a | | `@tiptap/extension-list-item` |
| Tab, Shift-Tab | In a table: next / previous cell; Tab in the last cell adds a row | Write editor body, cursor in a table | n/a | | `@tiptap/extension-table` |
| Backspace, Delete, Mod-Backspace, Mod-Delete | Delete the table when every cell is selected | Write editor body | n/a | | `@tiptap/extension-table` |
| Backspace (at start or empty), Enter after two blank lines, ArrowDown at the end | Leave a code block | Write editor body, cursor in a code block | n/a | | `@tiptap/extension-code-block` |
| `# ` / `## ` / `### `, `- ` or `* ` or `+ `, `1. `, `> `, three backticks (each followed by a space or Enter); `**x**`, `*x*`, `~~x~~`, backticked `x`, `---` | TipTap input rules: heading 1 to 3, bullet list, numbered list, blockquote, code block; bold, italic, strike, inline code, horizontal rule as you type | Write editor body | n/a | | `cyprianSchema.ts:164`; StarterKit defaults |
| Mod-Z, Mod-Shift-Z, Mod-Y, Mod-B, Mod-I, Mod-U, Mod-Shift-8, Mod-Shift-7, Mod-Shift-S, Mod-E, Mod-Alt-0, Shift-Enter, Mod-Enter; Enter / Tab / Shift-Tab in a list | TipTap defaults in the block editor's rich field (text, quote, html and heading blocks); headings, code blocks, quotes and rules are disabled there | Presentations editor, block editor modal, focus inside the field | n/a | in the heading field the list buttons are hidden but Mod-Shift-8 / Mod-Shift-7 still insert a list | `RichPayloadEditor.vue:25-35` |
| Ctrl+S / Cmd+S | Save the deck | Presentations editor, window (also during Present) | yes | not while busy; not in `INPUT`/`TEXTAREA`; a contenteditable does not count; not gated on the "not a presentation" panel: there it saves an empty deck over the file | `PresentationEditor.vue:334-348, 71-73, 92-102` |
| PageDown / PageUp | Next / previous slide, no wrap | Presentations editor, window (also behind a modal or the player) | yes | not in `INPUT`/`TEXTAREA`; a contenteditable does not count; busy does not gate this; fires inside the block editor's rich field and its buttons, and a slide changed that way makes the modal's Save silently discard the draft, because the block is looked up on the new current slide; the key is not prevented, so the slide pane scrolls too | `PresentationEditor.vue:343-346, 309-315` |
| Esc | Close an open `SelectMenu` (layout, slot, language) | focus inside the menu | no | no arrow-key navigation, Tab moves through the options; the wrapper stops Escape even when the list is closed | `SelectMenu.vue:36` |
| Esc | Close the player | window while the player is open | no | captured on window before anything else and stopped, so an open `SelectMenu`, the ☰ menu and reveal itself never see Escape while the player is up | `DeckPlayer.vue:26-33, 69` |
| Right, Down, Space, N, L, J, PageDown; Left, Up, P, H, K, Shift+Space, PageUp; Home, End, Shift+Left / Shift+Right (first / last); B, V, `.` (black screen); F (fullscreen); G (jump-to-slide box); O (overview); Shift+?, F1 (help overlay), C (close overlay) | reveal.js 5.2.1 defaults | player stage, only after a click on it (reveal's own focus state) | no | ignored with Ctrl/Cmd held or focus in an input or contenteditable; Esc is taken by the player before reveal sees it, so the overview opens only with O | `DeckPlayer.vue:60-63`; reveal.js `controllers/keyboard.js` |
| Ctrl+S / Cmd+S | Save the workbook | Sheet editor, window, including focus in the grid | yes | not while busy; fires from the workspace search box, dialog fields and the header too; still fires on the "not a spreadsheet" panel (re-writes the original bytes unchanged) and on "The grid could not start" (writes the parsed, normalised snapshot) | `SheetEditor.vue:192-200`, `98-101`, `83-88` |
| Univer defaults (undo/redo, clipboard, bold/italic/underline, cell navigation and editing) | the grid's own bindings | Sheet grid, focused | n/a | not listed here; see Univer's documentation for the preset in use | `SheetEditor.vue:132-146` |
| Ctrl+S / Cmd+S | Save the buffer | Code, Markdown and bare text editors, only while the ACE buffer has focus | implicitly (an ACE command) | not while busy; nothing for an image | `TextEditor.vue:142-146` |
| Ctrl+Z / Cmd+Z; Ctrl+Shift+Z, Ctrl+Y / Cmd+Shift+Z, Cmd+Y | ACE undo / redo (ACE's own default commands) | ACE buffer focused | n/a | | `TextEditor.vue:76-80`; ace-builds 1.44.0 default commands |
| Ctrl+F / Cmd+F; Ctrl+H / Cmd+Option+F | ACE search box (find; find-and-replace) | ACE buffer focused | n/a | | `aceSetup.ts:33` |
| Ctrl+K / Ctrl+Shift+K, Ctrl+A, Ctrl+D, Ctrl+Shift+D, Ctrl+/ and Ctrl+Shift+/, Alt+Up / Alt+Down, Alt+Shift+Up / Alt+Shift+Down, Ctrl+Shift+Up / Ctrl+Shift+Down, Tab / Shift+Tab, Ctrl+] / Ctrl+[, Ctrl+U / Ctrl+Shift+U, Ctrl+Alt+S, Alt+L / Alt+Shift+L, F2, Alt+0 / Alt+Shift+0, Ctrl+P, Ctrl+Alt+E / Ctrl+Shift+E | ACE defaults: find next/previous, select all, delete line, duplicate, line/block comment, move lines, copy lines, increment number, indent/outdent, block indent, upper/lower case, sort lines, fold/unfold, toggle fold, fold others/unfold all, jump to matching bracket, record/replay macro. In the search box: Enter / Shift+Enter, Alt+Enter, Alt+R, Alt+C, Alt+B, Ctrl+H, Esc. Ctrl+L (go to line), F1 (command palette) and Ctrl+, (settings) need extensions that are not bundled | ACE buffer focused (Code, Markdown, bare) | n/a | none for an image | `TextEditor.vue:127-135`; `aceSetup.ts:12-33`; ace-builds default commands |
| Ctrl+S / Cmd+S | Save the drawing | Drawing editor, window | yes | not while busy; not with a picker or Add text open; not in `INPUT`/`TEXTAREA`; not on the refusal panel (the one editor whose Ctrl+S is safe there: the handler returns while `sketch` is null) | `SketchEditor.vue:204-217` |
| Ctrl+Z / Cmd+Z | Undo | Drawing editor | yes | not with a picker or Add text open; not in `INPUT`/`TEXTAREA`; not on the refusal panel (busy does not gate this) | `SketchEditor.vue:218-221` |
| Ctrl+Shift+Z / Cmd+Shift+Z, Ctrl+Y / Cmd+Y | Redo | Drawing editor | yes | same gates as Undo | `SketchEditor.vue:218-224` |
| Delete, Backspace | Delete the selected shape | Drawing editor, when something is selected | yes | same gates as Undo | `SketchEditor.vue:225-227` |
| Escape | Clear the selection; inside a picker, close the picker | Drawing editor | yes | same gates as Undo; picker panel overrides | `SketchEditor.vue:228-230`; `SketchPickerModal.vue:40` |
| Shift (held) | Snap rotation to 15° | Drawing canvas, rotate drag | n/a | read on every pointer move, so pressing or releasing Shift mid-drag changes snapping from the next movement | `SketchCanvas.vue:275-279`; `sketchModel.ts:144` |
| Enter | Confirm Add text | Drawing editor, Add text field | n/a | on key release (`OyaTextField`'s keyup), with any modifier held; an empty field is ignored | `SketchEditor.vue:309`; `OyaTextField.vue:30` |
| Enter | Submit the passphrase dialog | the passphrase dialog in any mode (open, encrypt, decrypt), either password field | n/a | ignored while busy; with an empty password it shows "Enter the password." rather than staying inert (the button is disabled, the key is not); when encrypting a mismatch shows the mismatch error | `LockModal.vue:52-62, 98, 102` |
| Enter | Run the folder dialog | the folder dialog, either password field | n/a | only when the run button would be enabled; otherwise nothing happens (a mismatch between the two fields is already shown as they are typed) | `FolderLockModal.vue:71-79, 88-89, 151, 155` |
| Enter | Save the tags | the tag dialog, any of the three fields | n/a | ignored while loading or saving | `TagModal.vue:64-66, 92` |
| Enter | Run a row shield or open the folder dialog from a folder shield | the shield focused (Tab reaches it right after its row) | n/a | the row itself is not opened or toggled; Space does nothing on a shield | `FilesPanel.vue:312, 324` |

Ctrl+S on a refusal panel is safe only in the Drawing editor, whose handler
returns while `sketch` is null. In Write and Presentations the handler still
runs and saves the editor's empty seed document over the file; in Sheet it
re-writes the bytes that were read.

The dialogs that encryption, tags and Mana brought (passphrase, folder, tag,
Mana confirmation) do not hold the editors' window shortcuts. Ctrl+S typed in
one of their fields still saves the document behind it in Write and Sheet,
whose handlers do not look at the focus target; Presentations and Drawing
ignore it inside an input.

There is no shortcut for the Files panel, the workspace search, Workspace
security, Settings, New, Save As, the export commands, the file shield,
encrypting or decrypting, tags, the language or dark-mode toggles, the
workspace picker or the recent list, or any dialog's buttons (Ctrl+N is
unbound, and Ctrl+Shift+S is plain Save, see above). No modal in the app
closes on Escape except the drawing pickers and the deck player; `OyaModal`
closes only on a backdrop click or its own buttons
(`packages/rakotis/src/components/primitives/OyaModal.vue:38-40`). The file
shield's panel is a popover, not a modal, and does close on Escape.

## What is remembered

Three places hold anything across a restart: the app's `localStorage`, the
system keyring (one remembered passphrase), and each workspace's own
`.morion/metadata.json`. Apart from these, the app writes only the files the
user saves, encrypts, decrypts or exports, each through a short-lived sibling
temporary (see Workspaces).

### Browser storage

All keys are `localStorage` keys of the app's own origin, prefixed `zinnia:`
after the bundle identifier. Reads and writes are wrapped in `try/catch` where
noted, so a blocked store only loses persistence.

| Key | Values | Meaning | Written when | Source |
|---|---|---|---|---|
| `zinnia:dark` | "1" dark, "0" light | Dark mode. Absent: follows the OS; dark if `matchMedia` is unavailable. Not try/caught. | every change, including startup (immediate watcher) | `App.vue:31-39` |
| `zinnia:files` | "0" closed, anything else (or absent) open | Whether the Files panel is toggled on. Default on. Not try/caught. | every toggle (no write at startup); the start screen's "Search the workspace" forces it on | `App.vue:78-79, 185-189` |
| `zinnia:locale` | "en", "pl" | UI language. Absent or unsupported: `navigator.language` starting "pl", else en. Try/caught. | the PL/EN button | `apps/morion/src/i18n/index.ts:17-33`; `packages/petalite/src/i18n/index.ts:31-59` |
| `zinnia:workspace` | JSON `{"root": "<absolute path>"}` | The open workspace. Only the path is kept, and that is enough: the first refresh after launch hands it to Rust (`workspace_open`), which reopens it without a dialog and may answer a canonical spelling that is then stored back. Rust holds the open workspace in process memory only, so this key is what survives a restart. "Can’t read this folder." appears only when Rust refuses the remembered path (moved, deleted, not a folder). Removed only by `clearRoot()`, which no UI calls, so a workspace can be replaced but not forgotten. Try/caught. | every successful switch (a pick or the ☰ menu's Recent list), plus a re-write when the first refresh after launch gets a different canonical spelling back | `useWorkspace.ts:106, 164-181, 294-314, 381-392, 447-461` |
| `zinnia:workspaces:recent` | JSON array of absolute paths, most recent first, at most 6, no duplicates | The folders that have been the workspace; the ☰ menu's Recent list shows them minus the open one. Read once at module load, try/caught; a non-array, or non-string entries, are dropped. Never pruned: `clearRoot()` leaves it alone and no UI clears it, so a folder deleted since stays listed, and choosing it is refused while the current workspace stays. | every successful switch; a refused folder is not added | `useWorkspace.ts:107-112, 183-201, 311`; `App.vue:85, 332-341` |
| `zinnia:searchMode` | "quick", "full" or "hybrid" | The search algorithm (Settings → Search algorithm). Absent, unreadable or any other value: "hybrid". Read once at module load. Try/caught on read and write. | every pick in Settings | `apps/morion/src/files/searchSettings.ts:7-34` |
| `zinnia:systemColors` | JSON `{accent, warning, success, highlight, mute}` of hex strings | The five system colours. Read once at module import; an older `{light, dark}` per-role shape is accepted, taking the light value; unparseable storage falls back to defaults silently. Merged per role, not all-or-nothing: a role that is missing (older build) or not a `#rgb`/`#rrggbb` string takes its default while the other stored roles are kept; only unreadable or unparseable JSON resets all five. | every pick and Restore defaults | `systemColors.ts:44, 50-54, 65-97`; `useSystemColors.ts:19-40` |
| `zinnia:sandbox` | "1" on; written as "1"/"0"; anything else off | "Render a file's own markup in isolation". Read once at module load. Try/caught on read and write. | every toggle | `useMarkupSafety.ts:30-34, 40-46, 62-69` |
| `zinnia:blockStyles` | "1" on; written as "1"/"0" | "Block style sheets". Try/caught. | every toggle | same |
| `zinnia:blockScripts` | "1" on; written as "1"/"0" | "Block scripts". Try/caught. | every toggle | same |

### The remembered passphrase

Not in browser storage. When a passphrase dialog's Remember box is ticked and
the dialog's action then succeeds (opening an encrypted file, encrypting or
decrypting one from the file shield or a row shield, or fetching the key to
save a file encrypted while open; see Encryption), the passphrase goes to Rust
(`secret_remember`) and lives in the OS keyring, or in process memory until the
app closes when no keyring is available. The front end can only ask whether one
is remembered and where (`secret_status`) and forget it (`secret_forget`, the
Workspace security view's "Forget it"); nothing returns it
(`packages/padova/src/lock.ts:93-118`;
`apps/morion/src-tauri/src/secrets.rs:9-29`). The keyring entry is one slot
per app: service `com.spectrumaipl.zinnia` (the bundle identifier), account
`file-passphrase`, so a keyring listing reveals only that the app is installed,
never a file path. `secret_remember` tries the keyring first and, if it takes
the passphrase, empties the memory slot so the two cannot disagree; only when
the keyring refuses does the process-memory slot hold it. `secret_forget`
clears both unconditionally. The read-back (`Locker::recall`) is `pub(crate)`,
used only by the sealing functions inside Rust
(`apps/morion/src-tauri/src/lib.rs:67-70`;
`crates/padova/src/secrets.rs:31-118`).

### `.morion/metadata.json`

Each workspace keeps its own metadata file at
`<workspace>/.morion/metadata.json` (`apps/morion/src-tauri/src/meta.rs`),
created on the first tag save or the first Mana charge or event, written
atomically and pretty-printed, hidden from the tree, the search, folder runs
and the Workspace security counts, and refused by every command that takes a
path ("That is Morion’s own metadata folder.", see Workspaces). It travels
with the folder: copy the workspace and its tags and Mana history come along.

Morion writes three fields into it (`meta.rs:34-56`):

* `version`: 1.
* `tags`: for each tagged file, keyed by its path relative to the workspace
  root with forward slashes (never an absolute path), up to three tags, each
  trimmed, at most 32 characters, no two equal ignoring ASCII case. Plain text
  by design, including the tags of encrypted files. A file whose tags are all
  removed loses its entry.
* `ledger`: the Security Mana history, at most 500 rows, oldest dropped first,
  each with `ts`, `action`, an optional workspace-relative `path`, `cost` and
  `note` (see Security Mana).

It may never contain a passphrase, any byte read from a file's contents,
decrypted or not, a search query, result or snippet, or an absolute path from
anywhere (`meta.rs:13-16`; `mana.rs:30-33, 161-170`). A file there that does
not parse is refused rather than overwritten: the header shows no tags, the tag
dialog says "The workspace’s .morion/metadata.json is damaged, so tags cannot
be changed. Nothing was changed." (`workspace.errors.meta_damaged`) when it
opens and when it saves, Mana quietly shows no price and no confirmation and
charges nothing, the Workspace security meters disappear and its history reads
"Nothing yet." (its price table, which does not read the file, stays), and the
search finds no tags, until the file is repaired or removed (`meta.rs:68-78`;
`mana.rs:212-258`).

### Nothing else

The search query and its results, the tree's expansion, the shield panel,
zoom, tools, colours, language picks, undo stacks and the Source/Editor choice
all live in mounted components or in the page's store and are lost on remount
or restart; the tree's expansion is also lost on a workspace switch. The open
file is not remembered: the app always starts on the start screen, with the
remembered workspace reopened. Rust keeps the open workspace and the keys of
open encrypted files only in process memory (`WorkspaceState`,
`workspace.rs:38-54`; `SealSessions`, `sealed.rs:25-63`), so every such key is
gone when the app closes. It registers no settings or window-state plugin
(`lib.rs:74-111`), so window size and position are not restored either. Every
editor persists only the file it writes.

## Test ids

Grouped by region. `{…}` marks a variable part.

### Header and shell (`App.vue`)

| `data-testid` | Element |
|---|---|
| `app-menu` | the ☰ button |
| `app-menu-panel` | the open menu panel |
| `files-toggle` | the Files panel button |
| `view-title` | the "Workspace security" / "Settings" title while a view is up |
| `view-close` | the × beside it |
| `file-name` | the open file's name |
| `file-shield` | the encryption shield beside the file name (`data-sealed` is "1" or "0") |
| `file-shield-panel` | its panel |
| `file-shield-status` | the panel's status sentence |
| `file-shield-encrypt`, `file-shield-decrypt` | "Encrypt with a passphrase…" (plain file) and "Decrypt permanently…" (encrypted file); only one is present |
| `file-shield-blocker` | "Save the file first." / "Save your changes first." |
| `file-shield-limits` | what encryption does not hide |
| `file-tags` | the tags button (only for a file with a path) |
| `file-tag-{i}` | a tag chip in it, 0-based |
| `file-error` | the host's file error: "Could not open the file. {sentence}", "Could not save. {sentence}", "Choose a workspace folder first.", "Not saved: the file is encrypted and its passphrase was not given.", or a failed decrypt's sentence |
| `export-error` | "Could not export. {reason}" after an export that failed past its editor (editor view only) |
| `dark-toggle` | the sun/moon button |
| (none) | the unsaved dot, the notice and the PL/EN button carry no id |

### ☰ menu (`App.vue`)

| `data-testid` | Element |
|---|---|
| `menu-workspace` | the Workspace row that unfolds the section |
| `menu-workspace-name` | the folder name (or "No workspace open") inside that row |
| `menu-workspace-path` | the full folder path line (unfolded, folder set) |
| `menu-workspace-pick` | "Change folder…" / "Choose a folder…" (unfolded) |
| `menu-workspace-recent-{i}` | a recent-folder row, 0-based, without the open folder (unfolded) |
| `menu-workspace-hint` | the one-line explanation of what a workspace is (unfolded) |
| `menu-new` | New ▾ |
| `menu-new-document`, `menu-new-deck`, `menu-new-sheet`, `menu-new-sketch`, `menu-new-markdown`, `menu-new-code` | the six New rows (unfolded) |
| `menu-open`, `menu-save`, `menu-saveAs` | Open…, Save, Save As… |
| `menu-export` | the first export entry ("Export sheet as CSV…" or "Export as PNG") |
| `menu-export-{i}` | later export entries (none today) |
| `menu-settings` | Settings; there is no `menu-security` any more |

### Start screen (`StartView.vue`)

| `data-testid` | Element |
|---|---|
| `start` | the whole start screen |
| `start-workspace` | the Workspace card |
| `start-workspace-name` | the folder name in it (folder set) |
| `start-workspace-none` | "No workspace open" (no folder) |
| `start-workspace-pick` | its "Change folder…" / "Choose a folder…" button |
| `start-new-document`, `start-new-deck`, `start-new-sheet`, `start-new-sketch`, `start-new-markdown`, `start-new-code` | the six kind buttons |
| `start-open` | Open… |
| `start-search` | "Search the workspace" |

### Editor host (`EditorHost.vue`, `OyaModal.vue`)

| `data-testid` | Element |
|---|---|
| `discard-cancel`, `discard-confirm` | the discard prompt's buttons |
| `lock-consequence` | the consequence line in the host's passphrase dialog: what opening or decrypting permanently does (shown with or without a price), or "This file was encrypted while it was open. …" when the key is fetched for a save |
| `oya-modal-overlay` | the overlay of every `OyaModal` (discard prompt, passphrase, folder and tag dialogs, Mana confirmation, Page setup, Formula, Insert a table, block editor, deck settings, Add text, pickers) |

### Files sidepanel (`FilesPanel.vue`, `FileTree.vue`)

| `data-testid` | Element |
|---|---|
| `files-panel` | the `<aside>` |
| `files-root` | the folder-name header |
| `files-refresh` | Refresh |
| `files-security` | the Workspace security shield in the header |
| `files-change` | Change folder |
| `files-pick` | Choose a folder |
| `files-empty` | the no-folder / unreadable branch |
| `files-unreadable` | "Can’t read this folder." |
| `files-pick-error` | the picker's error in the no-folder branch: "This needs the desktop app." in a browser, or Rust's refusal when a folder cannot be opened |
| `files-error` | the store's error line under the search box (a sub-folder read, a refused switch) |
| `files-tree` | the scrollable tree (hidden while a query is typed) |
| `files-row-{name}` | a tree row, by bare name |
| `folder-shield-{name}` | a folder row's shield, by bare name |
| `row-shield-{name}` | a file row's encrypt/decrypt shield, by bare name |
| `files-nothing` | "Nothing here." |
| `files-open-error` | the open-error line at the bottom |
| `lock-consequence` | the consequence line in the row shields' passphrase dialog (decrypting, with a price) |

The old name filter (`files-filter`) is gone; the search box replaced it.

### Workspace search (`WorkspaceSearch.vue`)

| `data-testid` | Element |
|---|---|
| `workspace-search-panel` | the block at the top of the panel |
| `workspace-search` | the search box |
| `workspace-search-results` | the `<ul>` of hits |
| `search-result-{i}` | a hit's button, 0-based |
| `search-matched-{i}` | how that hit matched ("name · text", …) |
| `search-snippet-{i}` | that hit's matching line (only when it has one) |
| `workspace-search-empty` | "Nothing in the workspace matches." |
| `workspace-search-error` | "Search failed. …" |

The notes search's ids (`notes-search-panel`, `notes-search`, `notes-results`,
`notes-result-{i}`, `notes-search-empty`, `notes-search-error`) are gone.

### Passphrase dialog (`packages/padova/src/components/LockModal.vue`)

| `data-testid` | Element |
|---|---|
| `lock-open-hint` | the hint in `open` mode |
| `lock-unlock-hint` | the hint in `unlock` mode (the `lock` mode hint has none) |
| `lock-password` | the password field |
| `lock-confirm` | the repeat field (`lock` mode only) |
| `lock-remember` | the Remember checkbox |
| `lock-error` | the error line |
| `lock-submit` | Open / Encrypt / Decrypt (disabled until a password is typed); Cancel has no id |

### Folder dialog (`FolderLockModal.vue`)

| `data-testid` | Element |
|---|---|
| `folder-preview` | "{files} files here: …" with the links and truncation notes |
| `folder-preview-error` | a failed preview |
| `folder-mode-lock`, `folder-mode-unlock` | the "Encrypt all" and "Decrypt all" radios |
| `folder-note` | the explanation under them |
| `folder-consequence` | the decrypt consequence line (with a price) |
| `folder-password`, `folder-confirm` | the password and repeat fields (repeat only when encrypting) |
| `folder-mismatch` | "Those two do not match." while the repeat field differs (encrypting only) |
| `folder-error` | the error line |
| `folder-report` | the report after a run |
| `folder-untried` | the report's line for files not tried after a wrong passphrase (only when a decrypt run stopped early) |
| `folder-failure` | one failed file in the report |
| `folder-close` | Cancel, then Close |
| `folder-run` | "Encrypt all" / "Decrypt all" |

### Tag dialog (`TagModal.vue`)

| `data-testid` | Element |
|---|---|
| `tag-field-0`, `tag-field-1`, `tag-field-2` | the three fields |
| `tags-note` | the plain-text note |
| `tags-sealed-note` | the sharper note for an encrypted file |
| `tags-consequence` | "A new tag on an encrypted file is a word about it in plain text." above the price (encrypted file, with a price) |
| `tags-error` | the error line |
| `tags-save` | Save; Cancel has no id |

### Security Mana (`ManaConfirm.vue`, `ManaCost.vue`)

| `data-testid` | Element |
|---|---|
| `mana-consequence` | the confirmation's consequence sentence |
| `mana-cancel`, `mana-continue` | the confirmation's buttons |
| `mana-cost` | the price block, wherever it appears (confirmation, passphrase, folder and tag dialogs) |
| `mana-after` | "Leaves … of 100 for today and … of 700 for the week." |
| `mana-exhausted` | the used-up warning inside a price block |

### Workspace security (`WorkspaceSecurity.vue`)

| `data-testid` | Element |
|---|---|
| `workspace-security` | the view |
| `security-workspace-name` | the folder name under the heading |
| `security-no-workspace` | "Choose a workspace folder first." (no workspace) |
| `security-summary` | the Files section |
| `security-count-sealed`, `security-count-plain`, `security-count-files` | the three counts |
| `security-truncated` | the note that the count stopped at 20,000 files |
| `security-passphrase` | the Passphrase section |
| `security-secret-status` | its sentence |
| `security-forget` | Forget it (only while one is remembered) |
| `security-mana` | the Security Mana section |
| `mana-meter-daily`, `mana-meter-weekly` | the two meters |
| `security-mana-exhausted` | the used-up warning under them |
| `mana-prices` | the price table |
| `mana-price-{id}` | a price cell: `unlock_temp`, `decrypt_file`, `decrypt_folder`, `export_plain`, `tag_sealed` |
| `security-history` | the Recent security actions section |
| `security-history-empty` | "Nothing yet." |
| `security-history-{i}` | a history row, newest first, 0-based |
| `security-limits` | the "What encryption does not hide" box |

Padova's Security view is no longer mounted, so its ids (`secret-row`,
`secret-forget`, `security-action-error`, `security-files-none`,
`security-files-pick`, `security-files-filter`, `security-files-refresh`,
`security-files`, `security-row-{name}`, `security-sealed-{name}`,
`security-files-empty`) no longer appear in Morion; only the component test
of padova's view, `apps/morion/tests/component/securityView.test.ts`, still
uses them.

### Write editor (`DocumentEditor.vue`, `CsvTableModal.vue`, `FormulaPreview.vue`)

| `data-testid` | Element |
|---|---|
| `doc-parse-error` | the refusal panel's message line (its "Open as plain text" button has none) |
| `ink-accent`, `ink-success`, `ink-warn` | the ink swatches |
| `tone-note`, `tone-warn`, `tone-tip`, `tone-quote` | the callout buttons |
| `doc-formula`, `doc-table` | Formula and Table |
| `blk-add`, `blk-up`, `blk-down`, `blk-del` | the block operations |
| `view-wysiwyg`, `view-source` | the Editor / Source pill |
| `doc-setup` | Page setup |
| `doc-body` | the TipTap surface |
| `doc-source` | the Source textarea |
| `doc-title`, `doc-toc` | Page setup's Title field and Contents page checkbox (the font and margin chips, the Cover checkbox and Close have none) |
| `csv-input`, `csv-load`, `csv-delimiter`, `csv-header`, `csv-error`, `csv-preview`, `csv-too-big`, `csv-insert` | the Insert a table dialog |
| `formula-input`, `formula-preview` | the Formula dialog |

### Presentations editor (`PresentationEditor.vue`, `RichPayloadEditor.vue`, `DeckPlayer.vue`, `ShadowHtml.vue`, `SelectMenu.vue`)

| `data-testid` | Element |
|---|---|
| `deck-parse-error` | the refusal panel's message line (its "Open as plain text" button has none) |
| `add-slide` | New slide |
| `layout-select` | the Layout dropdown root; inside it `select-trigger`, `select-panel`, `select-option-{layout}` |
| `deck-play` | Present |
| `slide-counter` | "n / total" |
| `deck-setup` | Deck settings |
| `filmstrip-{index}` | a filmstrip button, 0-based |
| `slide-title` | the slide title field |
| `block-{blockId}` | a block card |
| `edit-{blockId}` | its Edit button |
| `select-trigger`, `select-panel`, `select-option-{slot}` | the per-block slot dropdown, inside the card (only on layouts with more than one box) |
| `add-{type}-{slot}` | an add-block chip; the unnamed slot is `main` |
| `block-rich` | the rich payload editor |
| `rich-bold`, `rich-italic`, `rich-underline`, `rich-ul`, `rich-ol` | its buttons |
| `block-import`, `block-import-error` | Import from file… and its error |
| `block-payload` | the payload textarea (image, svg, formula, code) |
| `formula-preview` | the formula preview in the block modal |
| `block-commit` | the modal's Save |
| `deck-title` | Deck settings' Title field |
| (none) | Delete slide, Move back/forward, a block's Move up/Move down/Delete, the list-item editor rows, and Deck settings' theme and font chips carry no id; reach them by aria-label |
| `player-close` | the player's close button |
| `shadow-host` | an isolated svg/html block's host div |

### Sheet editor (`SheetEditor.vue`)

| `data-testid` | Element |
|---|---|
| `univer-host` | the container Univer mounts into |
| `sheet-open-text` | "Open as plain text" in the not-a-sheet panel (the grid-failed panel's button has none) |
| `sheet-mount-error` | the grid-failed panel's message |

### Drawing editor (`SketchEditor.vue`, `SketchToolbar.vue`, `SketchPickerModal.vue`, `SketchCanvas.vue`)

| `data-testid` | Element |
|---|---|
| `svg-refusal` | the refusal sentence |
| `svg-open-text` | "Open as plain text" |
| `svg-opaque-notice` | the "{n} parts of this file can't be edited here" line |
| `trigger-zoom`, `trigger-brush`, `trigger-pen`, `trigger-fill`, `trigger-board` | the five picker triggers (`trigger-fill` renders only while a fillable shape is selected or the rectangle, ellipse or triangle tool is active) |
| `modal-zoom`, `modal-brush`, `modal-pen`, `modal-fill`, `modal-board` | the five picker panels |
| `zoom-0.5`, `zoom-0.75`, `zoom-1`, `zoom-1.5`, `zoom-2`, `zoom-3`, `zoom-4` | zoom steps |
| `width-2`, `width-4`, `width-8`, `width-16` | stroke widths |
| `opacity-0.25`, `opacity-0.5`, `opacity-0.75`, `opacity-1` | transparency steps |
| `textsize-16`, `textsize-24`, `textsize-36`, `textsize-56` | text sizes |
| `headwidth-2.4`, `headwidth-3.6`, `headwidth-5.4` | arrow head widths |
| `brush-sticky` | the Sticky checkbox |
| `swatch-black`, `swatch-white`, `swatch-accent`, `swatch-warning`, `swatch-success`, `swatch-highlight`, `swatch-mute` | pen colour swatches |
| `fill-none`, `fill-swatch-{role}` | fill picker |
| `board-none`, `board-ffffff`, `board-111827`, `board-swatch-{role}` | board picker colours |
| `board-image`, `board-image-remove` | background image buttons (`board-image-remove` renders only while an image is set) |
| `picker-close` | every picker's Close |
| `peer-live`, `peer-cursor` | collaboration elements that never render in Morion |
| (none) | the nine tool buttons, the rotation field, Undo, Redo, Delete selection, Clear board and the Add text dialog's field and buttons carry no id; reach them by aria-label |

### Code, Markdown and bare text editors (`TextEditor.vue`, `SelectMenu.vue`)

| `data-testid` | Element |
|---|---|
| `editor-undo`, `editor-redo` | the undo/redo buttons |
| `language-select` | the Language dropdown root; inside it `select-trigger`, `select-panel`, `select-option-empty` (Plain text), `select-option-{Label}` |
| `ace-host` | the ACE buffer |
| `image-view`, `image-preview` | the image viewer container and its `<img>` |

### Settings (`SettingsView.vue`)

| `data-testid` | Element |
|---|---|
| `role-{role}` for `accent`, `warning`, `success`, `highlight`, `mute` | a colour row |
| `color-{role}` | its `<input type="color">` |
| `primary-text` | the Body text row |
| `colors-reset` | Restore defaults |
| `search-modes` | the search algorithm card |
| `search-mode-row-{mode}` for `quick`, `full`, `hybrid` | an algorithm row |
| `search-mode-{mode}` | its radio |
| `search-privacy-note` | the note under the card |
| `markup-safety` | the switches card |
| `switch-row-{which}` for `isolate`, `blockStyles`, `blockScripts` | a switch row |
| `switch-{which}` | its checkbox |
