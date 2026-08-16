// FIRST: registers the fatal-error handlers before anything else evaluates.
import { installVueErrorHandler } from "./errorOverlay";
import { createApp } from "vue";
import { createPinia } from "pinia";
import "./style.css";
import App from "./App.vue";

const app = createApp(App).use(createPinia());
installVueErrorHandler(app);
app.mount("#app");
