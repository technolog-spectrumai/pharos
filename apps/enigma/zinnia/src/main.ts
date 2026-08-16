// FIRST: registers the fatal-error handlers before anything else evaluates.
import { installVueErrorHandler } from "./errorOverlay";
import { createApp } from "vue";
import { createPinia } from "pinia";
import "./style.css";
import "./slide.css";
import "./document.css";
import App from "./App.vue";
import { i18n } from "./i18n";
// Imported for its side effect: publishes the system palette as custom
// properties before the first paint.
import "./useSystemColors";

// FontAwesome. The icon set lives in ./icons so a test can import it without
// mounting the app — see the note there on why an unregistered name is silent.
import "./icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

const app = createApp(App)
  .use(createPinia())
  .use(i18n)
  .component("font-awesome-icon", FontAwesomeIcon);

installVueErrorHandler(app);
app.mount("#app");
