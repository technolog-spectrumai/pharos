import { createRouter, createMemoryHistory } from "vue-router";
import EnigmaWelcomeView from "../views/EnigmaWelcomeView.vue";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: EnigmaWelcomeView, name: "welcome" },
    { path: "/chat", component: EnigmaChatView, name: "chat" },
    { path: "/config", component: EnigmaConfigView, name: "config" },
  ],
});

export default router;
