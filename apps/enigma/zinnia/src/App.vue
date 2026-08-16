<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { brand } from "./config";
import { i18n, setLocale, type Locale } from "./i18n";
import { APP_TABS, DEFAULT_TAB, type AppTabId } from "./tabs";
import EditorHost from "./views/EditorHost.vue";
import SettingsView from "./views/SettingsView.vue";

const { t } = useI18n({ useScope: "global" });

// Dark mode as a plain ref plus the `.dark` class — the class is what every
// `dark:` utility reacts to. Persisted; the initial guess follows the OS.
const dark = ref(
  localStorage.getItem("zinnia:dark") === null
    ? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true
    : localStorage.getItem("zinnia:dark") === "1",
);
watch(dark, (on) => {
  document.documentElement.classList.toggle("dark", on);
  localStorage.setItem("zinnia:dark", on ? "1" : "0");
}, { immediate: true });

function switchLocale() {
  setLocale((i18n.global.locale.value === "en" ? "pl" : "en") as Locale);
}

// ── tabs ────────────────────────────────────────────────────────────────────
// No router, and that is the point: each editor tab holds an open file with an
// unsaved buffer in it, and a router would unmount the losing tab on every
// switch. Enigma can route because its views are re-derivable; a half-written
// document is not.
//
// Two pieces of state, and the pair is what makes this cheap AND safe:
//   `active`  — what you see now;
//   `visited` — which tabs have ever been opened, so a tab is CREATED lazily
//               (Univer alone is ~5 MB and mounts a React tree) and never
//               destroyed afterwards.
const active = ref<AppTabId>(DEFAULT_TAB);
const visited = ref<Set<AppTabId>>(new Set([DEFAULT_TAB]));

function show(id: AppTabId) {
  const next = new Set(visited.value); // a Set mutated in place is not reactive
  next.add(id);
  visited.value = next;
  active.value = id;
}

const editorTabs = computed(() => APP_TABS.filter((tab) => tab.kind !== null));
</script>

<template>
  <div class="flex h-screen flex-col bg-primary-bg-light text-text-main-light
              dark:bg-primary-bg-dark dark:text-text-main-dark transition-colors">
    <header class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 border-accent-2 dark:border-accent-1">
      <h1 class="text-lg font-bold">{{ brand.name }}</h1>

      <nav class="flex flex-1 flex-wrap items-center gap-1 pl-3">
        <button v-for="tab in APP_TABS" :key="tab.id" type="button"
                :data-testid="`nav-${tab.id}`"
                class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-sm font-semibold transition"
                :class="active === tab.id
                  ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                  : 'opacity-60 hover:opacity-100'"
                @click="show(tab.id)">
          <font-awesome-icon :icon="tab.icon" />
          <span class="hidden sm:inline">{{ t(tab.labelKey) }}</span>
        </button>
      </nav>

      <button type="button" @click="switchLocale"
              class="rounded-lg border px-2.5 py-1 text-xs border-accent-2 dark:border-accent-1">
        {{ i18n.global.locale.value === "en" ? "PL" : "EN" }}
      </button>
      <button type="button" data-testid="dark-toggle" @click="dark = !dark"
              class="rounded-lg border px-2.5 py-1 text-xs border-accent-2 dark:border-accent-1">
        {{ dark ? "Light" : "Dark" }}
      </button>
    </header>

    <!-- v-if on `visited`, v-show on `active`: created once, then kept alive. -->
    <template v-for="tab in editorTabs" :key="tab.id">
      <EditorHost v-if="visited.has(tab.id)" v-show="active === tab.id"
                  :kind="tab.kind!" class="min-h-0 flex-1" />
    </template>

    <SettingsView v-if="visited.has('settings')" v-show="active === 'settings'"
                  class="min-h-0 flex-1" />
  </div>
</template>
