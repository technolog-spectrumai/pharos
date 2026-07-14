import { createRouter, createMemoryHistory } from "vue-router";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaFilesView from "../views/EnigmaFilesView.vue";
import EnigmaContactsView from "../views/EnigmaContactsView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";

// Enigma is a serverless P2P chat: one chat surface, P2P file transfer,
// contacts (peer discovery), and settings. There is no login — identity is the
// local offline profile, pairing is a QR-shared ticket.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", component: EnigmaChatView, name: "chat" },
    { path: "/files", component: EnigmaFilesView, name: "files" },
    { path: "/contacts", component: EnigmaContactsView, name: "contacts" },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    // Profile now lives inside Settings (as a tab) — keep the old path working.
    { path: "/profile", redirect: "/config?tab=profile" },
  ],
});

export default router;
