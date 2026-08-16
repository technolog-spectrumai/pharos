// FIRST: registers the fatal-error handlers before anything else evaluates.
import { installVueErrorHandler } from "./errorOverlay";
import { createApp } from "vue";
import { createPinia } from "pinia";
import "./style.css";
import "./slide.css";
import "./document.css";
import App from "./App.vue";
import { i18n } from "./i18n";

// FontAwesome: explicit imports only, so the bundle carries exactly what the
// UI names. An icon missing from this list renders as nothing — if one goes
// blank, it belongs here.
import { library } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import {
  faArrowPointer, faArrowRight, faBan, faBold, faBroom, faCircle, faCircleInfo, faCode,
  fa1, fa2, fa3, faArrowDown, faArrowLeft, faArrowUp, faFileLines, faFilePowerpoint, faGear,
  faHeading, faLightbulb, faPenNib, faQuoteLeft, faItalic, faListOl, faListUl, faQuoteRight, faScissors,
  faSquareRootVariable, faTable, faUnderline,
  faEraser, faFileCirclePlus, faFileImage, faFilePen, faFloppyDisk, faFolderOpen, faFont,
  faImage, faPencil, faPlay, faRotate, faRotateLeft, faRotateRight, faMoon, faSpinner, faSun, faTableCells,
  faSquare, faTrash, faTriangleExclamation, faXmark,
} from "@fortawesome/free-solid-svg-icons";

library.add(
  faArrowPointer, faArrowRight, faBan, faBold, faBroom, faCircle, faCircleInfo, faCode,
  fa1, fa2, fa3, faArrowDown, faArrowLeft, faArrowUp, faFileLines, faFilePowerpoint, faGear,
  faHeading, faLightbulb, faPenNib, faQuoteLeft, faItalic, faListOl, faListUl, faQuoteRight, faScissors,
  faSquareRootVariable, faTable, faUnderline,
  faEraser, faFileCirclePlus, faFileImage, faFilePen, faFloppyDisk, faFolderOpen, faFont,
  faImage, faPencil, faPlay, faRotate, faRotateLeft, faRotateRight, faMoon, faSpinner, faSun, faTableCells,
  faSquare, faTrash, faTriangleExclamation, faXmark,
);

const app = createApp(App)
  .use(createPinia())
  .use(i18n)
  .component("font-awesome-icon", FontAwesomeIcon);

installVueErrorHandler(app);
app.mount("#app");
