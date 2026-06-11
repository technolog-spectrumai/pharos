import { createRouter, createMemoryHistory } from "vue-router";
import EnigmaWelcomeView from "../views/EnigmaWelcomeView.vue";
import RelayChatView from "../views/RelayChatView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";
import EnigmaProfileView from "../views/EnigmaProfileView.vue";
import EnigmaLoginView from "../views/EnigmaLoginView.vue";
import VaultView from "../views/VaultView.vue";
import TasksView from "../views/TasksView.vue";
import LocationsView from "../views/LocationsView.vue";
import SocialhubView from "../views/SocialhubView.vue";
import EventsView from "../views/EventsView.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: EnigmaWelcomeView, name: "welcome" },
    { path: "/login", component: EnigmaLoginView, name: "login" },
    { path: "/chat", component: RelayChatView, name: "chat" },
    { path: "/vault", component: VaultView, name: "vault" },
    { path: "/tasks", component: TasksView, name: "tasks" },
    { path: "/locations", component: LocationsView, name: "locations" },
    { path: "/people", component: SocialhubView, name: "people" },
    { path: "/events", component: EventsView, name: "events" },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    { path: "/profile", component: EnigmaProfileView, name: "profile" },
  ],
});

export default router;
