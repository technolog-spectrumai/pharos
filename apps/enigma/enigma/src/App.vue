<script setup lang="ts">
import { ref } from "vue";
import { RouterView, RouterLink } from "vue-router";
import appIcon from "./assets/icon.png";

const darkMode = ref(true);
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
    <!-- Header -->
    <header
      :class="
        darkMode
          ? 'bg-header-bg-dark text-appbar-text-dark'
          : 'bg-header-bg-light text-appbar-text-light'
      "
      class="sticky top-0 z-50 border-b border-current/10 shadow-md"
    >
      <div
        class="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6"
      >
        <RouterLink to="/" class="flex items-center gap-3 hover:opacity-80 transition">
          <img
            :src="appIcon"
            alt="Enigma icon"
            class="h-9 w-9 rounded-lg object-contain"
          />
          <h1 class="text-xl font-bold tracking-wide sm:text-2xl">Enigma</h1>
        </RouterLink>

        <nav class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <a href="#" class="inline-flex items-center gap-2 transition hover:opacity-70">
            <font-awesome-icon icon="right-from-bracket" />
            Logout
          </a>

          <a href="#" class="inline-flex items-center gap-2 transition hover:opacity-70">
            <font-awesome-icon icon="gauge" />
            Dashboard
          </a>

          <RouterLink
            to="/config"
            class="inline-flex items-center gap-2 transition hover:opacity-70"
          >
            <font-awesome-icon icon="gear" />
            Settings
          </RouterLink>

          <button
            type="button"
            @click="darkMode = !darkMode"
            class="inline-flex items-center gap-2 transition hover:opacity-70"
          >
            <font-awesome-icon :icon="darkMode ? 'moon' : 'sun'" />
            {{ darkMode ? "Dark Mode" : "Light Mode" }}
          </button>
        </nav>
      </div>
    </header>

    <!-- Main -->
    <main class="flex flex-1 px-4 py-6 sm:px-6 lg:px-8">
      <RouterView v-slot="{ Component }">
        <component :is="Component" :dark-mode="darkMode" />
      </RouterView>
    </main>

    <!-- Footer -->
    <footer
      :class="
        darkMode
          ? 'bg-footer-bg-dark text-footer-text-dark'
          : 'bg-footer-bg-light text-footer-text-light'
      "
      class="border-t border-current/10 px-4 py-4 text-center text-sm shadow-lg"
    >
      <p class="opacity-90">© www.spectrumai.pl. All rights reserved.</p>
    </footer>
  </div>
</template>
