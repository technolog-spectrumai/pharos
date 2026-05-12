<script setup lang="ts">
import { ref, watch } from "vue";
import OyaHelloWorld from "./components/OyaHelloWorld.vue";

const darkMode = ref(localStorage.getItem("darkMode") === "true");

watch(darkMode, (value) => {
  localStorage.setItem("darkMode", String(value));
});

function toggleDarkMode() {
  darkMode.value = !darkMode.value;
}
</script>

<template>
  <div
    :class="
      darkMode
        ? 'bg-primary-bg-dark text-text-main-dark'
        : 'bg-primary-bg-light text-text-main-light'
    "
    class="min-h-screen flex flex-col font-sans transition-colors duration-300"
  >
    <header
      :class="
        darkMode
          ? 'bg-header-bg-dark text-appbar-text-dark shadow-md'
          : 'bg-header-bg-light text-appbar-text-light shadow-md'
      "
      class="border-b border-current/10 px-6 py-4"
    >
      <div class="mx-auto flex max-w-7xl items-center justify-between gap-4">
        <div>
          <h1 class="text-xl font-bold tracking-wide">
            Enigma
          </h1>

          <p class="text-xs opacity-70">
            Amazing Moon interface
          </p>
        </div>

        <button
          type="button"
          @click="toggleDarkMode"
          :class="
            darkMode
              ? 'bg-appbar-bg-dark border-accent-1 text-appbar-text-dark'
              : 'bg-appbar-bg-light border-accent-2 text-appbar-text-light'
          "
          class="rounded border px-3 py-2 text-xs font-semibold shadow-sm transition hover:opacity-80"
        >
          {{ darkMode ? "Light mode" : "Dark mode" }}
        </button>
      </div>
    </header>

    <main class="flex-grow px-4 py-6 sm:px-6 lg:px-8">
      <OyaHelloWorld :dark-mode="darkMode" />
    </main>

    <footer
      :class="
        darkMode
          ? 'bg-footer-bg-dark text-footer-text-dark'
          : 'bg-footer-bg-light text-footer-text-light'
      "
      class="mt-8 px-6 py-4 text-center text-sm shadow-lg"
    >
      <p class="opacity-80">
        &copy; Amazing Moon. All rights reserved.
      </p>
    </footer>
  </div>
</template>