import { createRouter, createMemoryHistory } from "vue-router";
import EnigmaWelcomeView from "../views/EnigmaWelcomeView.vue";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";
import EnigmaLoginView from "../views/EnigmaLoginView.vue";
import VaultView from "../views/VaultView.vue";
import TasksView from "../views/TasksView.vue";
import LocationsView from "../views/LocationsView.vue";
import SocialhubView from "../views/SocialhubView.vue";
import EventsView from "../views/EventsView.vue";
import GraphView from "../views/GraphView.vue";

// enigma_plus = enigma's full secure comms (relay + P2P + Vox chat) AND aurora's data
// workspace (vault, tasks, locations, people, events, graph) in one app.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: EnigmaWelcomeView, name: "welcome" },
    { path: "/login", component: EnigmaLoginView, name: "login" },
    // Full comms chat (relay + P2P + Vox), from enigma.
    { path: "/chat", component: EnigmaChatView, name: "chat" },
    // Data workspace, from aurora.
    { path: "/vault", component: VaultView, name: "vault" },
    { path: "/tasks", component: TasksView, name: "tasks" },
    { path: "/locations", component: LocationsView, name: "locations" },
    { path: "/people", component: SocialhubView, name: "people" },
    { path: "/events", component: EventsView, name: "events" },
    { path: "/graph", component: GraphView, name: "graph" },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    // Profile lives inside Settings (as a tab) — keep the old path working.
    { path: "/profile", redirect: "/config?tab=profile" },
  ],
});

export default router;
