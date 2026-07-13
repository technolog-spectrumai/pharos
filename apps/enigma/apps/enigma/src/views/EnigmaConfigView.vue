<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import EnigmaProfileView from "./EnigmaProfileView.vue";
import { useChatStore } from "../stores/chat";
import { useUserStore } from "../stores/user";
import { SUPPORTED_LOCALES, LOCALE_NAMES, setLocale, type Locale } from "../i18n";
import {
  clearOfflineProfile,
  getProfileState,
  getRuntimeConfig,
  getOffline,
  setActiveProfile,
  setOffline,
  getUseTor,
  setUseTor,
  type AppRuntimeConfig,
  type AppProfileState,
} from "rakotis";
import { OyaCard } from "rakotis";
import { OyaButton } from "rakotis";

defineProps<{ darkMode: boolean }>();

const router = useRouter();
const route = useRoute();
const chatStore = useChatStore();
const userStore = useUserStore();
const { t, locale } = useI18n({ useScope: "global" });

// Profile + Data live inside Settings as tabs. `?tab=profile`/`?tab=data` open them
// directly (nav links use that); otherwise we open on the settings controls.
type ConfigTab = "profile" | "settings" | "data";
const tabFromQuery = (q: unknown): ConfigTab =>
  q === "profile" ? "profile" : q === "data" ? "data" : "settings";
const activeTab = ref<ConfigTab>(tabFromQuery(route.query.tab));
// React to nav links changing ?tab while already on this route (the view is reused).
watch(() => route.query.tab, (tab) => { activeTab.value = tabFromQuery(tab); });

// ── Language ──────────────────────────────────────────────────────────────────
function changeLanguage(value: string) {
  // Serverless: the choice is local-only (persisted by the i18n framework).
  setLocale(value as Locale, true);
}

// ── My identity (iroh NodeId) ────────────────────────────────────────────────
// The stable NodeId is this device's durable P2P handle: peers who paired once
// (via a room QR) reconnect to it through n0 discovery even after IP changes.
const nodeId = ref("");
const nodeQr = ref("");
const nodeIdCopied = ref(false);
const nodeIdLoading = ref(false);

async function loadNodeId() {
  nodeIdLoading.value = true;
  try {
    nodeId.value = (await chatStore.p2p.ensureNode()) ?? "";
    if (nodeId.value) {
      try {
        const { toDataURL } = await import("qrcode");
        nodeQr.value = await toDataURL(nodeId.value, { errorCorrectionLevel: "L", margin: 1, width: 220 });
      } catch { nodeQr.value = ""; }
    }
  } finally {
    nodeIdLoading.value = false;
  }
}

async function copyNodeId() {
  try {
    await navigator.clipboard.writeText(nodeId.value);
    nodeIdCopied.value = true;
    setTimeout(() => (nodeIdCopied.value = false), 1500);
  } catch { /* clipboard unavailable */ }
}

// ── Offline / airplane mode (online / offline) ───────────────────────────────
const offline = ref(false);
async function toggleOffline() {
  offline.value = !offline.value;
  await setOffline(offline.value);
}

// ── Use Tor (peer-hosted onion transport) ────────────────────────────────────
// Exclusive with iroh: toggling tears down the other transport in Rust, so the
// shown NodeId (iroh) / onion refreshes on the next room command.
const useTor = ref(false);
async function toggleUseTor() {
  useTor.value = !useTor.value;
  await setUseTor(useTor.value);
}

onMounted(async () => {
  await loadRuntimeConfig();
  offline.value = await getOffline();
  useTor.value = await getUseTor();
  await loadOfflineData();
  void loadNodeId();
});

// ── Offline data ─────────────────────────────────────────────────────────────
const offlineState = ref<AppProfileState | null>(null);
const runtimeConfig = ref<AppRuntimeConfig | null>(null);
const offlineMessage = ref("");
const clearingOffline = ref(false);
const dataProfileName = ref("");
const loadProfileStatus = ref<"idle" | "loading" | "success" | "error">("idle");

const selectedOfflineProfile = computed(() =>
  offlineState.value?.offline_profiles.find(
    (profile) => profile.id === offlineState.value?.selected_offline_profile_id,
  ) ?? null
);

const selectedOfflineProfileHasData = computed(() => {
  const profile = selectedOfflineProfile.value?.profile;
  if (!profile) return false;
  return Object.values(profile).some((value) => value.trim().length > 0);
});

