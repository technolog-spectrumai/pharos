<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Html5Qrcode } from "html5-qrcode";
import { api } from "../services/api";
import { useChatStore } from "../stores/chat";
import { SUPPORTED_LOCALES, LOCALE_NAMES, setLocale, type Locale } from "../i18n";
import {
  clearOfflineProfile,
  getProfileState,
  getRuntimeConfig,
  getServerUrl,
  getSilentMode,
  setActiveProfile,
  setServerUrl,
  setSilentMode,
  type AppRuntimeConfig,
  type AppProfileState,
} from "../services/appStorage";
import { wsService } from "../services/ws";
import OyaCard from "../components/OyaCard.vue";
import OyaButton from "../components/OyaButton.vue";

defineProps<{ darkMode: boolean }>();

const router = useRouter();
const chatStore = useChatStore();
const { t, locale } = useI18n({ useScope: "global" });

// ── Language ──────────────────────────────────────────────────────────────────
const langSavedToProfile = ref(false);
async function changeLanguage(value: string) {
  const loc = value as Locale;
  setLocale(loc, true); // explicit local choice — overrides the profile guess
  langSavedToProfile.value = false;
  try {
    const res = await api.setLanguage(loc); // also persist to the toto profile
    if (res.stored) {
      langSavedToProfile.value = true;
      setTimeout(() => (langSavedToProfile.value = false), 2500);
    }
  } catch {
    /* offline — the local choice still applies */
  }
}

// ── Server URL ────────────────────────────────────────────────────────────────
const serverUrl = ref("");
const saved = ref(false);

// ── Silent mode ───────────────────────────────────────────────────────────────
// When on, Enigma blocks every connection to the server (REST, uploads, chat).
const silentMode = ref(false);

async function toggleSilentMode() {
  silentMode.value = !silentMode.value;
  await setSilentMode(silentMode.value);
  if (silentMode.value) {
    // Drop any live chat socket immediately and clear stale test results.
    wsService.disconnect();
    testStatus.value = "idle";
    testMessage.value = "";
  }
}

onMounted(async () => {
  await loadRuntimeConfig();
  serverUrl.value = await getServerUrl();
  silentMode.value = await getSilentMode();
  await loadOfflineData();
});

