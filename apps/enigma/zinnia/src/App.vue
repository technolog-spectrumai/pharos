<script setup lang="ts">
import { ref, watch } from "vue";
import { brand } from "./config";
import { i18n, setLocale, type Locale } from "./i18n";
import SketchView from "./views/SketchView.vue";

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
</script>

<template>
  <div class="flex h-screen flex-col bg-primary-bg-light text-text-main-light
              dark:bg-primary-bg-dark dark:text-text-main-dark transition-colors">
    <header class="flex shrink-0 items-center gap-3 border-b px-4 py-2 border-accent-2 dark:border-accent-1">
      <h1 class="flex-1 text-lg font-bold">{{ brand.name }}</h1>
      <button type="button" @click="switchLocale"
              class="rounded-lg border px-2.5 py-1 text-xs border-accent-2 dark:border-accent-1">
        {{ i18n.global.locale.value === "en" ? "PL" : "EN" }}
      </button>
      <button type="button" data-testid="dark-toggle" @click="dark = !dark"
              class="rounded-lg border px-2.5 py-1 text-xs border-accent-2 dark:border-accent-1">
        {{ dark ? "Light" : "Dark" }}
      </button>
    </header>

    <!-- The one view so far. A router arrives with the second editor, not before. -->
    <SketchView class="min-h-0 flex-1" />
  </div>
</template>
