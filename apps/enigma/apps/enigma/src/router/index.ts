import { createRouter, createMemoryHistory } from "vue-router";
import { getBuildConfig } from "rakotis";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaFilesView from "../views/EnigmaFilesView.vue";
import EnigmaCallsView from "../views/EnigmaCallsView.vue";
import EnigmaCalendarView from "../views/EnigmaCalendarView.vue";
import EnigmaKanbanView from "../views/EnigmaKanbanView.vue";
import EnigmaContactsView from "../views/EnigmaContactsView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";
import EnigmaMapView from "../views/EnigmaMapView.vue";

// Enigma is a serverless P2P chat: one chat surface, P2P file transfer,
// meeting scheduling (calendar), contacts (peer discovery), and settings.
// There is no login — identity is the local offline profile, pairing is a
// QR-shared ticket.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", component: EnigmaChatView, name: "chat" },
    { path: "/files", component: EnigmaFilesView, name: "files" },
    { path: "/calls", component: EnigmaCallsView, name: "calls" },
    { path: "/calendar", component: EnigmaCalendarView, name: "calendar" },
    // Group Kanban board — gated by the compile-time build flag. `beforeEnter`
    // runs at navigation time (after initBuildConfig resolved), so it reads the
    // real flag; a flag-off build redirects to chat. (A top-level `if` in this
    // table would run at module-eval time, before initBuildConfig — too early.)
    {
      path: "/board",
      component: EnigmaKanbanView,
      name: "board",
      beforeEnter: () => getBuildConfig().kanban_enabled || "/chat",
    },
    // Maps (MapLibre + PMTiles) — same compile-time gate pattern as the board.
    {
      path: "/map",
      component: EnigmaMapView,
      name: "map",
      beforeEnter: () => getBuildConfig().maps_enabled || "/chat",
    },
    { path: "/contacts", component: EnigmaContactsView, name: "contacts" },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    // Profile now lives inside Settings (as a tab) — keep the old path working.
    { path: "/profile", redirect: "/config?tab=profile" },
  ],
});

export default router;
