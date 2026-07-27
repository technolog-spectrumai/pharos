import { createRouter, createMemoryHistory } from "vue-router";
import { getBuildConfig } from "rakotis";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaFilesView from "../views/EnigmaFilesView.vue";
import EnigmaVoxView from "../views/EnigmaVoxView.vue";
import EnigmaCalendarView from "../views/EnigmaCalendarView.vue";
import EnigmaContactsView from "../views/EnigmaContactsView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";
import EnigmaMapView from "../views/EnigmaMapView.vue";
import EnigmaCloudView from "../views/EnigmaCloudView.vue";

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
    // Vox (voice calls) / calendar / contacts — build-gated editions (pland.md),
    // same `beforeEnter` pattern as the board below. The tab is called Vox; the
    // build flag stays `calls_enabled`, matching build_config.yaml's section.
    {
      path: "/vox",
      component: EnigmaVoxView,
      name: "vox",
      beforeEnter: () => getBuildConfig().calls_enabled || "/chat",
    },
    {
      path: "/calendar",
      component: EnigmaCalendarView,
      name: "calendar",
      beforeEnter: () => getBuildConfig().calendar_enabled || "/chat",
    },
    // Maps (MapLibre + PMTiles) — compile-time gate, same beforeEnter pattern
    // as the tabs above (a top-level `if` would run before initBuildConfig).
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
    // Cloud — the user's own faros server (files + sealed invites). Compile-time
    // gate only: the tab is always visible in a cloud-capable build; the runtime
    // master switch inside it gates the CONTENT (and, in Rust, every request).
    {
      path: "/cloud",
      component: EnigmaCloudView,
      name: "cloud",
      beforeEnter: () => getBuildConfig().cloud_allow_connections || "/chat",
    },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    // Profile now lives inside Settings (as a tab) — keep the old path working.
    { path: "/profile", redirect: "/config?tab=profile" },
  ],
});

export default router;