async function save() {
  await setServerUrl(serverUrl.value.trim());
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function clearConnection() {
  await setServerUrl("");
  serverUrl.value = "";
  testStatus.value = "idle";
  testMessage.value = "";
}

// ── Test connection ───────────────────────────────────────────────────────────
type TestStatus = "idle" | "testing" | "ok" | "error";
const testStatus = ref<TestStatus>("idle");
const testMessage = ref("");
const timeoutMs = ref(5000); // user-configurable timeout in ms

async function testConnection() {
  if (silentMode.value) {
    testStatus.value = "error";
    testMessage.value = t("config.silentBlocked");
    return;
  }
  if (!serverUrl.value) {
    testStatus.value = "error";
    testMessage.value = t("config.noServer");
    return;
  }
  testStatus.value = "testing";
  testMessage.value = "";
  const t0 = Date.now();

  try {
    await Promise.race([
      api.health(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs.value / 1000} s`)),
          timeoutMs.value
        )
      ),
    ]);
    const ms = Date.now() - t0;
    testStatus.value = "ok";
    testMessage.value = t("config.serverReachable", { ms });
  } catch (e) {
    testStatus.value = "error";
    const raw = (e as Error).message;
    const elapsed = Date.now() - t0;
    const timedOut = elapsed >= timeoutMs.value - 50;
    testMessage.value = timedOut
      ? `No response after ${timeoutMs.value / 1000} s — server may be unreachable. (${raw})`
      : raw;
  }
}

// ── QR scanner ───────────────────────────────────────────────────────────────
interface ScanEntry {
  ts: Date;
  ok: boolean;
  text: string;
}

const scanning = ref(false);
const scanError = ref("");
const scanLog = ref<ScanEntry[]>([]);
let scanner: Html5Qrcode | null = null;

async function startScan() {
  scanError.value = "";
  scanning.value = true;
  await new Promise((r) => setTimeout(r, 50));
  scanner = new Html5Qrcode("qr-scanner-region");
  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 220, height: 220 } },
      (decoded) => {
        scanLog.value.unshift({ ts: new Date(), ok: true, text: decoded });
        serverUrl.value = decoded;
        void save();      // auto-save scanned URL
        stopScan();
      },
      () => {
        // per-frame decode failure — ignore noise
      }
    );
  } catch {
    const msg = t("config.cameraDenied");
    scanError.value = msg;
    scanLog.value.unshift({ ts: new Date(), ok: false, text: msg });
    scanning.value = false;
    scanner = null;
  }
}

async function stopScan() {
  if (scanner) {
    try { await scanner.stop(); } catch { /* ignore */ }
    scanner = null;
  }
  scanning.value = false;
}

onUnmounted(stopScan);

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
    `Server: ${offlineState.value.server_url || "not set"}`,
    `Token: ${offlineState.value.auth_token ? "saved" : "empty"}`,
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
    await chatStore.leaveAllChatsOnServer().catch(() => {});
    runtimeConfig.value = await setActiveProfile(label, label);
    serverUrl.value = await getServerUrl();
    offlineState.value = await getProfileState();
    await chatStore.applyRuntimeProfile(runtimeConfig.value);
    dataProfileName.value = runtimeConfig.value.profile;
    testStatus.value = "idle";
    testMessage.value = "";
    offlineMessage.value = t("config.profileLoaded");
    loadProfileStatus.value = "success";
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
        <span v-if="langSavedToProfile" class="text-xs text-success-dark">
          <font-awesome-icon icon="check" class="mr-1" />{{ $t('lang.savedToProfile') }}
        </span>
      </div>
    </OyaCard>

    <!-- Server URL card -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          {{ $t('config.serverAddress') }}
        </p>
        <p class="mt-1 text-sm opacity-65">
          {{ $t('config.serverHint') }}
        </p>
      </div>

      <!-- Input row -->
      <div class="flex gap-2">
        <input
          v-model="serverUrl"
          type="url"
          placeholder="http://192.168.x.x:8000"
          :class="
            darkMode
              ? 'config-control-dark placeholder:text-text-main-dark/30'
              : 'config-control-light placeholder:text-text-main-light/30'
          "
          class="config-control flex-1 rounded-lg border px-3 py-2 text-sm font-mono outline-none transition"
          @keyup.enter="save"
        />
        <OyaButton :dark-mode="darkMode" @click="save">
          <font-awesome-icon :icon="saved ? 'check' : 'floppy-disk'" />
          {{ saved ? $t('common.saved') : $t('common.save') }}
        </OyaButton>
      </div>

      <!-- Silent mode toggle -->
      <div
        :class="
          silentMode
            ? darkMode ? 'border-warn-dark/50 bg-warn-dark/10' : 'border-warn-light/50 bg-warn-light/10'
            : darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'
        "
        class="flex items-center gap-3 rounded-lg border px-3 py-2 transition"
      >
        <font-awesome-icon
          :icon="silentMode ? 'shield-halved' : 'satellite-dish'"
          :class="silentMode ? 'text-warn-dark' : 'opacity-60'"
          class="shrink-0"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.silentMode') }}</p>
          <p class="mt-0.5 text-xs opacity-65">{{ $t('config.silentModeHint') }}</p>
        </div>
        <span class="shrink-0 text-xs font-semibold uppercase tracking-wide" :class="silentMode ? 'text-warn-dark' : 'opacity-40'">
          {{ silentMode ? $t('config.silentOn') : $t('config.silentOff') }}
        </span>
        <button
          type="button"
          role="switch"
          :aria-checked="silentMode"
          :title="silentMode ? $t('config.silentOn') : $t('config.silentOff')"
          :class="silentMode ? 'bg-warn-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
          @click="toggleSilentMode"
        >
          <span
            :class="silentMode ? 'translate-x-6' : 'translate-x-1'"
            class="inline-block h-4 w-4 transform rounded-full bg-white transition"
          />
        </button>
      </div>

      <!-- Stored URL row -->
      <div
        v-if="serverUrl"
        :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'"
        class="flex items-center gap-3 rounded-lg border px-3 py-2"
      >
        <div class="min-w-0 flex-1">
          <p class="text-xs opacity-50">{{ $t('config.configuredServer') }}</p>
          <p class="mt-0.5 break-all font-mono text-sm">{{ serverUrl }}</p>
        </div>
        <button
          :class="darkMode ? 'hover:text-warn-dark' : 'hover:text-warn-light'"
          class="shrink-0 text-sm opacity-40 transition hover:opacity-100"
          :title="$t('config.clearSavedUrl')"
          @click="clearConnection"
        >
          <font-awesome-icon icon="xmark" />
        </button>
      </div>

      <!-- Test connection row -->
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-3">
          <!-- Timeout selector -->
          <div class="flex items-center gap-2 text-sm opacity-70">
            <label class="shrink-0 text-xs font-semibold uppercase tracking-wide opacity-60">
              {{ $t('config.timeout') }}
            </label>
            <select
              v-model.number="timeoutMs"
              :class="
                darkMode
                  ? 'config-control-dark'
                  : 'config-control-light'
              "
              class="config-control rounded-lg border px-2 py-1 text-sm outline-none transition"
            >
              <option :value="2000">2 s</option>
              <option :value="5000">5 s</option>
              <option :value="10000">10 s</option>
              <option :value="30000">30 s</option>
            </select>
          </div>

          <OyaButton
            :dark-mode="darkMode"
            variant="secondary"
            :class="{ 'pointer-events-none opacity-50': testStatus === 'testing' || silentMode }"
            @click="testConnection"
          >
            <font-awesome-icon v-if="testStatus === 'idle'" icon="gauge" />
            <font-awesome-icon v-else-if="testStatus === 'testing'" icon="lock" />
            <font-awesome-icon v-else-if="testStatus === 'ok'" icon="check" class="text-success-dark" />
            <font-awesome-icon v-else icon="triangle-exclamation" class="text-warn-dark" />
            {{ testStatus === "testing" ? $t('config.testing', { sec: timeoutMs / 1000 }) : $t('config.testConnection') }}
          </OyaButton>
        </div>

        <p
          v-if="testMessage"
          :class="testStatus === 'ok' ? 'text-success-dark' : 'text-warn-dark'"
          class="min-w-0 flex-1 break-all text-sm"
        >
          {{ testMessage }}
        </p>
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
            :title="$t('config.clearSavedUrl')"
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
          class="flex-1 justify-center"
          @click="router.push('/profile')"
        >
          <font-awesome-icon icon="user" />
          {{ $t('config.editProfiles') }}
        </OyaButton>
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

    <!-- QR Scanner card -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          {{ $t('config.scanQr') }}
        </p>
        <p class="mt-1 text-sm opacity-65">
          {{ $t('config.scanHint') }}
        </p>
      </div>

      <!-- Camera viewport -->
      <div v-if="scanning" class="space-y-3">
        <div
          id="qr-scanner-region"
          :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
          class="overflow-hidden rounded-xl border"
        />
        <OyaButton :dark-mode="darkMode" variant="secondary" class="w-full" @click="stopScan">
          <font-awesome-icon icon="xmark" />
          {{ $t('config.cancelScan') }}
        </OyaButton>
      </div>

      <p v-if="scanError" class="text-sm text-warn-dark">
        <font-awesome-icon icon="triangle-exclamation" class="mr-1" />
        {{ scanError }}
      </p>

      <OyaButton v-if="!scanning" :dark-mode="darkMode" class="w-full" @click="startScan">
        <font-awesome-icon icon="camera" />
        {{ $t('config.startScan') }}
      </OyaButton>

      <!-- Scan log -->
      <div v-if="scanLog.length" class="space-y-1">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-50">{{ $t('config.scanLog') }}</p>
        <div
          v-for="(entry, i) in scanLog"
          :key="i"
          :class="
            entry.ok
              ? darkMode ? 'border-success-dark/30 bg-success-dark/5' : 'border-success-light/30 bg-success-light/5'
              : darkMode ? 'border-warn-dark/30 bg-warn-dark/5' : 'border-warn-light/30 bg-warn-light/5'
          "
          class="flex items-start gap-2 rounded-lg border px-3 py-2 font-mono text-xs"
        >
          <span :class="entry.ok ? 'text-success-dark' : 'text-warn-dark'" class="shrink-0 font-bold">
            {{ entry.ok ? "✓" : "✗" }}
          </span>
          <span class="shrink-0 opacity-50">{{ entry.ts.toLocaleTimeString() }}</span>
          <span class="min-w-0 flex-1 break-all opacity-80">{{ entry.text }}</span>
        </div>
      </div>
    </OyaCard>

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
