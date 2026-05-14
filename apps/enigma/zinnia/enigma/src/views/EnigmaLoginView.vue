<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../services/api";
import { useUserStore } from "../stores/user";
import OyaCard from "../components/OyaCard.vue";
import OyaButton from "../components/OyaButton.vue";

defineProps<{ darkMode: boolean }>();

const router = useRouter();
const userStore = useUserStore();

const username = ref("");
const password = ref("");
const loading = ref(false);
const error = ref("");

async function submit() {
  if (!username.value || !password.value) {
    error.value = "Please enter your username and password.";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    await api.login(username.value.trim(), password.value);
    await userStore.fetchMe();
    router.push("/");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6">

    <header class="space-y-1 text-center">
      <p
        :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
        class="text-xs font-semibold uppercase tracking-wide"
      >
        Oya Studio
      </p>
      <h1 class="text-3xl font-bold">Sign in</h1>
      <p class="text-sm opacity-60">Connect to your Enigma server</p>
    </header>

    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">

      <div v-if="error" class="flex items-start gap-2 rounded-lg bg-warn-dark/10 px-3 py-2 text-sm text-warn-dark">
        <font-awesome-icon icon="triangle-exclamation" class="mt-0.5 shrink-0" />
        <span class="break-all">{{ error }}</span>
      </div>

      <div class="space-y-3">
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Username</label>
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            placeholder="your-username"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
            "
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
            @keyup.enter="submit"
          />
        </div>

        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Password</label>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
            "
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
            @keyup.enter="submit"
          />
        </div>
      </div>

      <OyaButton
        :dark-mode="darkMode"
        :class="{ 'pointer-events-none opacity-50': loading }"
        class="w-full justify-center"
        @click="submit"
      >
        <font-awesome-icon :icon="loading ? 'lock' : 'right-to-bracket'" />
        {{ loading ? "Signing in…" : "Sign in" }}
      </OyaButton>

    </OyaCard>

    <p class="text-center text-xs opacity-50">
      No server configured?
      <button class="underline hover:opacity-80" @click="router.push('/config')">Open settings</button>
    </p>

  </section>
</template>
