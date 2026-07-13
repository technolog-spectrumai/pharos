<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { RouterView, RouterLink, useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import { useUserStore } from "./stores/user";
import { useChatStore } from "./stores/chat";
import { barIcon } from "./assets/logos";

const darkMode = ref(true);
const menuOpen = ref(false);
const route = useRoute();

const userStore = useUserStore();
const chatStore = useChatStore();
const { displayName } = storeToRefs(userStore);

onMounted(async () => {
  await chatStore.syncRuntimeIdentity();
  await userStore.loadOfflineProfile();
  // Serverless: reopen the last P2P room (reconnect via persisted peer NodeIds).
  void chatStore.init();
});

// The chat display name is the local profile's display name (identity otherwise).
watch(displayName, (name) => {
  if (name) chatStore.p2p.currentUserName.value = name;
}, { immediate: true });

// Close menu on navigation
watch(() => route.path, () => {
  menuOpen.value = false;
});
</script>

<template>
  <div
    :class="darkMode ? 'bg-primary-bg-dark text-text-main-dark' : 'bg-primary-bg-light text-text-main-light'"
    class="min-h-screen flex flex-col font-sans transition-colors duration-300"
  >
    <!-- Header -->
    <header
      :class="darkMode ? 'bg-header-bg-dark text-appbar-text-dark' : 'bg-header-bg-light text-appbar-text-light'"
      class="sticky top-0 z-50 border-b border-current/10 shadow-md pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <div class="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">

        <!-- Logo -->
        <RouterLink to="/" class="flex items-center gap-3 hover:opacity-80 transition">
          <img :src="barIcon" alt="Enigma icon" class="h-9 w-9 rounded-lg object-contain" />
          <h1 class="text-xl font-bold tracking-wide sm:text-2xl">Enigma</h1>
        </RouterLink>

        <!-- Desktop nav -->
        <nav class="hidden lg:flex items-center gap-x-4 gap-y-2 text-sm flex-wrap">
          <RouterLink to="/chat" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.chat')">
            <font-awesome-icon icon="comments" />
            {{ $t('nav.chat') }}
          </RouterLink>
          <RouterLink to="/config" class="inline-flex items-center gap-2 transition hover:opacity-70">
            <font-awesome-icon icon="gear" />
            {{ $t('nav.settings') }}
          </RouterLink>

          <button
            type="button"
            class="inline-flex items-center gap-2 transition hover:opacity-70"
            @click="darkMode = !darkMode"
          >
            <font-awesome-icon :icon="darkMode ? 'sun' : 'moon'" />
            {{ darkMode ? $t('nav.light') : $t('nav.dark') }}
          </button>
        </nav>

        <!-- Mobile: avatar + hamburger -->
        <div class="flex items-center gap-3 lg:hidden">
          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-lg border border-current/15 transition hover:opacity-70"
            :aria-label="menuOpen ? $t('nav.closeMenu') : $t('nav.openMenu')"
            @click="menuOpen = !menuOpen"
          >
            <font-awesome-icon :icon="menuOpen ? 'xmark' : 'bars'" />
          </button>
        </div>

      </div>

      <!-- Mobile dropdown -->
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-2"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition-all duration-150 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-2"
      >
        <div
          v-if="menuOpen"
          :class="darkMode ? 'bg-header-bg-dark border-accent-1' : 'bg-header-bg-light border-accent-2'"
          class="lg:hidden border-t divide-y divide-current/10"
        >
          <RouterLink to="/chat" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="comments" class="w-4 text-center" />
            {{ $t('nav.chat') }}
          </RouterLink>
          <RouterLink
            to="/config"
            class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition"
          >
            <font-awesome-icon icon="gear" class="w-4 text-center" />
            {{ $t('nav.settings') }}
          </RouterLink>

          <button
            type="button"
            class="flex w-full items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition"
            @click="darkMode = !darkMode"
          >
            <font-awesome-icon :icon="darkMode ? 'sun' : 'moon'" class="w-4 text-center" />
            {{ darkMode ? $t('nav.lightMode') : $t('nav.darkMode') }}
          </button>
        </div>
      </Transition>
    </header>

    <!-- Main -->
    <main class="flex flex-1 px-4 py-6 sm:px-6 lg:px-8">
      <RouterView v-slot="{ Component }">
        <component :is="Component" :dark-mode="darkMode" />
      </RouterView>
    </main>

    <!-- Footer -->
    <footer
      :class="darkMode ? 'bg-footer-bg-dark text-footer-text-dark' : 'bg-footer-bg-light text-footer-text-light'"
      class="border-t border-current/10 px-4 py-4 text-center text-sm shadow-lg pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <p class="opacity-90">© www.spectrumai.pl. All rights reserved.</p>
    </footer>
  </div>
</template>
