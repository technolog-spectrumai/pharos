<script setup lang="ts">
import { ref } from "vue";
import OyaHelloWorld from "./components/OyaHelloWorld.vue";

const darkMode = ref(true);

function toggleDarkMode() {
  darkMode.value = !darkMode.value;
}
</script>

<template>
  <div
    :class="darkMode ? 'bg-[#05080d] text-white' : 'bg-[#f4f5f7] text-[#25345c]'"
    class="min-h-screen flex flex-col font-sans transition-colors duration-300"
  >
    <!-- APP BAR -->
    <header
      :class="darkMode ? 'bg-[#121827] text-white' : 'bg-[#25345c] text-white'"
      class="sticky top-0 z-50 border-b border-white/10 shadow-md"
    >
      <div
        class="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6"
      >
        <div class="flex items-center gap-3">
          <div class="text-3xl leading-none">
            🐙
          </div>

          <div>
            <h1 class="text-xl font-bold tracking-wide sm:text-2xl">
              Spectrum Platform
            </h1>
          </div>
        </div>

        <nav class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <a href="#" class="transition hover:opacity-70">
            ↪ Logout
          </a>

          <a href="#" class="transition hover:opacity-70">
            ◉ Dashboard
          </a>

          <a href="#" class="transition hover:opacity-70">
            ♟ My Profile
          </a>

          <button
            type="button"
            @click="toggleDarkMode"
            class="transition hover:opacity-70"
          >
            {{ darkMode ? "☾ Dark Mode" : "⚙ Light Mode" }}
          </button>
        </nav>
      </div>
    </header>

    <!-- PAGE CONTENT -->
    <main class="flex flex-1 px-4 py-8 sm:px-6 lg:px-8">
      <OyaHelloWorld :dark-mode="darkMode" />
    </main>

    <!-- FOOTER -->
    <footer
      :class="darkMode ? 'bg-[#121827] text-white' : 'bg-[#1d263a] text-white'"
      class="border-t border-white/10 px-4 py-4 text-center text-sm shadow-lg"
    >
      <p class="opacity-90">
        © www.spectrumai.pl. All rights reserved.
      </p>
    </footer>
  </div>
</template>