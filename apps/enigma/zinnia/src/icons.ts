// Every icon the UI names, registered in one place.
//
// FontAwesome renders an icon it does not know as NOTHING — no warning, no
// console line, just an empty comment node where a glyph should be. That
// failure is invisible in tests that assert on behaviour and easy to miss in a
// screenshot, and it has already shipped twice here (a batch of unregistered
// names, then a tone whose key was spelled differently from the format's).
//
// So this lives apart from main.ts: a module that only registers icons can be
// imported by a test, which is what `tests/unit/icons.test.ts` does to prove
// that every name any template actually uses resolves to a real glyph.
import { library } from "@fortawesome/fontawesome-svg-core";
import type { Tone } from "./formats/document";
import {
  faAlignLeft, faArrowPointer, faArrowRight, faBan, faBars, faBold, faBroom, faChevronDown, faChevronRight, faFile, faCircle, faCircleInfo, faCloud, faCode, faLock, faPlug,
  faMagnifyingGlass,
  fa1, fa2, fa3, faArrowDown, faArrowLeft, faArrowUp, faFileLines, faFilePowerpoint, faGear,
  faHeading, faLightbulb, faPenNib, faQuoteLeft, faItalic, faListOl, faListUl, faQuoteRight, faScissors,
  faSquarePlus, faSquareRootVariable, faTable, faUnderline,
  faEraser, faFileCode, faFileCirclePlus, faFileImage, faFilePen, faFloppyDisk, faFolder, faFolderOpen, faFolderPlus, faFont, faHardDrive, faDownload,
  faImage, faPencil, faPlay, faRotate, faRotateLeft, faRotateRight, faMoon, faSpinner, faSun, faTableCells,
  faSquare, faTrash, faTriangleExclamation, faXmark,
} from "@fortawesome/free-solid-svg-icons";

library.add(
  faAlignLeft, faArrowPointer, faArrowRight, faBan, faBars, faBold, faBroom, faChevronDown, faChevronRight, faFile, faCircle, faCircleInfo, faCloud, faCode, faLock, faPlug,
  faMagnifyingGlass,
  fa1, fa2, fa3, faArrowDown, faArrowLeft, faArrowUp, faFileLines, faFilePowerpoint, faGear,
  faHeading, faLightbulb, faPenNib, faQuoteLeft, faItalic, faListOl, faListUl, faQuoteRight, faScissors,
  faSquarePlus, faSquareRootVariable, faTable, faUnderline,
  faEraser, faFileCode, faFileCirclePlus, faFileImage, faFilePen, faFloppyDisk, faFolder, faFolderOpen, faFolderPlus, faFont, faHardDrive, faDownload,
  faImage, faPencil, faPlay, faRotate, faRotateLeft, faRotateRight, faMoon, faSpinner, faSun, faTableCells,
  faSquare, faTrash, faTriangleExclamation, faXmark,
);

/** A callout's icon. The tones are cyprian's, so this is the only place that
 *  decides what each one LOOKS like — the format still stores the name.
 *
 *  Keyed by `Tone`, not by `string`: this map was written with a `warning` key
 *  while the format's tone is `warn`, so the lookup returned undefined and the
 *  button rendered an empty box. `Record<string, …>` accepts any key and hands
 *  back a `string` regardless — the union makes a mismatch a build error.
 *
 *  It lives here, beside the registration, because it is a name the templates
 *  reach for INDIRECTLY: the icon scanner in the test cannot see through
 *  `:icon="TONE_ICONS[tone]"`, so the map has to be assertable on its own. */
export const TONE_ICONS: Record<Tone, string> = {
  note: "circle-info",
  warn: "triangle-exclamation",
  tip: "lightbulb",
  quote: "quote-left",
};

/** The folder-tree node icons. Indexed in the template, so the scanner in
 *  tests/unit/icons.test.ts cannot see them — asserted there directly instead,
 *  the same arrangement as TONE_ICONS. */
export const NODE_ICONS = { bucket: "hard-drive", directory: "folder" } as const;
