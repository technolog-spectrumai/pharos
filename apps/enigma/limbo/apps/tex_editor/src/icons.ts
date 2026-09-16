// Every icon the UI names, registered in one place.
//
// FontAwesome renders an icon it does not know as NOTHING — no warning, no
// console line, just an empty comment node where a glyph should be. That
// failure is invisible in tests that assert on behaviour and easy to miss in a
// screenshot, and it has shipped twice in this repo already.
//
// So this lives apart from main.ts: a module that only registers icons can be
// imported by a test, which is what `tests/unit/icons.test.ts` does to prove
// that every name any template actually uses resolves to a real glyph.
import { library } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowLeft, faBan, faBroom, faChevronDown, faChevronRight, faCircleInfo,
  faFile, faFileCode, faFloppyDisk, faFolder, faFolderOpen, faKey, faLock,
  faMoon, faPlay, faPlug, faRotate, faServer, faSpinner, faSun,
  faTriangleExclamation, faXmark,
} from "@fortawesome/free-solid-svg-icons";

library.add(
  faArrowLeft, faBan, faBroom, faChevronDown, faChevronRight, faCircleInfo,
  faFile, faFileCode, faFloppyDisk, faFolder, faFolderOpen, faKey, faLock,
  faMoon, faPlay, faPlug, faRotate, faServer, faSpinner, faSun,
  faTriangleExclamation, faXmark,
);
