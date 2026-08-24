// Which main tabs this app presents — the build's tabs, minus the ones the user
// switched off in Settings → Tabs.
//
// Two independent gates decide whether a tab exists for the user, and they AND:
//
//   1. the BUILD gate (pland.md editions) — was the feature compiled in at all;
//   2. this per-user switch — does the user want to see it.
//
// The build gate is the OUTER one, exactly as rakotis' getDhtDiscovery orders
// the same pair: a Light build must never resurrect Vox because a profile
// carries it ticked from a Plus build (useVoxCall is null there, so the view
// would throw), and a feature the binary lacks offers no checkbox — the user
// cannot enable what was not compiled in. The stored choice is deliberately not
// rewritten in that case, so reopening the profile with a capable build restores
// what the user actually picked.
//
// SETTINGS (/config) IS DELIBERATELY NOT IN THIS LIST and has no checkbox. It is
// the only route back to these very checkboxes — and, via `?tab=`, to the
// profile, the passphrase, the PIN and the panic code. The router uses memory
// history (there is no URL bar in the Tauri webview), so a user who hid Settings
// would have no way whatsoever to reach it again. It is the escape hatch, so it
// is not a preference.
//
// The state lives here, in a module-level ref, rather than in a component or a
// Pinia store, for two reasons. The router guards must read it SYNCHRONOUSLY
// (kv is async and unreadable until the vault is unlocked) and router/index.ts
// is evaluated before `app.use(createPinia())` has run. And App.vue mounts once
// for the app's whole lifetime, so a value sampled at setup — the way the build
// flags are — would never update when a checkbox flips; the nav has to read a
// live ref. Same rationale as stores/network.ts, minus Pinia.

import { computed, ref } from "vue";
import { getBuildConfig, getHiddenTabs, setHiddenTabs, type BuildConfig } from "rakotis";

export type AppTabId = "chat" | "files" | "vox" | "calendar" | "map" | "contacts";

export interface AppTab {
  id: AppTabId;
  path: string;
  /** The existing `nav.*` label key — a checkbox must read exactly like the tab
   *  it hides, so the two never drift apart. */
  labelKey: string;
  icon: string;
  /** Compile-time gate; `null` = always compiled in (chat, files). */
  gate: ((cfg: BuildConfig) => boolean) | null;
}

/** Every hideable tab, in nav order. Settings is absent on purpose (see above),
 *  and this list — not the `nav.*` keys — is the source of truth: the Vox
 *  tab's key is `nav.calls`, for instance. */
export const APP_TABS: readonly AppTab[] = [
  { id: "chat", path: "/chat", labelKey: "nav.chat", icon: "comments", gate: null },
  { id: "files", path: "/files", labelKey: "nav.files", icon: "file-arrow-up", gate: null },
  // The tab is called Vox; the build flag stays `calls_enabled` (build_config.yaml).
  { id: "vox", path: "/vox", labelKey: "nav.calls", icon: "phone", gate: (c) => c.calls_enabled },
  { id: "calendar", path: "/calendar", labelKey: "nav.calendar", icon: "calendar", gate: (c) => c.calendar_enabled },
  { id: "map", path: "/map", labelKey: "nav.map", icon: "map", gate: (c) => c.maps_enabled },
  { id: "contacts", path: "/contacts", labelKey: "nav.contacts", icon: "address-book", gate: (c) => c.contacts_enabled },
];

/** Settings — the tab that can never be hidden, and therefore the terminal
 *  fallback of every redirect below. */
export const SETTINGS_PATH = "/config";

/** Privacy HP (technology.md §17). Like Settings and the welcome page it is a
 *  route reached from the app chrome rather than a nav tab: the header's HP chip
 *  is its one entrance, and a nav entry beside it would be a second door to the
 *  same room. Absent from `APP_TABS` for that reason, so it has no nav link and
 *  no visibility checkbox. */
export const PRIVACY_PATH = "/privacy";

// Ids only (not AppTabId): an id written by a NEWER build is meaningless here
// but must survive a round-trip rather than being silently un-hidden.
const hiddenTabs = ref<ReadonlySet<string>>(new Set());

function compiledIn(tab: AppTab): boolean {
  return tab.gate === null || tab.gate(getBuildConfig());
}

/** The tabs this BUILD has — i.e. exactly the checkboxes Settings may offer. */
export function availableTabs(): AppTab[] {
  return APP_TABS.filter(compiledIn);
}

/** Build gate AND user choice. Everything — nav, router guards, `/` — asks this. */
export function isTabVisible(id: AppTabId): boolean {
  const tab = APP_TABS.find((t) => t.id === id);
  if (!tab || !compiledIn(tab)) return false;
  return !hiddenTabs.value.has(id);
}

/** Reactive: the nav renders from this, and the router watches it. */
export const visibleTabs = computed(() => availableTabs().filter((t) => !hiddenTabs.value.has(t.id)));

/** Where "/" lands, and where a guard sends someone who asked for a hidden tab.
 *  Never the denied path (it is hidden, so it is not in the list), so this can't
 *  produce the self-redirect vue-router refuses. Settings when nothing is left:
 *  the app must always have somewhere to be. */
export function firstVisiblePath(): string {
  // Recomputed from the CURRENT gates rather than read off `visibleTabs`: that
  // computed only tracks `hiddenTabs`, so a build config replaced after its
  // first evaluation leaves it stale — and a stale head sends the guard to a
  // path the guard itself denies, which vue-router reports as an infinite
  // redirection.
  const live = availableTabs().filter((t) => !hiddenTabs.value.has(t.id));
  return live[0]?.path ?? SETTINGS_PATH;
}

/** Read the stored choice. kv lives in the encrypted vault, so this is only
 *  callable once unlocked — App.vue's runLoaders is the one caller. */
export async function loadTabVisibility(): Promise<void> {
  hiddenTabs.value = new Set(await getHiddenTabs());
}

/** Show/hide one tab. Flips the live ref first so the nav reacts on the same
 *  tick as the click, then persists (the write swallows its own failures, like
 *  every other setting here). */
export async function setTabVisible(id: AppTabId, visible: boolean): Promise<void> {
  const next = new Set(hiddenTabs.value);
  if (visible) next.delete(id);
  else next.add(id);
  hiddenTabs.value = next;
  await setHiddenTabs([...next]);
}
