<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { RouterView, RouterLink, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useUserStore } from "./stores/user";
import { useChatStore } from "./stores/chat";
import { api } from "./services/api";
import appIcon from "./assets/icon.png";

const darkMode = ref(true);
const router = useRouter();

const userStore = useUserStore();
const chatStore = useChatStore();
const { me } = storeToRefs(userStore);

onMounted(() => {
  userStore.fetchMe();
});

// Keep chat store's currentUserName in sync with resolved profile
watch(me, (val) => {
  if (val) chatStore.currentUserName = val.full_name;
});

async function handleLogout() {
  await api.logout();
  userStore.me = null;
  router.push("/login");
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
          <img :src="appIcon" alt="Enigma icon" class="h-9 w-9 rounded-lg object-contain" />
          <h1 class="text-xl font-bold tracking-wide sm:text-2xl">Enigma</h1>
        </RouterLink>

        <nav class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <RouterLink
            v-if="!me"
            to="/login"
            class="inline-flex items-center gap-2 transition hover:opacity-70"
          >
            <font-awesome-icon icon="right-to-bracket" />
            Login
          </RouterLink>

          <button
            v-else
            class="inline-flex items-center gap-2 transition hover:opacity-70"
            @click="handleLogout"
          >
            <font-awesome-icon icon="right-from-bracket" />
            Logout
          </button>

          <!-- User Profile -->
          <RouterLink
            to="/profile"
            class="inline-flex items-center gap-2 transition hover:opacity-70"
          >
            <img
              v-if="me?.avatar_url"
              :src="me.avatar_url"
              :alt="me.full_name"
              class="h-5 w-5 rounded-full object-cover"
            />
            <font-awesome-icon v-else icon="user" />
            <span>{{ me?.full_name ?? "My Profile" }}</span>
          </RouterLink>

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
