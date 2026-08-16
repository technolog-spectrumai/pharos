<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { brand } from "./config";
import { i18n, setLocale, type Locale } from "./i18n";
import EditorHost from "./views/EditorHost.vue";
import VaultView from "./views/VaultView.vue";

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

// Two views, one toggle. A router earns its place when a third arrives.
const view = ref<"files" | "vault">("files");

/** A vault file on its way to the editor; the host consumes it and clears it. */
const incoming = ref<{ key: string; name: string; content: string } | null>(null);

function onOpenFile(file: { key: string; name: string; content: string }) {
  incoming.value = file;
  view.value = "files";
}
</script>

<template>
  <div class="flex h-screen flex-col bg-primary-bg-light text-text-main-light
              dark:bg-primary-bg-dark dark:text-text-main-dark transition-colors">
    <header class="flex shrink-0 items-center gap-2 border-b px-4 py-2 border-accent-2 dark:border-accent-1">
      <h1 class="text-lg font-bold">{{ brand.name }}</h1>
      <nav class="flex flex-1 items-center gap-1 pl-4">
        <button type="button" data-testid="nav-files" @click="view = 'files'"
                class="rounded-lg px-3 py-1 text-sm font-semibold transition"
                :class="view === 'files'
                  ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                  : 'opacity-60 hover:opacity-100'">
          {{ t("nav.files") }}
        </button>
        <button type="button" data-testid="nav-vault" @click="view = 'vault'"
                class="rounded-lg px-3 py-1 text-sm font-semibold transition"
                :class="view === 'vault'
                  ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                  : 'opacity-60 hover:opacity-100'">
          {{ t("nav.vault") }}
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

    <!-- v-show, not v-if: switching tabs must not unmount an editor holding
         unsaved work, and the vault listing keeps its scroll position. -->
    <EditorHost v-show="view === 'files'" class="min-h-0 flex-1"
                :incoming="incoming" @incoming-consumed="incoming = null" />
    <VaultView v-show="view === 'vault'" class="min-h-0 flex-1" @open-file="onOpenFile" />
  </div>
</template>
