<script setup lang="ts">
import { onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useUserStore } from "../stores/user";
import { useChatStore } from "../stores/chat";
import OyaCard from "../components/OyaCard.vue";
import OyaButton from "../components/OyaButton.vue";
import { useRouter } from "vue-router";

defineProps<{ darkMode: boolean }>();

const router = useRouter();
const userStore = useUserStore();
const chatStore = useChatStore();
const { me, loading, error, fetchLog, offlineProfile } = storeToRefs(userStore);
const { rooms, loadingRooms } = storeToRefs(chatStore);

const showFetchLog = ref(false);
const showDetail = ref<string | null>(null);
const savedOffline = ref(false);

onMounted(() => {
  userStore.fetchMe();
  if (!rooms.value.length) chatStore.fetchRooms();
});

function serverBase(): string {
  return (localStorage.getItem("enigma_server_url") ?? "").replace(/\/$/, "");
}

function saveOffline() {
  if (!offlineProfile.value.display_name.trim()) return;
  userStore.saveOfflineProfile();
  savedOffline.value = true;
  setTimeout(() => (savedOffline.value = false), 2000);
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6">

    <!-- Header -->
    <header class="space-y-2">
      <button
        class="inline-flex items-center gap-2 text-sm underline hover:opacity-80"
        @click="router.push('/')"
      >
        <font-awesome-icon icon="arrow-left" />
        Back
      </button>

      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          Oya Studio
        </p>
        <h1 class="mt-1 flex items-center gap-3 text-3xl font-bold">
          <font-awesome-icon icon="user" />
          My Profile
        </h1>
      </div>
    </header>

    <!-- Loading -->
    <OyaCard v-if="loading" :dark-mode="darkMode" :padded="true">
      <p class="text-sm opacity-50">Loading profile…</p>
    </OyaCard>

    <!-- ── Online profile ── -->
    <OyaCard v-else-if="me" :dark-mode="darkMode" :padded="true">
      <div class="flex flex-col gap-5 sm:flex-row sm:items-start">

        <!-- Avatar -->
        <div
          :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'"
          class="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border shadow-md"
        >
          <img
            v-if="me.avatar_url"
            :src="me.avatar_url"
            :alt="me.full_name"
            class="h-full w-full object-cover"
          />
          <font-awesome-icon v-else icon="user" class="text-4xl opacity-30" />
        </div>

        <!-- Info -->
        <div class="flex-1 space-y-3">
          <div>
            <h2 class="text-2xl font-bold">{{ me.full_name }}</h2>
            <p class="mt-0.5 text-sm opacity-60">@{{ me.username }}</p>
          </div>

          <div
            :class="darkMode ? 'border-accent-1 bg-primary-bg-dark divide-accent-1' : 'border-accent-2 bg-primary-bg-light divide-accent-2'"
            class="divide-y rounded-xl border"
          >
            <div class="flex items-center justify-between px-4 py-3 text-sm">
              <span class="opacity-60">User ID</span>
              <span class="font-mono font-semibold">{{ me.id }}</span>
            </div>
            <div class="flex items-center justify-between px-4 py-3 text-sm">
              <span class="opacity-60">Username</span>
              <span class="font-semibold">{{ me.username }}</span>
            </div>
            <div class="flex items-center justify-between px-4 py-3 text-sm">
              <span class="opacity-60">Full name</span>
              <span class="font-semibold">{{ me.full_name }}</span>
            </div>
          </div>

          <a
            v-if="me.profile_url"
            :href="`${serverBase()}${me.profile_url}`"
            target="_blank"
            rel="noopener noreferrer"
            :class="darkMode ? 'border-accent-1 hover:bg-primary-bg-dark' : 'border-accent-2 hover:bg-primary-bg-light'"
            class="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition"
          >
            <font-awesome-icon icon="arrow-left" class="rotate-[135deg]" />
            View full profile on server
          </a>
        </div>
      </div>
    </OyaCard>

    <!-- ── Offline profile form ── -->
    <template v-else>

      <!-- Auth error notice -->
      <div
        v-if="error"
        :class="darkMode ? 'border-warn-dark/30 bg-warn-dark/5' : 'border-warn-light/30 bg-warn-light/5'"
        class="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm"
      >
        <font-awesome-icon icon="triangle-exclamation" class="mt-0.5 shrink-0 text-warn-dark" />
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-warn-dark">Not connected to server</p>
          <p class="mt-0.5 break-all font-mono text-xs opacity-70">{{ error }}</p>
        </div>
        <div class="flex shrink-0 gap-2">
          <OyaButton :dark-mode="darkMode" variant="secondary" @click="userStore.fetchMe()">
            Retry
          </OyaButton>
          <OyaButton :dark-mode="darkMode" variant="secondary" @click="router.push('/login')">
            Login
          </OyaButton>
        </div>
      </div>

      <!-- Offline profile form card -->
      <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-5">
        <div>
          <p
            :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
            class="text-xs font-semibold uppercase tracking-wide"
          >
            Offline Profile
          </p>
          <p class="mt-1 text-sm opacity-60">
            Stored locally on this device. Used while disconnected from the server.
          </p>
        </div>

        <div class="space-y-4">

          <!-- Display name (required) -->
          <div class="space-y-1">
            <label class="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide opacity-60">
              Display name
              <span class="text-warn-dark">*</span>
            </label>
            <input
              v-model="offlineProfile.display_name"
              type="text"
              placeholder="Your name"
              maxlength="150"
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                  : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
              "
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
            />
          </div>

          <!-- Email -->
          <div class="space-y-1">
            <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Email</label>
            <input
              v-model="offlineProfile.email"
              type="email"
              placeholder="you@example.com"
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                  : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
              "
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
            />
          </div>

          <!-- Phone -->
          <div class="space-y-1">
            <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Phone</label>
            <input
              v-model="offlineProfile.phone"
              type="tel"
              placeholder="+1 555 000 0000"
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                  : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
              "
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
            />
          </div>

          <!-- Date of birth -->
          <div class="space-y-1">
            <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Date of birth</label>
            <input
              v-model="offlineProfile.date_of_birth"
              type="date"
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark'
                  : 'bg-primary-bg-light border-accent-2 text-text-main-light'
              "
              class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
            />
          </div>

          <!-- Bio -->
          <div class="space-y-1">
            <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Bio</label>
            <textarea
              v-model="offlineProfile.bio"
              rows="3"
              placeholder="A few words about yourself…"
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                  : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
              "
              class="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition"
            />
          </div>

        </div>

        <OyaButton
          :dark-mode="darkMode"
          :class="{ 'pointer-events-none opacity-50': !offlineProfile.display_name.trim() }"
          class="w-full justify-center"
          @click="saveOffline"
        >
          <font-awesome-icon :icon="savedOffline ? 'check' : 'floppy-disk'" />
          {{ savedOffline ? "Saved locally" : "Save profile" }}
        </OyaButton>
      </OyaCard>

      <!-- Fetch log (collapsible) -->
      <div v-if="fetchLog.length">
        <button
          class="flex w-full items-center gap-2 text-xs font-semibold uppercase tracking-wide opacity-40 hover:opacity-70 transition"
          @click="showFetchLog = !showFetchLog"
        >
          <font-awesome-icon
            icon="arrow-left"
            class="transition-transform"
            :class="showFetchLog ? '-rotate-90' : 'rotate-[225deg]'"
          />
          Connection log
        </button>

        <div v-if="showFetchLog" class="mt-2 space-y-1">
          <div
            v-for="(entry, i) in [...fetchLog].reverse()"
            :key="i"
            :class="
              entry.ok
                ? darkMode ? 'border-success-dark/40' : 'border-success-light/40'
                : darkMode ? 'border-warn-dark/40' : 'border-warn-light/40'
            "
            class="rounded-lg border font-mono text-xs"
          >
            <button
              class="flex w-full items-center gap-3 px-3 py-2 text-left"
              @click="showDetail = showDetail === `${i}` ? null : `${i}`"
            >
              <span
                :class="entry.ok ? 'text-success-dark' : 'text-warn-dark'"
                class="w-6 shrink-0 text-center font-bold"
              >
                {{ entry.ok ? "✓" : "✗" }}
              </span>
              <span class="shrink-0 opacity-50">{{ entry.timestamp.toLocaleTimeString() }}</span>
              <span class="min-w-0 flex-1 truncate opacity-80">{{ entry.url }}</span>
              <span class="shrink-0 opacity-60">{{ entry.message }}</span>
              <font-awesome-icon
                icon="arrow-left"
                class="shrink-0 opacity-40 transition-transform"
                :class="showDetail === `${i}` ? '-rotate-90' : 'rotate-[225deg]'"
              />
            </button>
            <div
              v-if="showDetail === `${i}` && entry.detail"
              :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'"
              class="border-t border-current/10 px-3 py-2"
            >
              <pre class="whitespace-pre-wrap break-all text-[10px] opacity-70">{{ entry.detail }}</pre>
            </div>
          </div>
        </div>
      </div>

    </template>

    <!-- Rooms card (only when authenticated) -->
    <OyaCard v-if="me" :dark-mode="darkMode" :padded="true">
      <p
        :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
        class="text-xs font-semibold uppercase tracking-wide"
      >
        Rooms
      </p>

      <div v-if="loadingRooms" class="mt-3 text-sm opacity-50">Loading rooms…</div>

      <div
        v-else-if="rooms.length"
        class="mt-3 divide-y"
        :class="darkMode ? 'divide-accent-1' : 'divide-accent-2'"
      >
        <div
          v-for="room in rooms"
          :key="room.slug"
          class="flex items-center justify-between py-3"
        >
          <div>
            <p class="text-sm font-semibold">{{ room.name }}</p>
            <p class="text-xs opacity-50">{{ room.participant_count }} participant{{ room.participant_count === 1 ? '' : 's' }}</p>
          </div>
          <OyaButton :dark-mode="darkMode" variant="secondary" @click="router.push('/chat')">
            <font-awesome-icon icon="comments" />
            Open
          </OyaButton>
        </div>
      </div>

      <p v-else class="mt-3 text-sm opacity-50">No rooms available.</p>
    </OyaCard>

  </section>
</template>
