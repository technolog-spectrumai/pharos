import { createRouter, createMemoryHistory } from "vue-router";
import EnigmaWelcomeView from "../views/EnigmaWelcomeView.vue";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";
import EnigmaProfileView from "../views/EnigmaProfileView.vue";
import EnigmaLoginView from "../views/EnigmaLoginView.vue";
import NotesView from "../views/NotesView.vue";
import VaultView from "../views/VaultView.vue";
import TasksView from "../views/TasksView.vue";
import LocationsView from "../views/LocationsView.vue";
import SocialhubView from "../views/SocialhubView.vue";
import WalletView from "../views/WalletView.vue";
import EventsView from "../views/EventsView.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: EnigmaWelcomeView, name: "welcome" },
    { path: "/login", component: EnigmaLoginView, name: "login" },
    { path: "/chat", component: EnigmaChatView, name: "chat" },
    { path: "/notes", component: NotesView, name: "notes" },
    { path: "/vault", component: VaultView, name: "vault" },
    { path: "/tasks", component: TasksView, name: "tasks" },
    { path: "/locations", component: LocationsView, name: "locations" },
    { path: "/people", component: SocialhubView, name: "people" },
    { path: "/wallet", component: WalletView, name: "wallet" },
    { path: "/events", component: EventsView, name: "events" },
    { path: "/config", component: EnigmaConfigView, name: "config" },
    { path: "/profile", component: EnigmaProfileView, name: "profile" },
  ],
});

export default router;