const loadedProfileChips = computed(() => {
  if (!runtimeConfig.value || !offlineState.value) return [];
  return [
    `APP_PROFILE: ${runtimeConfig.value.profile}`,
    `CHAT_USER: ${runtimeConfig.value.identity}`,
    `State: ${runtimeConfig.value.profile_state_path}`,
    `Offline data: ${selectedOfflineProfileHasData.value ? "saved" : "empty"}`,
  ];
});

async function loadOfflineData() {
  offlineState.value = await getProfileState();
  dataProfileName.value = runtimeConfig.value?.profile ?? selectedOfflineProfile.value?.label ?? "";
}

async function loadRuntimeConfig() {
  runtimeConfig.value = await getRuntimeConfig();
}

function clearDataProfileName() {
  dataProfileName.value = "";
  loadProfileStatus.value = "idle";
  offlineMessage.value = "";
}

async function loadDataProfile() {
  const label = dataProfileName.value.trim();
  if (!label || loadProfileStatus.value === "loading") return;

  loadProfileStatus.value = "loading";
  offlineMessage.value = "";
  try {
    runtimeConfig.value = await setActiveProfile(label, label);
    offlineState.value = await getProfileState();
    await chatStore.applyRuntimeProfile(runtimeConfig.value);
    // Re-read the local profile so the display name (App.vue watcher +
    // chat) reflects the NEW profile, not the previous one.
    await userStore.loadOfflineProfile();
    chatStore.p2p.currentUserName.value =
      userStore.displayName || runtimeConfig.value.identity;
    dataProfileName.value = runtimeConfig.value.profile;
    offlineMessage.value = t("config.profileLoaded");
    loadProfileStatus.value = "success";
    // The switched profile has its own iroh key → refresh the shown NodeId.
    void loadNodeId();
  } catch (e) {
    offlineMessage.value = (e as Error).message;
    loadProfileStatus.value = "error";
  }
}

