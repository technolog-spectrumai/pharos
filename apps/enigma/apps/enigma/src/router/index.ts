import { createRouter, createMemoryHistory } from "vue-router";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";

// Enigma is a serverless P2P chat: one chat surface plus settings. There is no
// login — identity is the local offline profile, pairing is a QR-shared ticket.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", component: EnigmaChatView, name: "chat" },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    // Profile now lives inside Settings (as a tab) — keep the old path working.
    { path: "/profile", redirect: "/config?tab=profile" },
  ],
});

export default router;
