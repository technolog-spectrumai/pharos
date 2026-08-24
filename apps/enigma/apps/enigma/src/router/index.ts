import { watch } from "vue";
import { createRouter, createMemoryHistory } from "vue-router";
import EnigmaChatView from "../views/EnigmaChatView.vue";
import EnigmaFilesView from "../views/EnigmaFilesView.vue";
import EnigmaVoxView from "../views/EnigmaVoxView.vue";
import EnigmaCalendarView from "../views/EnigmaCalendarView.vue";
import EnigmaContactsView from "../views/EnigmaContactsView.vue";
import EnigmaConfigView from "../views/EnigmaConfigView.vue";
import EnigmaMapView from "../views/EnigmaMapView.vue";
import EnigmaWelcomeView from "../views/EnigmaWelcomeView.vue";
import EnigmaPrivacyView from "../views/EnigmaPrivacyView.vue";
import { APP_TABS, firstVisiblePath, isTabVisible, visibleTabs, type AppTabId } from "../tabs";

/** Guard for a tab that can be switched off — build gate AND the user's own
 *  choice, both behind `isTabVisible` (src/tabs.ts). Read lazily, inside the
 *  arrow: a top-level `if` would run before initBuildConfig, and before the
 *  vault is unlocked there is no stored choice to read either.
 *
 *  The fallback is computed rather than the literal "/chat" the build gates used
 *  to return: chat is hideable now, so `|| "/chat"` on the chat route would be a
 *  self-redirect ("Detected an infinite redirection in a navigation guard"), and
 *  a user who hid everything has to land on Settings. `firstVisiblePath()` never
 *  returns the path being denied, because that tab is by definition not visible. */
const tabGuard = (id: AppTabId) => () => isTabVisible(id) || firstVisiblePath();

// Enigma26 is a serverless P2P chat: one chat surface, P2P file transfer,
// meeting scheduling (calendar), contacts (peer discovery), and settings.
// There is no login — identity is the local offline profile, pairing is a
// QR-shared ticket.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    // Resolved per navigation, not a fixed string: the header logo and both Back
    // buttons come through here, and "/" is also where every lock cycle re-enters
    // (window.location.reload wipes the memory history).
    { path: "/", redirect: () => firstVisiblePath() },
    { path: "/chat", component: EnigmaChatView, name: "chat", beforeEnter: tabGuard("chat") },
    { path: "/files", component: EnigmaFilesView, name: "files", beforeEnter: tabGuard("files") },
    // Vox (voice calls) / calendar / contacts / map — build-gated editions
    // (pland.md) on top of the per-user switch. The tab is called Vox; the build
    // flag stays `calls_enabled`, matching build_config.yaml's section.
    { path: "/vox", component: EnigmaVoxView, name: "vox", beforeEnter: tabGuard("vox") },
    { path: "/calendar", component: EnigmaCalendarView, name: "calendar", beforeEnter: tabGuard("calendar") },
    { path: "/map", component: EnigmaMapView, name: "map", beforeEnter: tabGuard("map") },
    { path: "/contacts", component: EnigmaContactsView, name: "contacts", beforeEnter: tabGuard("contacts") },
    // Privacy MANA — reached from the header's MANA chip, not from the nav, so it is
    // ungated like Settings and the welcome page.
    { path: "/privacy", component: EnigmaPrivacyView, name: "privacy" },
    // Settings has no gate of either kind — it is the way back from everything
    // else, including from a nav the user has emptied out.
    { path: "/config", component: EnigmaConfigView, name: "config" },
    // Welcome: app info, who you are, and the Privacy MANA meters. Ungated for the
    // same reason Settings is — it is where the header logo goes, and a logo that
    // could lead nowhere would be a dead end on every screen. Note this is NOT
    // "/": that still resolves to the first visible tab, which is where a lock
    // cycle re-enters (App.vue reloads the webview, wiping the memory history).
    { path: "/welcome", component: EnigmaWelcomeView, name: "welcome" },
    // Profile now lives inside Settings (as a tab) — keep the old path working.
    { path: "/profile", redirect: "/config?tab=profile" },
  ],
});

// `beforeEnter` only fires on ENTRY, so it cannot cover the two ways the route
// you are already on becomes hidden: ticking a checkbox in Settings, and boot —
// the first navigation resolves at app.mount(), long before the vault is
// unlocked and the stored choice can be read, so the app can be sitting on a
// tab the user hid. Re-validate whenever the visible set changes; a hidden
// current route is replaced (not pushed) so it leaves no history entry to go
// back to.
watch(visibleTabs, () => {
  const tab = APP_TABS.find((t) => t.path === router.currentRoute.value.path);
  if (tab && !isTabVisible(tab.id)) void router.replace(firstVisiblePath());
});

export default router;
