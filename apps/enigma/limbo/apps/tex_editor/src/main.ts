// FIRST: registers the fatal-error handlers before anything else evaluates.
import { installVueErrorHandler } from "petalite";
import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import { i18n } from "./i18n";
// Imported for its side effect: publishes the system palette as custom
// properties before the first paint.
import "petalite/theme/useSystemColors";

// FontAwesome. The icon set lives in ./icons so a test can import it without
// mounting the app — see the note there on why an unregistered name is silent.
import "./icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

// NO pinia and NO seal probe, unlike lazurite and primula.
//
// Pinia: the two stores here are module-level reactive objects, because there
// is exactly one connection and one open workspace per window. A store library
// would add a layer over state that has no second instance.
//
// The seal probe: it answers "is this file on disk encrypted", and this app's
// files are on a server. The vault's own `encrypted` flag travels in the tree
// row instead, which is the only answer that could be right here.
// The offline cache, attached before the first render. The workspace store
// takes it by injection rather than importing it, so this line is the only
// place the desktop store and the pure logic meet — and the unit tests attach
// a Map here instead.
import { cacheStore } from "./platform/cache";
import { useCache } from "./platform/workspace";

useCache(cacheStore);

const app = createApp(App)
  .use(i18n)
  .component("font-awesome-icon", FontAwesomeIcon);

installVueErrorHandler(app);
app.mount("#app");
