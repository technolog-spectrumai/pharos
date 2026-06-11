import { createRouter, createMemoryHistory } from "vue-router";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";
import EnigmaProfileView from "../views/EnigmaProfileView.vue";
import EnigmaLoginView from "../views/EnigmaLoginView.vue";

// Enigma is the secure-communication app: chat (relay + P2P), voice calls and
// media only. The data workspace (dashboard, vault, tasks, locations, people,
// events) now lives in Aurora.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/login", component: EnigmaLoginView, name: "login" },
    { path: "/chat", component: EnigmaChatView, name: "chat" },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    { path: "/profile", component: EnigmaProfileView, name: "profile" },
  ],
});

export default router;
