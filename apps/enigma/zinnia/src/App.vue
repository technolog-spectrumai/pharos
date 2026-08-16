<script setup lang="ts">
import { ref, watch } from "vue";
import { brand } from "./config";

// Dark mode as a plain ref plus the `.dark` class — the class is what every
// `dark:` utility reacts to. Persisted, unlike enigma's, so the choice survives
// a restart; the initial guess follows the OS.
const dark = ref(
  localStorage.getItem("zinnia:dark") === null
    ? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true
    : localStorage.getItem("zinnia:dark") === "1",
);
watch(dark, (on) => {
  document.documentElement.classList.toggle("dark", on);
  localStorage.setItem("zinnia:dark", on ? "1" : "0");
}, { immediate: true });

const tauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
</script>

<template>
  <div class="min-h-screen flex flex-col bg-primary-bg-light text-text-main-light
              dark:bg-primary-bg-dark dark:text-text-main-dark transition-colors">
    <header class="flex items-center gap-3 border-b px-4 py-3 border-accent-2 dark:border-accent-1">
      <h1 class="flex-1 text-lg font-bold">{{ brand.name }}</h1>
      <button type="button" @click="dark = !dark"
              class="rounded-lg border px-3 py-1.5 text-sm border-accent-2 dark:border-accent-1">
        {{ dark ? "Light" : "Dark" }}
      </button>
    </header>

    <main class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p class="text-2xl font-semibold">The scaffold runs.</p>
      <p class="opacity-70">
        Shell, build and desktop wiring are in place — editors land next.
      </p>
      <p class="rounded-lg border px-3 py-1.5 text-sm border-accent-2 dark:border-accent-1">
        runtime: <strong>{{ tauri ? "Tauri desktop" : "browser" }}</strong>
      </p>
    </main>
  </div>
</template>
