import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";

import { library } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

import {
  faArrowLeft,
  faComments,
  faDoorOpen,
  faPlus,
  faUser,
  faCheck,
  faLock,
  faPaperPlane,
  faMoon,
  faSun,
  faRightFromBracket,
  faGauge,
} from "@fortawesome/free-solid-svg-icons";

library.add(
  faArrowLeft,
  faComments,
  faDoorOpen,
  faPlus,
  faUser,
  faCheck,
  faLock,
  faPaperPlane,
  faMoon,
  faSun,
  faRightFromBracket,
  faGauge
);

createApp(App)
  .component("font-awesome-icon", FontAwesomeIcon)
  .mount("#app");
