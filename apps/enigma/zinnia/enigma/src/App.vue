<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { RouterView, RouterLink, useRouter, useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import { useUserStore } from "./stores/user";
import { useChatStore } from "./stores/chat";
import { api } from "./services/api";
import { appIcon } from "./assets/logos";
import { applyProfileLocaleGuess } from "./i18n";

const darkMode = ref(true);
const menuOpen = ref(false);
const router = useRouter();
const route = useRoute();

const userStore = useUserStore();
const chatStore = useChatStore();
const { me } = storeToRefs(userStore);

onMounted(() => {
  void chatStore.syncRuntimeIdentity();
  userStore.fetchMe();
});

watch(me, (val) => {
  if (val) {
    chatStore.relay.currentUserName.value = val.full_name;
    chatStore.p2p.currentUserName.value = val.full_name;
    // First guess for the UI language is the user's toto profile language,
    // unless they've already picked one explicitly in Enigma.
    applyProfileLocaleGuess(val.language);
  }
});

// Close menu on navigation
watch(() => route.path, () => { menuOpen.value = false; });

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
          <img :src="appIcon" alt="Enigma icon" class="h-9 w-9 rounded-lg object-contain" />
          <h1 class="text-xl font-bold tracking-wide sm:text-2xl">Enigma</h1>
        </RouterLink>

        <!-- Desktop nav -->
        <nav class="hidden lg:flex items-center gap-x-4 gap-y-2 text-sm flex-wrap">
          <RouterLink to="/chat" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.chat')">
            <font-awesome-icon icon="comments" />
            {{ $t('nav.chat') }}
          </RouterLink>
          <RouterLink to="/notes" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.notes')">
            <font-awesome-icon icon="sticky-note" />
            {{ $t('nav.notes') }}
          </RouterLink>
          <RouterLink to="/vault" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.storage')">
            <font-awesome-icon icon="hard-drive" />
            {{ $t('nav.storage') }}
          </RouterLink>
          <RouterLink to="/tasks" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.tasks')">
            <font-awesome-icon icon="list-check" />
            {{ $t('nav.tasks') }}
          </RouterLink>
          <RouterLink to="/locations" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.locations')">
            <font-awesome-icon icon="location-dot" />
            {{ $t('nav.locations') }}
          </RouterLink>
          <RouterLink to="/people" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.people')">
            <font-awesome-icon icon="users" />
            {{ $t('nav.people') }}
          </RouterLink>
          <RouterLink to="/events" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.events')">
            <font-awesome-icon icon="calendar" />
            {{ $t('nav.events') }}
          </RouterLink>

          <RouterLink to="/profile" class="inline-flex items-center gap-2 transition hover:opacity-70">
            <img
              v-if="me?.avatar_url"
              :src="me.avatar_url"
              :alt="me.full_name"
              class="h-5 w-5 rounded-full object-cover"
            />
            <font-awesome-icon v-else icon="user" />
            <span>{{ me?.full_name ?? $t('nav.myProfile') }}</span>
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

        <!-- Mobile: avatar + hamburger -->
        <div class="flex items-center gap-3 lg:hidden">
          <RouterLink to="/profile">
            <img
              v-if="me?.avatar_url"
              :src="me.avatar_url"
              :alt="me.full_name"
              class="h-8 w-8 rounded-full object-cover border border-current/20"
            />
            <font-awesome-icon v-else icon="user" class="opacity-60" />
          </RouterLink>

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
          <RouterLink to="/notes" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="sticky-note" class="w-4 text-center" />
            {{ $t('nav.notes') }}
          </RouterLink>
          <RouterLink to="/vault" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="hard-drive" class="w-4 text-center" />
            {{ $t('nav.storage') }}
          </RouterLink>
          <RouterLink to="/tasks" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="list-check" class="w-4 text-center" />
            {{ $t('nav.tasks') }}
          </RouterLink>
          <RouterLink to="/locations" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="location-dot" class="w-4 text-center" />
            {{ $t('nav.locations') }}
          </RouterLink>
          <RouterLink to="/people" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="users" class="w-4 text-center" />
            {{ $t('nav.people') }}
          </RouterLink>
          <RouterLink to="/events" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="calendar" class="w-4 text-center" />
            {{ $t('nav.events') }}
          </RouterLink>

          <RouterLink
            to="/profile"
            class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition"
          >
            <font-awesome-icon icon="user" class="w-4 text-center" />
            {{ me?.full_name ?? $t('nav.myProfile') }}
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
