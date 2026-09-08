// The engine writes files through whatever the app gives it — this app has
// the fs plugin, enigma does not. See packages/wisteria/README.md.
import { setWriteFile } from "wisteria/sketchExport";
import { writeFile } from "@tauri-apps/plugin-fs";
setWriteFile((path, bytes) => writeFile(path, bytes));

// FIRST: registers the fatal-error handlers before anything else evaluates.
import { installVueErrorHandler } from "petalite";
import { createApp } from "vue";
import { createPinia } from "pinia";
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

// The file tree draws a padlock; sealing is what knows which files carry one.
// Wiring the two together HERE, rather than importing one from the other, is
// what lets an app ship the tree without the sealing commands on its IPC
// surface. Before `mount`, because the panel reads a folder as it appears.
import { setSealProbe } from "petalite/files";
import { probeSealed } from "padova";

setSealProbe((path) => probeSealed(path));

const app = createApp(App)
  .use(createPinia())
  .use(i18n)
  .component("font-awesome-icon", FontAwesomeIcon);

installVueErrorHandler(app);
app.mount("#app");