async function clearSelectedOfflineData() {
  clearingOffline.value = true;
  try {
    offlineState.value = await clearOfflineProfile();
    offlineMessage.value = t("config.offlineCleared");
    setTimeout(() => (offlineMessage.value = ""), 2000);
  } finally {
    clearingOffline.value = false;
  }
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">

    <!-- Header -->
    <header class="space-y-2">
      <button
        class="inline-flex items-center gap-2 text-sm underline hover:opacity-80"
        @click="router.push('/')"
      >
        <font-awesome-icon icon="arrow-left" />
        {{ $t('common.back') }}
      </button>

      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          {{ $t('config.studio') }}
        </p>
        <h1 class="mt-1 flex items-center gap-3 text-3xl font-bold">
          <font-awesome-icon icon="gear" />
          {{ $t('config.title') }}
        </h1>
        <p class="mt-2 text-sm opacity-70">{{ $t('config.subtitle') }}</p>
      </div>
    </header>

    <!-- Profile / Settings tabs -->
    <div
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex gap-1 rounded-xl border p-1 text-sm font-semibold"
    >
      <button
        type="button"
        :class="activeTab === 'profile'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'profile'"
      >
        <font-awesome-icon icon="user" />{{ $t('nav.myProfile') }}
      </button>
      <button
        type="button"
        :class="activeTab === 'settings'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'settings'"
      >
        <font-awesome-icon icon="gear" />{{ $t('nav.settings') }}
      </button>
      <button
        type="button"
        :class="activeTab === 'data'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'data'"
      >
        <font-awesome-icon icon="database" />{{ $t('nav.data') }}
      </button>
    </div>

    <!-- Profile tab — the user profile, embedded -->
    <EnigmaProfileView v-if="activeTab === 'profile'" :dark-mode="darkMode" embedded />

    <!-- Settings tab -->
    <template v-if="activeTab === 'settings'">
    <!-- Language card -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-3">
      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          {{ $t('lang.language') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('lang.hint') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <label class="shrink-0 text-xs font-semibold uppercase tracking-wide opacity-60">
          {{ $t('lang.chooseLanguage') }}
        </label>
        <select
          :value="locale"
          :class="darkMode ? 'config-control-dark' : 'config-control-light'"
          class="config-control rounded-lg border px-2 py-1 text-sm outline-none transition"
          @change="changeLanguage(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="l in SUPPORTED_LOCALES" :key="l" :value="l">{{ LOCALE_NAMES[l] }}</option>
        </select>
      </div>
    </OyaCard>

    <!-- My identity card — this device's stable P2P NodeId -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          {{ $t('config.myIdentity') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.myIdentityHint') }}</p>
      </div>

      <div v-if="nodeId" class="space-y-3">
        <img v-if="nodeQr" :src="nodeQr" alt="Node ID QR code" class="mx-auto h-44 w-44 rounded-lg bg-white p-2" />
        <div class="flex gap-2">
          <input
            :value="nodeId" readonly
            class="min-w-0 flex-1 rounded-lg border border-current/15 bg-transparent px-2 py-1.5 font-mono text-[11px]"
          />
          <button
            class="shrink-0 rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
            @click="copyNodeId"
          >
            {{ nodeIdCopied ? "✓" : $t('chat.copy') }}
          </button>
        </div>
      </div>
      <p v-else-if="nodeIdLoading" class="text-sm opacity-60">…</p>
      <OyaButton v-else :dark-mode="darkMode" variant="secondary" @click="loadNodeId">
        <font-awesome-icon icon="circle-nodes" />{{ $t('config.showNodeId') }}
      </OyaButton>
    </OyaCard>

    <!-- Use Tor card — route rendezvous + chat over peer-hosted onion services -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          {{ $t('config.useTor') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.useTorHint') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <font-awesome-icon
          icon="shield-halved"
          :class="useTor ? 'text-accent-dark' : 'opacity-60'"
          class="shrink-0"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.useTor') }}</p>
          <p class="text-xs opacity-60">
            {{ useTor ? $t('config.useTorOnHint') : $t('config.useTorOffHint') }}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="useTor"
          :class="useTor ? 'bg-accent-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
          @click="toggleUseTor"
        >
          <span
            :class="useTor ? 'translate-x-6' : 'translate-x-1'"
            class="inline-block h-4 w-4 transform rounded-full bg-white transition"
          />
        </button>
      </div>
    </OyaCard>
    </template>

    <!-- Data tab — offline mode + local data profiles -->
    <template v-if="activeTab === 'data'">
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('nav.data') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.dataHint') }}</p>
      </div>

      <!-- Offline / airplane mode switch (online / offline) -->
      <div class="flex items-center gap-3">
        <font-awesome-icon
          icon="power-off"
          :class="offline ? 'text-warn-dark' : 'opacity-60'"
          class="shrink-0"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.offlineMode') }}</p>
          <p class="text-xs opacity-60">
            {{ offline ? $t('config.offlineOnHint') : $t('config.offlineOffHint') }}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="offline"
          :class="offline ? 'bg-warn-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
          @click="toggleOffline"
        >
          <span
            :class="offline ? 'translate-x-6' : 'translate-x-1'"
            class="inline-block h-4 w-4 transform rounded-full bg-white transition"
          />
        </button>
      </div>
    </OyaCard>

    <!-- Offline data card -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          {{ $t('config.offlineData') }}
        </p>
        <p class="mt-1 text-sm opacity-65">
          {{ $t('config.offlineHint') }}
        </p>
      </div>

      <div class="space-y-3">
        <label class="block space-y-1">
          <span class="text-xs font-semibold uppercase tracking-wide opacity-60">
            {{ $t('config.localDataProfile') }}
          </span>
          <div class="flex gap-2">
            <input
              v-model="dataProfileName"
              type="text"
              maxlength="80"
              placeholder="alice"
              :class="
                darkMode
                  ? 'config-control-dark placeholder:text-text-main-dark/30'
                  : 'config-control-light placeholder:text-text-main-light/30'
              "
              class="config-control min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none transition"
              @input="loadProfileStatus = 'idle'"
              @keyup.enter="loadDataProfile"
            />
            <button
              type="button"
              :class="[
                loadProfileStatus === 'success'
                  ? 'border-success-dark bg-success-dark text-primary-bg-dark'
                  : loadProfileStatus === 'error'
                    ? 'border-warn-dark bg-warn-dark text-primary-bg-dark'
                    : darkMode
                      ? 'border-accent-1 bg-bubble-bg-dark text-text-main-dark hover:border-accent-dark'
                      : 'border-accent-2 bg-bubble-bg-light text-text-main-light hover:border-accent-light',
                loadProfileStatus === 'loading' || !dataProfileName.trim()
                  ? 'pointer-events-none opacity-60'
                  : '',
              ]"
              class="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold shadow-sm transition"
              @click="loadDataProfile"
            >
              <font-awesome-icon
                :icon="
                  loadProfileStatus === 'loading'
                    ? 'lock'
                    : loadProfileStatus === 'success'
                      ? 'check'
                      : loadProfileStatus === 'error'
                        ? 'triangle-exclamation'
                        : 'folder-open'
                "
              />
              {{ loadProfileStatus === "loading" ? $t('config.loadingProfile') : $t('config.loadProfile') }}
            </button>
          </div>
        </label>

        <div v-if="dataProfileName" class="flex flex-wrap gap-2">
          <button
            type="button"
            :class="
              darkMode
                ? 'border-accent-1 bg-primary-bg-dark text-text-main-dark hover:border-warn-dark'
                : 'border-accent-2 bg-primary-bg-light text-text-main-light hover:border-warn-light'
            "
            class="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition"
            @click="clearDataProfileName"
          >
            <span>{{ dataProfileName }}</span>
            <font-awesome-icon icon="xmark" />
          </button>
        </div>

        <div
          :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'"
          class="rounded-lg border px-3 py-2 text-sm"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="opacity-60">{{ $t('config.activeAppProfile') }}</span>
            <span class="font-mono font-semibold">{{ runtimeConfig?.profile ?? "—" }}</span>
          </div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <span class="opacity-60">{{ $t('config.activeChatUser') }}</span>
            <span class="font-mono font-semibold">{{ runtimeConfig?.identity ?? "—" }}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="opacity-60">{{ $t('config.storedFields') }}</span>
            <span
              :class="selectedOfflineProfileHasData ? 'text-success-dark' : 'opacity-50'"
              class="font-semibold"
            >
              {{ selectedOfflineProfileHasData ? $t('config.dataSaved') : $t('config.empty') }}
            </span>
          </div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <span class="opacity-60">{{ $t('config.profiles') }}</span>
            <span class="font-mono font-semibold">{{ offlineState?.offline_profiles.length ?? 0 }}</span>
          </div>
        </div>
      </div>

      <p
        v-if="offlineMessage"
        :class="loadProfileStatus === 'error' ? 'text-warn-dark' : 'text-success-dark'"
        class="text-sm"
      >
        {{ offlineMessage }}
      </p>

      <div
        v-if="loadProfileStatus === 'success' && loadedProfileChips.length"
        class="flex flex-wrap gap-2"
      >
        <span
          v-for="chip in loadedProfileChips"
          :key="chip"
          :class="
            darkMode
              ? 'border-success-dark/40 bg-success-dark/10 text-text-main-dark'
              : 'border-success-light/40 bg-success-light/10 text-text-main-light'
          "
          class="max-w-full rounded-lg border px-3 py-1.5 text-xs font-semibold"
        >
          <span class="block truncate">{{ chip }}</span>
        </span>
      </div>

      <div class="flex flex-col gap-2 sm:flex-row">
        <OyaButton
          :dark-mode="darkMode"
          variant="secondary"
          :class="{ 'pointer-events-none opacity-50': clearingOffline || !selectedOfflineProfileHasData }"
          class="flex-1 justify-center"
          @click="clearSelectedOfflineData"
        >
          <font-awesome-icon :icon="clearingOffline ? 'lock' : 'trash'" />
          {{ clearingOffline ? $t('config.clearing') : $t('config.clearSelectedData') }}
        </OyaButton>
      </div>
    </OyaCard>
    </template>

  </section>
</template>

<style scoped>
.config-control {
  color-scheme: light;
}

.config-control-light {
  background-color: #f2f3f5;
  border-color: #2f3d63;
  color: #0f1114;
}

.config-control-light option {
  background-color: #f2f3f5;
  color: #0f1114;
}

.config-control-dark {
  color-scheme: dark;
  background-color: #0a0c11;
  border-color: #4f5fa1;
  color: #d3d7e0;
}

.config-control-dark option {
  background-color: #0a0c11;
  color: #d3d7e0;
}

.config-control:focus {
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 18%, transparent);
}

.config-control:disabled {
  opacity: 0.75;
  -webkit-text-fill-color: currentColor;
}
</style>
