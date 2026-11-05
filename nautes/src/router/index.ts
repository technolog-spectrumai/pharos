import { watch } from "vue";
import { createRouter, createMemoryHistory } from "vue-router";
import NautesChatView from "../views/NautesChatView.vue";
import NautesFriendsView from "../views/NautesFriendsView.vue";
import NautesConfigView from "../views/NautesConfigView.vue";
import NautesWelcomeView from "../views/NautesWelcomeView.vue";
import NautesPrivacyView from "../views/NautesPrivacyView.vue";
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

// Nautes: short messages over Tor. One chat surface, Privacy HP, settings.
// There is no login — identity is the local offline profile, pairing is a
// QR-shared invitation.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    // Resolved per navigation, not a fixed string: the header logo and both Back
    // buttons come through here, and "/" is also where every lock cycle re-enters
    // (window.location.reload wipes the memory history).
    { path: "/", redirect: () => firstVisiblePath() },
    { path: "/friends", component: NautesFriendsView, name: "friends", beforeEnter: tabGuard("friends") },
    { path: "/chat", component: NautesChatView, name: "chat", beforeEnter: tabGuard("chat") },
    // Privacy HP — reached from the header's HP chip, not from the nav, so it is
    // ungated like Settings and the welcome page.
    { path: "/privacy", component: NautesPrivacyView, name: "privacy" },
    // Settings has no gate of either kind — it is the way back from everything
    // else, including from a nav the user has emptied out.
    { path: "/config", component: NautesConfigView, name: "config" },
    // Welcome: app info, who you are, and the Privacy HP meters. Ungated for the
    // same reason Settings is — it is where the header logo goes, and a logo that
    // could lead nowhere would be a dead end on every screen. Note this is NOT
    // "/": that still resolves to the first visible tab, which is where a lock
    // cycle re-enters (App.vue reloads the webview, wiping the memory history).
    { path: "/welcome", component: NautesWelcomeView, name: "welcome" },
    // Profile now lives inside Settings (as a tab) — keep the old path working.
    { path: "/profile", redirect: "/config?tab=profile" },
    // Anything else — including the path of a tab this build was made without —
    // goes where "/" goes, rather than to a blank page.
    { path: "/:pathMatch(.*)*", redirect: () => firstVisiblePath() },
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
