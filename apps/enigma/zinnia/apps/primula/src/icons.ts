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
import {
  faAlignLeft, faArrowPointer, faArrowRight, faBan, faBars, faBold, faBroom, faChevronDown, faChevronRight, faFile, faCircle, faCircleInfo, faCode, faLock, faLockOpen,
  faMagnifyingGlass,
  fa1, fa2, fa3, faArrowDown, faArrowLeft, faArrowUp, faFileLines, faFilePowerpoint, faGear,
  faHeading, faLightbulb, faPenNib, faQuoteLeft, faItalic, faListOl, faListUl, faQuoteRight, faScissors,
  faSquarePlus, faSquareRootVariable, faTable, faUnderline,
  faEraser, faFileCode, faFileCirclePlus, faFileImage, faFilePen, faFloppyDisk, faFolder, faFolderOpen, faFont,
  faImage, faPencil, faPlay, faRotate, faRotateLeft, faRotateRight, faMoon, faSpinner, faSun, faTableCells,
  faShieldHalved, faSlash, faSquare, faTrash, faTriangleExclamation, faXmark,
} from "@fortawesome/free-solid-svg-icons";

library.add(
  faAlignLeft, faArrowPointer, faArrowRight, faBan, faBars, faBold, faBroom, faChevronDown, faChevronRight, faFile, faCircle, faCircleInfo, faCode, faLock, faLockOpen,
  faMagnifyingGlass,
  fa1, fa2, fa3, faArrowDown, faArrowLeft, faArrowUp, faFileLines, faFilePowerpoint, faGear,
  faHeading, faLightbulb, faPenNib, faQuoteLeft, faItalic, faListOl, faListUl, faQuoteRight, faScissors,
  faSquarePlus, faSquareRootVariable, faTable, faUnderline,
  faEraser, faFileCode, faFileCirclePlus, faFileImage, faFilePen, faFloppyDisk, faFolder, faFolderOpen, faFont,
  faImage, faPencil, faPlay, faRotate, faRotateLeft, faRotateRight, faMoon, faSpinner, faSun, faTableCells,
  faShieldHalved, faSlash, faSquare, faTrash, faTriangleExclamation, faXmark,
);

