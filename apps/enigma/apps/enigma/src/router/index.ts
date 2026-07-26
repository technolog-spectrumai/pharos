import { createRouter, createMemoryHistory } from "vue-router";
import { getBuildConfig } from "rakotis";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaFilesView from "../views/EnigmaFilesView.vue";
import EnigmaCallsView from "../views/EnigmaCallsView.vue";
import EnigmaCalendarView from "../views/EnigmaCalendarView.vue";
import EnigmaNotesView from "../views/EnigmaNotesView.vue";
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
    // Voice calls / calendar / contacts — build-gated editions (pland.md), same
    // `beforeEnter` pattern as the board below.
    {
      path: "/calls",
      component: EnigmaCallsView,
      name: "calls",
      beforeEnter: () => getBuildConfig().calls_enabled || "/chat",
    },
    {
      path: "/calendar",
      component: EnigmaCalendarView,
      name: "calendar",
      beforeEnter: () => getBuildConfig().calendar_enabled || "/chat",
    },
    // Notes — one tab hosting the Board (kanban), Sketch, and Mind workspaces as
    // sub-tabs (EnigmaNotesView). `beforeEnter` runs at navigation time (after
    // initBuildConfig resolved), so it reads the real flags; when all three are
    // off the whole tab redirects to chat. (A top-level `if` in this table would
    // run at module-eval time, before initBuildConfig — too early.)
    {
      path: "/notes",
      component: EnigmaNotesView,
      name: "notes",
      beforeEnter: () => {
        const c = getBuildConfig();
        return c.kanban_enabled || c.sketch_enabled || c.mind_enabled || "/chat";
      },
    },
    // Legacy per-feature paths now open the matching Notes sub-tab.
    { path: "/board", redirect: "/notes?tab=board" },
    { path: "/sketch", redirect: "/notes?tab=sketch" },
    { path: "/mind", redirect: "/notes?tab=mind" },
    // Maps (MapLibre + PMTiles) — same compile-time gate pattern as Notes.
    {
      path: "/map",
      component: EnigmaMapView,
      name: "map",
      beforeEnter: () => getBuildConfig().maps_enabled || "/chat",
    },
    {
      path: "/contacts",
      component: EnigmaContactsView,
      name: "contacts",
      beforeEnter: () => getBuildConfig().contacts_enabled || "/chat",
    },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    // Profile now lives inside Settings (as a tab) — keep the old path working.
    { path: "/profile", redirect: "/config?tab=profile" },
  ],
});

export default router;
