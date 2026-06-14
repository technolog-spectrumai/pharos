<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { RouterView, RouterLink, useRouter, useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import { useUserStore } from "./stores/user";
import { useChatStore } from "./stores/chat";
import { useCapabilitiesStore } from "./stores/capabilities";
import { api } from "./services/api";
import { appIcon } from "./assets/logos";
import { applyProfileLocaleGuess } from "./i18n";
import { useMeetingReminders } from "./composables/useMeetingReminders";

const darkMode = ref(true);
const menuOpen = ref(false);
const missionMenuOpen = ref(false);   // desktop "Mission" dropdown
const missionMobileOpen = ref(false); // mobile "Mission" collapsible
const router = useRouter();
const route = useRoute();

// The "Mission" apps grouped under one app-bar entry. The dropdown keeps its
// "Mission" label/icon even when a sub-app is open; `activeMission` is used only to
// highlight the entry (bold) while you're inside one of these apps.
const missionApps = [
  { to: "/vault", icon: "hard-drive", label: "nav.storage", key: "vault" },
  { to: "/tasks", icon: "list-check", label: "nav.tasks", key: "tasks" },
  { to: "/locations", icon: "location-dot", label: "nav.locations", key: "locations" },
  { to: "/people", icon: "users", label: "nav.people", key: "people" },
  { to: "/events", icon: "calendar", label: "nav.events", key: "events" },
  { to: "/graph", icon: "diagram-project", label: "nav.graph", key: "graph" },
] as const;
const activeMission = computed(() => missionApps.find((m) => m.to === route.path) ?? null);
// Only the apps the connected server actually installs (portal vs faros).
const caps = useCapabilitiesStore();
const visibleMissionApps = computed(() => missionApps.filter((m) => caps.has(m.key)));

const userStore = useUserStore();
const chatStore = useChatStore();
const { me } = storeToRefs(userStore);

// App-shell watcher: notify ahead of upcoming meetings, on any screen.
useMeetingReminders();

onMounted(() => {
  void chatStore.syncRuntimeIdentity();
  userStore.fetchMe();
  void caps.fetchApps();
});

watch(me, (val) => {
  if (val) {
    void caps.fetchApps(); // re-check capabilities after login (may have switched servers)
    chatStore.relay.currentUserName.value = val.full_name;
    // First guess for the UI language is the user's toto profile language,
    // unless they've already picked one explicitly in Enigma.
    applyProfileLocaleGuess(val.language);
  }
});

// Close menus on navigation
watch(() => route.path, () => {
  menuOpen.value = false;
  missionMenuOpen.value = false;
  missionMobileOpen.value = false;
});

async function handleLogout() {
  await api.logout();
  userStore.me = null;
  menuOpen.value = false;
  router.push("/login");
}
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
          <img :src="appIcon" alt="Enigma+ icon" class="h-9 w-9 rounded-lg object-contain" />
          <h1 class="text-xl font-bold tracking-wide sm:text-2xl">Enigma+</h1>
        </RouterLink>

        <!-- Desktop nav -->
        <nav class="hidden lg:flex items-center gap-x-4 gap-y-2 text-sm flex-wrap">
          <RouterLink to="/chat" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.chat')">
            <font-awesome-icon icon="comments" />
            {{ $t('nav.chat') }}
          </RouterLink>
          <!-- Mission apps dropdown (notes / tasks / locations / people) -->
          <div class="relative">
            <button
              type="button"
              class="inline-flex items-center gap-2 transition hover:opacity-70"
              :class="activeMission ? 'font-semibold' : ''"
              :title="$t('nav.mission')"
              @click="missionMenuOpen = !missionMenuOpen"
            >
              <font-awesome-icon icon="bullseye" />
              {{ $t('nav.mission') }}
              <font-awesome-icon icon="chevron-down" class="text-[10px] opacity-60" />
            </button>
            <div v-if="missionMenuOpen" class="fixed inset-0 z-40" @click="missionMenuOpen = false" />
            <div
              v-if="missionMenuOpen"
              :class="darkMode ? 'bg-header-bg-dark border-accent-1' : 'bg-header-bg-light border-accent-2'"
              class="absolute left-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-lg border shadow-xl"
            >
              <RouterLink
                v-for="m in visibleMissionApps"
                :key="m.to"
                :to="m.to"
                class="flex items-center gap-3 px-4 py-2.5 text-sm transition hover:opacity-70"
                @click="missionMenuOpen = false"
              >
                <font-awesome-icon :icon="m.icon" class="w-4 text-center" />
                {{ $t(m.label) }}
              </RouterLink>
            </div>
          </div>

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

          <RouterLink
            v-if="!me"
            to="/login"
            class="inline-flex items-center gap-2 transition hover:opacity-70"
          >
            <font-awesome-icon icon="right-to-bracket" />
            {{ $t('nav.login') }}
          </RouterLink>
          <button
            v-else
            class="inline-flex items-center gap-2 transition hover:opacity-70"
            @click="handleLogout"
          >
            <font-awesome-icon icon="right-from-bracket" />
            {{ $t('nav.logout') }}
          </button>
        </nav>

        <!-- Mobile: hamburger -->
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
          <!-- Mission apps (collapsible) -->
          <button
            type="button"
            class="flex w-full items-center gap-3 px-5 py-3.5 text-sm transition hover:opacity-70"
            @click="missionMobileOpen = !missionMobileOpen"
          >
            <font-awesome-icon icon="bullseye" class="w-4 text-center" />
            {{ $t('nav.mission') }}
            <font-awesome-icon :icon="missionMobileOpen ? 'chevron-up' : 'chevron-down'" class="ml-auto text-xs opacity-60" />
          </button>
          <template v-if="missionMobileOpen">
            <RouterLink
              v-for="m in visibleMissionApps"
              :key="m.to"
              :to="m.to"
              class="flex items-center gap-3 py-3 pl-12 pr-5 text-sm transition hover:opacity-70"
            >
              <font-awesome-icon :icon="m.icon" class="w-4 text-center" />
              {{ $t(m.label) }}
            </RouterLink>
          </template>

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

          <RouterLink
            v-if="!me"
            to="/login"
            class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition"
          >
            <font-awesome-icon icon="right-to-bracket" class="w-4 text-center" />
            {{ $t('nav.login') }}
          </RouterLink>
          <button
            v-else
            class="flex w-full items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition"
            @click="handleLogout"
          >
            <font-awesome-icon icon="right-from-bracket" class="w-4 text-center" />
            {{ $t('nav.logout') }}
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
