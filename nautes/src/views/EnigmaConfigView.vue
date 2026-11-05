<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import EnigmaProfileView from "./EnigmaProfileView.vue";
import { useNetworkStore } from "../stores/network";
import { storeToRefs } from "pinia";
import { SUPPORTED_LOCALES, LOCALE_NAMES, setLocale, type Locale } from "../i18n";
import { policy } from "../config/app";
import { applyIdleLockMins, applyLockOnHide } from "../idleLock";
import { availableTabs, isTabVisible, setTabVisible, type AppTabId } from "../tabs";
import {
  chargeHp,
  confirmHp,
  creditFor,
  explainFor,
  hpBalances,
  priceFor,
  recordTorPosture,
  recoverHp,
} from "../components/hp/useHp";
import {
  clearOfflineProfile,
  getProfileState,
  getRuntimeConfig,
  setActiveProfile,
  getStableOnion,
  setStableOnion,
  getConnectTimeoutSecs,
  setConnectTimeoutSecs,
  getDhtDiscovery,
  setDhtDiscovery,
  applyDhtDiscovery,
  getDhtStatus,
  getDhtRoomPublishSecs,
  setDhtRoomPublishSecs,
  getDhtPresencePollSecs,
  setDhtPresencePollSecs,
  DHT_PRESENCE_POLL_MIN_SECS,
  DHT_PRESENCE_POLL_MAX_SECS,
  getMaxFileSizeMb,
  setMaxFileSizeMb,
  getFileChunkKib,
  setFileChunkKib,
  getFileIntegrity,
  setFileIntegrity,
  getMeetingReminderMins,
  setMeetingReminderMins,
  MEETING_REMINDER_MIN_MINS,
  MEETING_REMINDER_MAX_MINS,
  vaultChangePassphrase,
  vaultLock,
  getIdleLockMins,
  setIdleLockMins,
  getLockOnHide,
  setLockOnHide,
  vaultSetPanicCode,
  vaultPinEnroll,
  vaultPinStatus,
  vaultPinClear,
  vaultClearPanicCode,
  vaultHasPanicCode,
  cleanTorKeystore,
  getBuildConfig,
  type AppRuntimeConfig,
  type AppProfileState,
} from "rakotis";
import { OyaCard } from "petalite/primitives";
import { OyaButton } from "petalite/primitives";
import { OyaModal, OyaTextField } from "petalite/primitives";
import { OyaHpPrice, formatHp } from "rakotis";

// Price badges show what the NEXT tap would cost, so they flip with the switch —
// which is what "show the price on the setting" has to mean for a toggle. A
// direction that costs nothing renders no badge rather than a "−0 HP".
const hpExplain = (id: string) => explainFor(id);

defineProps<{ darkMode: boolean }>();

// Compile-time build config (fetched at boot): allow flags decide which
// sections exist at all; the clamps drive the number inputs' min/max.
const buildCfg = getBuildConfig();
// The DHT needs both: its own build feature, and the hosted discovery it rides on.
const dhtAllowed = buildCfg.p2p_allow_hosted_relays && buildCfg.dht_enabled;

const router = useRouter();
const route = useRoute();
const { t, locale } = useI18n({ useScope: "global" });

// Profile + Data live inside Settings as tabs. `?tab=profile`/`?tab=data` open them
// directly (nav links use that); otherwise we open on the settings controls. The
// Lock tab gathers everything that guards the vault (auto-lock, passphrase, panic
// code); Data is purely about the offline profile data again.
type ConfigTab = "profile" | "settings" | "connections" | "lock" | "data";
const tabFromQuery = (q: unknown): ConfigTab =>
  q === "profile" ? "profile"
  : q === "connections" ? "connections"
  : q === "lock" ? "lock"
  : q === "data" ? "data"
  : "settings";
const activeTab = ref<ConfigTab>(tabFromQuery(route.query.tab));
// React to nav links changing ?tab while already on this route (the view is reused).
watch(() => route.query.tab, (tab) => { activeTab.value = tabFromQuery(tab); });

// ── Language ──────────────────────────────────────────────────────────────────
function changeLanguage(value: string) {
  // Serverless: the choice is local-only (persisted by the i18n framework).
  setLocale(value as Locale, true);
}

// ── Visible tabs ──────────────────────────────────────────────────────────────
// Which main tabs this device shows. The choices are the tabs this BUILD
// contains, so a feature the binary lacks offers no checkbox at all — there is
// nothing behind it to switch on. Settings is not among them on purpose: it is
// the only route back to these controls (and, via ?tab=, to the profile,
// passphrase, PIN and panic code), so hiding it would be a one-way door. See
// src/tabs.ts for both rules.
//
// No local ref and no loader here: the checkboxes read the same live module
// state the nav renders from (loaded once at unlock in App.vue), which is what
// keeps the ticks and the menu from ever disagreeing.
const tabChoices = availableTabs();

function toggleTabVisible(id: AppTabId) {
  void setTabVisible(id, !isTabVisible(id));
}

// ── Offline / airplane mode + Use Tor ────────────────────────────────────────
// Both live in the shared network store so that flipping them here immediately
// disables/enables the gated buttons (calls, file transfer, device & peer
// sync) on every open panel — not just after their next remount.
const network = useNetworkStore();
const { offline, useTor } = storeToRefs(network);
async function toggleOffline() {
  await network.setOffline(!offline.value);
}

// Exclusive with iroh: toggling tears down the other transport in Rust, so the
// shown NodeId (iroh) / onion refreshes on the next room command.
async function toggleUseTor() {
  const next = !useTor.value;
  await network.setUseTor(next);
  // Privacy HP: the switch itself costs and earns NOTHING. What it changes is
  // the regeneration rate — every hour with Tor on returns HP three times
  // faster. Recording the posture is what lets that be counted from here on
  // without re-scoring the hours already behind it.
  await recordTorPosture(next);
}

// ── Keep onion stable (encrypted-at-rest HS key) ─────────────────────────────
const stableOnion = ref(false);
async function toggleStableOnion() {
  stableOnion.value = !stableOnion.value;
  await setStableOnion(stableOnion.value);
  // Only the ON direction is an exposure (one long-lived address makes sessions
  // linkable). Switching back is free but earns nothing: the old address was
  // already published to whoever saw it.
  if (stableOnion.value) await chargeHp("transport.onion_stable.enable");
}

// ── DHT discovery (Mainline/Kademlia rendezvous + presence — technology.md §12) ──────────
// Flipping the toggle rebinds the iroh node in Rust (dht_apply), so the new
// setting applies without an app restart; open rooms re-join lazily.
const dhtDiscovery = ref(false);
const dhtBootstrapped = ref<boolean | null>(null); // null = checking / not checked
const dhtRunning = ref(true);
const dhtStatusKey = computed(() => {
  if (dhtBootstrapped.value === null) return "config.dhtStatusChecking";
  if (!dhtRunning.value) return "config.dhtStatusIdle";
  return dhtBootstrapped.value ? "config.dhtStatusOk" : "config.dhtStatusUnreachable";
});
// The probe starts the node if needed, and a fresh Mainline node takes a few
// seconds to fill its routing table — retry before declaring "unreachable".
// The generation counter cancels a stale loop when the toggle/test re-fires.
let dhtStatusGen = 0;
async function refreshDhtStatus() {
  const gen = ++dhtStatusGen;
  if (!dhtDiscovery.value) { dhtBootstrapped.value = null; return; }
  dhtBootstrapped.value = null; // "Checking…"
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = await getDhtStatus();
    if (gen !== dhtStatusGen) return;
    dhtRunning.value = status.running;
    if (!status.enabled || !status.running || status.bootstrapped) {
      dhtBootstrapped.value = status.bootstrapped;
      return;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
    if (gen !== dhtStatusGen) return;
  }
  dhtBootstrapped.value = false;
}
async function toggleDhtDiscovery() {
  const next = !dhtDiscovery.value;
  if (next && !(await confirmHp("dht.presence.enable"))) return;
  dhtDiscovery.value = next;
  await setDhtDiscovery(next);
  // Charged after dht_apply, not before: the record is published by the rebind,
  // so until this resolves nothing has actually been announced.
  await applyDhtDiscovery();
  if (next) await chargeHp("dht.presence.enable");
  else await recoverHp("dht.presence.withdraw");
  void refreshDhtStatus();
}

const dhtRoomPublishSecs = ref(600);
const dhtRoomPublishSaved = ref(false);
async function saveDhtRoomPublish() {
  dhtRoomPublishSecs.value = await setDhtRoomPublishSecs(Number(dhtRoomPublishSecs.value));
  dhtRoomPublishSaved.value = true;
  setTimeout(() => { dhtRoomPublishSaved.value = false; }, 1500);
}

const dhtPresencePollSecs = ref(300);
const dhtPresencePollSaved = ref(false);
async function saveDhtPresencePoll() {
  dhtPresencePollSecs.value = await setDhtPresencePollSecs(Number(dhtPresencePollSecs.value));
  dhtPresencePollSaved.value = true;
  setTimeout(() => { dhtPresencePollSaved.value = false; }, 1500);
}

// ── Connection timeout (room create + join give up after this many seconds) ───
const connectTimeoutSecs = ref(60);
const connectTimeoutSaved = ref(false);
async function saveConnectTimeout() {
  // setConnectTimeoutSecs clamps to [min, max] and returns the stored value.
  connectTimeoutSecs.value = await setConnectTimeoutSecs(Number(connectTimeoutSecs.value));
  connectTimeoutSaved.value = true;
  setTimeout(() => { connectTimeoutSaved.value = false; }, 1500);
}

const meetingReminderMins = ref(15);
const meetingReminderSaved = ref(false);
async function saveMeetingReminder() {
  meetingReminderMins.value = await setMeetingReminderMins(Number(meetingReminderMins.value));
  meetingReminderSaved.value = true;
  setTimeout(() => { meetingReminderSaved.value = false; }, 1500);
  // Turning reminders on is the friendly moment to ask for the notification
  // permission (idempotent; the tick would otherwise ask at the first firing).
  if (meetingReminderMins.value > 0 && (window as any).__TAURI_INTERNALS__) {
    try {
      const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
      if (!(await isPermissionGranted())) await requestPermission();
    } catch { /* permission stays lazy */ }
  }
}

// ── Max file-transfer size (0 = unlimited) ─────────────────────────────────────
const maxFileSizeMb = ref(0);
const maxFileSizeSaved = ref(false);
const fileChunkKib = ref(buildCfg.file_chunk_kib.default);
const fileChunkSaved = ref(false);
const fileIntegrity = ref(buildCfg.file_integrity_default);

async function saveFileChunk() {
  fileChunkKib.value = await setFileChunkKib(Number(fileChunkKib.value));
  fileChunkSaved.value = true;
  setTimeout(() => (fileChunkSaved.value = false), 1500);
}

async function toggleFileIntegrity() {
  fileIntegrity.value = !fileIntegrity.value;
  await setFileIntegrity(fileIntegrity.value);
  if (!fileIntegrity.value) await chargeHp("local.file_integrity.off");
}

async function saveMaxFileSize() {
  // setMaxFileSizeMb clamps to [min, max] and returns the stored value; the
  // build-config default is the fallback for garbage input.
  maxFileSizeMb.value = await setMaxFileSizeMb(Number(maxFileSizeMb.value));
  maxFileSizeSaved.value = true;
  setTimeout(() => { maxFileSizeSaved.value = false; }, 1500);
}


// ── Reset passphrase modal ───────────────────────────────────────────────────
const showResetPass = ref(false);
const resetCurrent = ref("");
const resetNew = ref("");
const resetConfirm = ref("");
const resetError = ref("");
const resetBusy = ref(false);
const resetDone = ref(false);
function openResetPass() {
  resetCurrent.value = "";
  resetNew.value = "";
  resetConfirm.value = "";
  resetError.value = "";
  resetDone.value = false;
  showResetPass.value = true;
}
async function submitResetPass() {
  resetError.value = "";
  if (resetNew.value.length < policy.passphraseMinLen) {
    resetError.value = t("vault.tooShort", { n: policy.passphraseMinLen });
    return;
  }
  if (resetNew.value !== resetConfirm.value) { resetError.value = t("vault.mismatch"); return; }
  resetBusy.value = true;
  try {
    await vaultChangePassphrase(resetCurrent.value, resetNew.value);
    resetDone.value = true;
    setTimeout(() => { showResetPass.value = false; }, 1200);
  } catch (_e) {
    resetError.value = t("vault.wrongPass");
  } finally {
    resetBusy.value = false;
  }
}

// ── Auto-lock (idle timeout) ─────────────────────────────────────────────────
// Minutes of inactivity before the vault re-locks; 0 = never. Saving pushes the
// new value straight to the running watcher in App.vue (applyIdleLockMins) so it
// takes effect without a restart.
const idleLockMins = ref(15);
const idleLockSaved = ref(false);
const locking = ref(false);

async function saveIdleLock() {
  const wasOff = idleLockMins.value === 0;
  // 0 = never auto-lock, which leaves the DEK live in memory indefinitely. The
  // charge follows the STATE, not the edit: changing 15 to 30 is neither an
  // exposure nor a recovery and must move nothing.
  if (Number(idleLockMins.value) === 0 && !wasOff && !(await confirmHp("local.autolock.off"))) {
    return;
  }
  idleLockMins.value = await setIdleLockMins(Number(idleLockMins.value));
  applyIdleLockMins(idleLockMins.value);
  if (idleLockMins.value === 0) await chargeHp("local.autolock.off");
  else await recoverHp("local.autolock.on");
  idleLockSaved.value = true;
  setTimeout(() => { idleLockSaved.value = false; }, 1500);
}

// Lock-on-hide knob: minimize/hide the window → short grace → lock. Pushed live
// to the running watcher in App.vue (applyLockOnHide), same as the minutes above.
const lockOnHide = ref(false);
const lockOnHideBusy = ref(false);

async function toggleLockOnHide() {
  if (lockOnHideBusy.value) return;
  lockOnHideBusy.value = true;
  const next = !lockOnHide.value;
  try {
    await setLockOnHide(next);
    lockOnHide.value = next;
    applyLockOnHide(next);
    if (!next) await chargeHp("local.lock_on_hide.off");
  } finally {
    lockOnHideBusy.value = false;
  }
}

/** "Lock now" — the same path the idle timer takes: Rust tears the session down,
 *  then the reload drops every decrypted value from the webview's memory. */
async function lockNow() {
  locking.value = true;
  try {
    await vaultLock();
  } finally {
    window.location.reload();
  }
}

// ── Panic code modal ─────────────────────────────────────────────────────────
// A duress passphrase for the unlock gate: typing it there wipes every profile on
// this device and opens a fresh empty one keyed by that code. Arming/removing it
// requires the real passphrase, exactly like changing it.
const panicArmed = ref(false);
const showPanic = ref(false);
const panicCurrent = ref("");
const panicNew = ref("");
const panicConfirm = ref("");
const panicError = ref("");
const panicBusy = ref(false);
const panicDone = ref("");


async function loadPanicState() {
  try { panicArmed.value = await vaultHasPanicCode(); } catch { panicArmed.value = false; }
  // A PIN only ever exists for the CURRENT process, so this reflects whether
  // one was enrolled since launch.
  if (pinAllowed) {
    pinEnrolled.value = (await vaultPinStatus().catch(() => null))?.enrolled ?? false;
  }
}


function openPanic() {
  panicCurrent.value = "";
  panicNew.value = "";
  panicConfirm.value = "";
  panicError.value = "";
  panicDone.value = "";
  showPanic.value = true;
}

// ── PIN unlock ────────────────────────────────────────────────────────────────
const pinAllowed = buildCfg.pin_unlock;
const pinDigits = buildCfg.pin_digits.default;
const pinEnrolled = ref(false);
const showPinModal = ref(false);
const pinPassphrase = ref("");
const pinValue = ref("");
const pinPanic = ref("");
const pinPanicCode = ref("");
const pinError = ref("");

function openPinSetup() {
  pinPassphrase.value = "";
  pinValue.value = "";
  pinPanic.value = "";
  pinPanicCode.value = "";
  pinError.value = "";
  showPinModal.value = true;
}

async function submitPin() {
  pinError.value = "";
  try {
    await vaultPinEnroll(
      pinPassphrase.value,
      pinValue.value,
      pinPanic.value || undefined,
      pinPanicCode.value || undefined,
    );
    pinEnrolled.value = true;
    showPinModal.value = false;
    // The PIN is a memory-only convenience layer over the passphrase, so it is a
    // small, real reduction rather than an exposure (technology.md §7).
    await chargeHp("local.pin.enroll");
  } catch (e) {
    pinError.value = (e as Error)?.message ?? String(e);
  }
}

async function removePin() {
  await vaultPinClear();
  pinEnrolled.value = false;
}

async function submitPanic() {
  panicError.value = "";
  if (panicNew.value.length < policy.passphraseMinLen) {
    panicError.value = t("vault.tooShort", { n: policy.passphraseMinLen });
    return;
  }
  if (panicNew.value !== panicConfirm.value) { panicError.value = t("vault.mismatch"); return; }
  panicBusy.value = true;
  try {
    await vaultSetPanicCode(panicCurrent.value, panicNew.value);
    panicArmed.value = true;
    panicDone.value = t("config.panicCodeSaved");
    setTimeout(() => { showPanic.value = false; }, 1200);
  } catch (err) {
    // The backend is the authority on "same as your passphrase" (it tests the code
    // against the real key slot); everything else is a bad current passphrase.
    const msg = (err as Error).message ?? String(err);
    panicError.value = msg.includes("differ") ? t("vault.panicSame") : t("vault.wrongPass");
  } finally {
    panicBusy.value = false;
  }
}

async function removePanic() {
  panicError.value = "";
  panicBusy.value = true;
  try {
    await vaultClearPanicCode(panicCurrent.value);
    // Not an exposure — a loss of protection under coercion, which is why it is
    // priced low rather than high.
    await chargeHp("local.panic_code.clear");
    panicArmed.value = false;
    panicDone.value = t("config.panicCodeRemoved");
    setTimeout(() => { showPanic.value = false; }, 1200);
  } catch (_e) {
    panicError.value = t("vault.wrongPass");
  } finally {
    panicBusy.value = false;
  }
}

onMounted(async () => {
  await loadRuntimeConfig();
  await network.refresh();
  stableOnion.value = await getStableOnion();
  connectTimeoutSecs.value = await getConnectTimeoutSecs();
  meetingReminderMins.value = await getMeetingReminderMins();
  maxFileSizeMb.value = await getMaxFileSizeMb();
  fileChunkKib.value = await getFileChunkKib();
  fileIntegrity.value = await getFileIntegrity();
  if (dhtAllowed) {
    dhtDiscovery.value = await getDhtDiscovery();
    dhtRoomPublishSecs.value = await getDhtRoomPublishSecs();
    dhtPresencePollSecs.value = await getDhtPresencePollSecs();
  }
  idleLockMins.value = await getIdleLockMins();
  lockOnHide.value = await getLockOnHide();
  if (dhtAllowed) void refreshDhtStatus();
  await loadOfflineData();
  void loadPanicState();
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
    `${t("config.chipState")}: ${runtimeConfig.value.profile_state_path}`,
    `${t("config.chipOfflineData")}: ${
      selectedOfflineProfileHasData.value ? t("config.chipSaved") : t("config.chipEmpty")
    }`,
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
    await setActiveProfile(label, label);
    // Each profile has its own encrypted vault, and switching re-opens the new
    // one LOCKED. Reload so App.vue's gate re-runs and prompts for that profile's
    // passphrase (setup on first use, or unlock) before anything loads.
    window.location.reload();
  } catch (e) {
    offlineMessage.value = (e as Error).message;
    loadProfileStatus.value = "error";
  }
}

async function clearSelectedOfflineData() {
  clearingOffline.value = true;
  try {
    offlineState.value = await clearOfflineProfile();
    // Also reset the Tor onion keystore — clears stale locks (the "resource already
    // in use" launch failure) and mints a fresh .onion next time.
    await cleanTorKeystore();
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
        :class="activeTab === 'connections'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'connections'"
      >
        <font-awesome-icon icon="circle-nodes" />{{ $t('nav.connections') }}
      </button>
      <button
        type="button"
        :class="activeTab === 'lock'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'lock'"
      >
        <font-awesome-icon icon="key" />{{ $t('nav.lock') }}
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

    <!-- Visible tabs — a per-device UI preference (device-local, never synced:
         a phone's drawer and a desktop nav bar want different sets). Unticking
         removes the tab from both navs and makes its route unreachable; nothing
         behind it is torn down, so a hidden Calendar still runs its reminders
         and a hidden Contacts still accepts invites. Settings gets no checkbox
         — it is the only way back here. -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.tabsSection') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.tabsHint') }}</p>
      </div>
      <div class="space-y-2">
        <label
          v-for="tab in tabChoices"
          :key="tab.id"
          class="flex cursor-pointer items-center gap-3 text-sm"
        >
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 accent-current"
            :checked="isTabVisible(tab.id)"
            :data-testid="`tab-visible-${tab.id}`"
            @change="toggleTabVisible(tab.id)"
          />
          <font-awesome-icon :icon="tab.icon" class="w-4 shrink-0 text-center opacity-60" />
          <span class="min-w-0 font-semibold">{{ $t(tab.labelKey) }}</span>
        </label>
      </div>
      <p class="text-xs opacity-60">{{ $t('config.tabsAlwaysSettings') }}</p>
    </OyaCard>

    <!-- This device's NodeId lives on the Contacts tab ("My code"), where the
         QR is actually used — it was a duplicate here. -->

    <!-- Max file-transfer size — local guard on P2P file sharing (both directions);
         0 disables the limit. Enforced by useFileShare, not the backend. -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.maxFileSize') }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <font-awesome-icon icon="file-arrow-up" class="shrink-0 opacity-60" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.maxFileSize') }}</p>
          <p class="text-xs opacity-60">{{ $t('config.maxFileSizeHint') }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            v-model.number="maxFileSizeMb"
            type="number"
            :min="buildCfg.max_file_size_mb.min"
            :max="buildCfg.max_file_size_mb.max"
            class="w-24 rounded-lg border bg-transparent px-2 py-1.5 text-right text-sm"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            @change="saveMaxFileSize"
            @keyup.enter="saveMaxFileSize"
          />
          <span class="text-xs opacity-60">MB</span>
          <span v-if="maxFileSizeSaved" class="text-xs text-success-dark">{{ $t('common.saved') }}</span>
        </div>
      </div>

      <!-- Transfer chunking: each chunk is one MLS message on the wire. -->
      <div class="flex items-center gap-3 border-t border-current/10 pt-4">
        <font-awesome-icon icon="layer-group" class="shrink-0 opacity-60" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.fileChunkSize') }}</p>
          <p class="text-xs opacity-60">{{ $t('config.fileChunkSizeHint') }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            v-model.number="fileChunkKib"
            type="number"
            :min="buildCfg.file_chunk_kib.min"
            :max="buildCfg.file_chunk_kib.max"
            class="w-24 rounded-lg border bg-transparent px-2 py-1.5 text-right text-sm"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            data-testid="file-chunk-input"
            @change="saveFileChunk"
            @keyup.enter="saveFileChunk"
          />
          <span class="text-xs opacity-60">KiB</span>
          <span v-if="fileChunkSaved" class="text-xs text-success-dark">{{ $t('common.saved') }}</span>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <font-awesome-icon icon="shield-halved" class="shrink-0 opacity-60" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.fileIntegrity') }}</p>
          <p class="text-xs opacity-60">{{ $t('config.fileIntegrityHint') }}</p>
          <OyaHpPrice
            v-if="fileIntegrity ? priceFor('local.file_integrity.off') : 0 !== 0"
            class="mt-1"
            :centi="fileIntegrity ? priceFor('local.file_integrity.off') : 0"
            :explain="hpExplain('local.file_integrity.off')"
            data-testid="hp-badge-integrity"
          />
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="fileIntegrity"
          :aria-label="$t('config.fileIntegrity')"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
          :class="fileIntegrity ? 'bg-accent-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
          data-testid="file-integrity-toggle"
          @click="toggleFileIntegrity"
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-white transition"
            :class="fileIntegrity ? 'translate-x-6' : 'translate-x-1'"
          />
        </button>
      </div>
    </OyaCard>


    <!-- Meeting reminder lead time — minutes before a meeting starts to fire a
         local OS notification (0 disables). Enforced by useMeetings' tick. -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.meetingReminder') }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <font-awesome-icon icon="calendar" class="shrink-0 opacity-60" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.meetingReminder') }}</p>
          <p class="text-xs opacity-60">{{ $t('config.meetingReminderHint') }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            v-model.number="meetingReminderMins"
            type="number"
            :min="MEETING_REMINDER_MIN_MINS"
            :max="MEETING_REMINDER_MAX_MINS"
            class="w-20 rounded-lg border bg-transparent px-2 py-1.5 text-right text-sm"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            @change="saveMeetingReminder"
            @keyup.enter="saveMeetingReminder"
          />
          <span class="text-xs opacity-60">min</span>
          <span v-if="meetingReminderSaved" class="text-xs text-success-dark">{{ $t('common.saved') }}</span>
        </div>
      </div>
    </OyaCard>
    </template>

    <!-- Data tab — offline mode + local data profiles -->
    <template v-if="activeTab === 'connections'">
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

          <!-- Not a price: Tor is free to switch. The badge advertises the
               regeneration bonus, which is what actually changes. -->
          <span
            class="mt-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-bold"
            :class="useTor
              ? 'border-success-light/50 text-success-light dark:border-success-dark/50 dark:text-success-dark'
              : 'border-current/25 opacity-70'"
            data-testid="hp-badge-tor"
          >
            <font-awesome-icon icon="shield-halved" />
            {{ useTor
              ? $t('hp.torRateActive', { n: formatHp(hpBalances.daily.regenPerHourCenti) })
              : $t('hp.torRateOffer', { n: formatHp(hpBalances.daily.torRegenPerHourCenti) }) }}
          </span>
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

    <!-- Keep onion stable — encrypted-at-rest HS key (only relevant with Tor on) -->
    <OyaCard v-if="useTor" :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.stableOnion') }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <font-awesome-icon icon="circle-nodes" :class="stableOnion ? 'text-accent-dark' : 'opacity-60'" class="shrink-0" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.stableOnion') }}</p>
          <p class="text-xs opacity-60">
            {{ stableOnion ? $t('config.stableOnionOnHint') : $t('config.stableOnionOffHint') }}
          </p>
          <OyaHpPrice
            v-if="stableOnion ? 0 : priceFor('transport.onion_stable.enable') !== 0"
            class="mt-1"
            :centi="stableOnion ? 0 : priceFor('transport.onion_stable.enable')"
            :explain="hpExplain('transport.onion_stable.enable')"
            data-testid="hp-badge-stable-onion"
          />
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="stableOnion"
          :class="stableOnion ? 'bg-accent-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
          @click="toggleStableOnion"
        >
          <span
            :class="stableOnion ? 'translate-x-6' : 'translate-x-1'"
            class="inline-block h-4 w-4 transform rounded-full bg-white transition"
          />
        </button>
      </div>
    </OyaCard>

    <!-- DHT discovery — Mainline/Kademlia rendezvous + presence (technology.md §12). Opt-in;
         on → rooms get a ticketless join code and Contacts presence works.
         Absent in a build without dht.enabled (Pro only — technology.md §20) or without
         p2p.allow_hosted_relays, in both cases because Rust reports the DHT
         disabled regardless of the kv toggle. Also HIDDEN in Tor mode: the
         DHT rides the iroh endpoint, which Tor-exclusive mode shuts down, so
         there is nothing here to decide. Every other DHT surface in the app
         points at THIS card, so they all hide on the same condition. -->
    <OyaCard v-if="dhtAllowed && !useTor" :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.dhtDiscovery') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.dhtDiscoveryHint') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <font-awesome-icon
          icon="satellite-dish"
          :class="dhtDiscovery ? 'text-accent-dark' : 'opacity-60'"
          class="shrink-0"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.dhtDiscovery') }}</p>
          <p class="text-xs opacity-60">
            {{ dhtDiscovery ? $t('config.dhtDiscoveryOnHint') : $t('config.dhtDiscoveryOffHint') }}
          </p>
          <OyaHpPrice
            v-if="dhtDiscovery ? creditFor('dht.presence.withdraw') : priceFor('dht.presence.enable') !== 0"
            class="mt-1"
            :centi="dhtDiscovery ? creditFor('dht.presence.withdraw') : priceFor('dht.presence.enable')"
            :explain="hpExplain('dht.presence.enable')"
            data-testid="hp-badge-dht"
          />
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="dhtDiscovery"
          :aria-label="$t('config.dhtDiscovery')"
          :class="dhtDiscovery ? 'bg-accent-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
          @click="toggleDhtDiscovery"
        >
          <span
            :class="dhtDiscovery ? 'translate-x-6' : 'translate-x-1'"
            class="inline-block h-4 w-4 transform rounded-full bg-white transition"
          />
        </button>
      </div>

      <template v-if="dhtDiscovery">
        <!-- Status: has our Kademlia node a live routing table + manual probe -->
        <div class="flex items-center gap-2 text-xs">
          <span
            :class="dhtBootstrapped === null
              ? 'animate-pulse bg-current opacity-30'
              : !dhtRunning
                ? 'bg-current opacity-20'
                : dhtBootstrapped ? 'bg-success-dark' : 'bg-warn-dark'"
            class="inline-block h-2 w-2 shrink-0 rounded-full"
          />
          <span class="min-w-0 flex-1 opacity-70">{{ $t(dhtStatusKey) }}</span>
          <button
            type="button"
            :class="{ 'pointer-events-none opacity-50': dhtBootstrapped === null }"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1 font-semibold transition hover:opacity-80"
            @click="refreshDhtStatus"
          >
            <font-awesome-icon icon="satellite-dish" class="mr-1" />{{ $t('config.dhtTest') }}
          </button>
        </div>

        <!-- Rendezvous re-publish cadence -->
        <div class="flex items-center gap-3">
          <font-awesome-icon icon="rotate-right" class="shrink-0 opacity-60" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold">{{ $t('config.dhtRoomPublish') }}</p>
            <p class="text-xs opacity-60">{{ $t('config.dhtRoomPublishHint') }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <input
              v-model.number="dhtRoomPublishSecs"
              type="number"
              :min="buildCfg.dht_room_publish_secs.min"
              :max="buildCfg.dht_room_publish_secs.max"
              class="w-20 rounded-lg border bg-transparent px-2 py-1.5 text-right text-sm"
              :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
              @change="saveDhtRoomPublish"
              @keyup.enter="saveDhtRoomPublish"
            />
            <span class="text-xs opacity-60">s</span>
            <span v-if="dhtRoomPublishSaved" class="text-xs text-success-dark">{{ $t('common.saved') }}</span>
          </div>
        </div>

        <!-- Contacts presence poll cadence -->
        <div class="flex items-center gap-3">
          <font-awesome-icon icon="clock" class="shrink-0 opacity-60" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold">{{ $t('config.dhtPresencePoll') }}</p>
            <p class="text-xs opacity-60">{{ $t('config.dhtPresencePollHint') }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <input
              v-model.number="dhtPresencePollSecs"
              type="number"
              :min="DHT_PRESENCE_POLL_MIN_SECS"
              :max="DHT_PRESENCE_POLL_MAX_SECS"
              class="w-20 rounded-lg border bg-transparent px-2 py-1.5 text-right text-sm"
              :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
              @change="saveDhtPresencePoll"
              @keyup.enter="saveDhtPresencePoll"
            />
            <span class="text-xs opacity-60">s</span>
            <span v-if="dhtPresencePollSaved" class="text-xs text-success-dark">{{ $t('common.saved') }}</span>
          </div>
        </div>
      </template>
    </OyaCard>

    <!-- Connection timeout — room create/join give up (and the join modal auto-closes
         after connecting) once this many seconds elapse. Applies to Tor AND iroh. -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.connectTimeout') }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <font-awesome-icon icon="clock" class="shrink-0 opacity-60" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.connectTimeout') }}</p>
          <p class="text-xs opacity-60">{{ $t('config.connectTimeoutHint') }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            v-model.number="connectTimeoutSecs"
            type="number"
            :min="buildCfg.connect_timeout_secs.min"
            :max="buildCfg.connect_timeout_secs.max"
            class="w-20 rounded-lg border bg-transparent px-2 py-1.5 text-right text-sm"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            @change="saveConnectTimeout"
            @keyup.enter="saveConnectTimeout"
          />
          <span class="text-xs opacity-60">s</span>
          <span v-if="connectTimeoutSaved" class="text-xs text-success-dark">{{ $t('common.saved') }}</span>
        </div>
      </div>
    </OyaCard>
    </template>

    <!-- Lock tab — everything guarding the vault: when it locks itself, the
         passphrase that opens it, and the code that destroys it -->
    <template v-if="activeTab === 'lock'">
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('nav.lock') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.lockHint') }}</p>
      </div>
    </OyaCard>

    <!-- Auto-lock — re-lock the vault after a stretch of inactivity -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.idleLock') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.idleLockHint') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <font-awesome-icon icon="clock" class="shrink-0 opacity-60" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.idleLock') }}</p>
          <p class="text-xs opacity-60">{{ $t('config.idleLockOff') }}</p>
          <!-- Priced by the STATE the number produces, not by the edit: 0 means
               "never auto-lock", which leaves the key in memory indefinitely. -->
          <OyaHpPrice
            v-if="Number(idleLockMins) === 0"
            class="mt-1"
            :centi="priceFor('local.autolock.off')"
            :explain="hpExplain('local.autolock.off')"
            data-testid="hp-badge-autolock"
          />
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            v-model.number="idleLockMins"
            type="number"
            :min="buildCfg.idle_lock_mins.min"
            :max="buildCfg.idle_lock_mins.max"
            class="w-20 rounded-lg border bg-transparent px-2 py-1.5 text-right text-sm"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            @change="saveIdleLock"
            @keyup.enter="saveIdleLock"
          />
          <span class="text-xs opacity-60">min</span>
          <span v-if="idleLockSaved" class="text-xs text-success-dark">{{ $t('common.saved') }}</span>
        </div>
      </div>

      <!-- Lock-on-hide knob — minimize/hide the window → short grace → lock -->
      <div class="flex items-center gap-3 border-t pt-4" :class="darkMode ? 'border-accent-1/40' : 'border-accent-2/40'">
        <font-awesome-icon
          icon="eye-slash"
          :class="lockOnHide ? 'text-warn-dark' : 'opacity-60'"
          class="shrink-0"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t('config.lockOnHide') }}</p>
          <p class="text-xs opacity-60">{{ $t('config.lockOnHideHint') }}</p>
          <OyaHpPrice
            v-if="lockOnHide ? priceFor('local.lock_on_hide.off') : 0 !== 0"
            class="mt-1"
            :centi="lockOnHide ? priceFor('local.lock_on_hide.off') : 0"
            :explain="hpExplain('local.lock_on_hide.off')"
            data-testid="hp-badge-lock-on-hide"
          />
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="lockOnHide"
          :disabled="lockOnHideBusy"
          :class="lockOnHide ? 'bg-warn-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
          @click="toggleLockOnHide"
        >
          <span
            :class="lockOnHide ? 'translate-x-6' : 'translate-x-1'"
            class="inline-block h-4 w-4 transform rounded-full bg-white transition"
          />
        </button>
      </div>

      <OyaButton
        :dark-mode="darkMode"
        variant="secondary"
        :class="{ 'pointer-events-none opacity-60': locking }"
        @click="lockNow"
      >
        <font-awesome-icon icon="lock" />{{ $t('config.lockNow') }}
      </OyaButton>
    </OyaCard>

    <!-- Reset passphrase — change the at-rest encryption passphrase -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.resetPass') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.resetPassHint') }}</p>
      </div>
      <OyaButton :dark-mode="darkMode" variant="secondary" @click="openResetPass">
        <font-awesome-icon icon="key" />{{ $t('config.resetPass') }}
      </OyaButton>
    </OyaCard>

    <!-- PIN unlock — convenience re-unlock after an idle lock (this session only) -->
    <OyaCard v-if="pinAllowed" :dark-mode="darkMode" :padded="true" class="space-y-4" data-testid="pin-card">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.pinUnlock') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.pinUnlockHint') }}</p>
      </div>
      <p class="text-sm font-semibold" :class="pinEnrolled ? 'text-success-dark' : 'opacity-70'">
        {{ pinEnrolled ? $t('config.pinOn') : $t('config.pinOff') }}
      </p>
      <div class="flex flex-wrap gap-2">
        <OyaButton :dark-mode="darkMode" variant="secondary" data-testid="pin-setup" @click="openPinSetup">
          <font-awesome-icon icon="lock" />{{ pinEnrolled ? $t('config.pinChange') : $t('config.pinSet') }}
        </OyaButton>
        <OyaButton
          v-if="pinEnrolled"
          :dark-mode="darkMode"
          variant="secondary"
          data-testid="pin-remove"
          @click="removePin"
        >
          {{ $t('config.pinRemove') }}
        </OyaButton>
      </div>
    </OyaCard>

    <!-- Panic code — duress passphrase that wipes this device at the unlock gate -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('config.panicCode') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('config.panicCodeHint') }}</p>
        <p class="mt-2 text-sm" :class="panicArmed ? 'text-warn-dark' : 'opacity-65'">
          <font-awesome-icon v-if="panicArmed" icon="shield-halved" class="mr-1" />
          {{ panicArmed ? $t('config.panicCodeArmed') : $t('config.panicCodeNone') }}
        </p>
      </div>
      <OyaButton :dark-mode="darkMode" variant="secondary" @click="openPanic">
        <font-awesome-icon icon="triangle-exclamation" />
        {{ panicArmed ? $t('config.panicCodeChange') : $t('config.panicCodeSet') }}
      </OyaButton>

    </OyaCard>
    </template>

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
              :maxlength="policy.profileNameMaxLen"
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

    <!-- Reset-passphrase modal -->
    <OyaModal v-model:open="showResetPass" @close="showResetPass = false">
      <div class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="text-lg font-bold">{{ $t('vault.resetTitle') }}</p>
        <OyaTextField v-model="resetCurrent" type="password" :placeholder="$t('config.currentPass')" :disabled="resetBusy" />
        <OyaTextField v-model="resetNew" type="password" :placeholder="$t('config.newPass')" :disabled="resetBusy" />
        <OyaTextField v-model="resetConfirm" type="password" :placeholder="$t('vault.confirmPass')" :disabled="resetBusy" />
        <p v-if="resetError" class="text-sm text-warn-dark">{{ resetError }}</p>
        <p v-if="resetDone" class="text-sm text-success-dark">{{ $t('config.resetPassOk') }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton :dark-mode="darkMode" variant="secondary" @click="showResetPass = false">
            {{ $t('vault.cancel') }}
          </OyaButton>
          <OyaButton
            :dark-mode="darkMode"
            :class="{ 'pointer-events-none opacity-60': resetBusy }"
            @click="submitResetPass"
          >
            <font-awesome-icon :icon="resetBusy ? 'lock' : 'key'" />{{ $t('vault.reset') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>

    <!-- Panic-code modal -->
    <!-- PIN setup modal: the passphrase proves knowledge before it is sealed. -->
    <OyaModal :open="showPinModal" @close="showPinModal = false">
      <div class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="lock" />{{ $t('config.pinSet') }}
        </p>
        <p class="text-xs opacity-60">{{ $t('config.pinModalHint', { n: pinDigits }) }}</p>
        <OyaTextField v-model="pinPassphrase" type="password" :placeholder="$t('vault.enterPass')" />
        <OyaTextField v-model="pinValue" type="password" :placeholder="$t('config.pinField')" data-testid="pin-input" />
        <OyaTextField v-model="pinPanic" type="password" :placeholder="$t('config.pinPanicField')" />
        <OyaTextField
          v-if="pinPanic"
          v-model="pinPanicCode"
          type="password"
          :placeholder="$t('config.pinPanicCodeField')"
        />
        <p class="text-xs opacity-60">{{ $t('config.pinPanicHint') }}</p>
        <p v-if="pinError" class="text-sm text-warn-dark" data-testid="pin-error">{{ pinError }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton :dark-mode="darkMode" variant="secondary" @click="showPinModal = false">
            {{ $t('common.cancel') }}
          </OyaButton>
          <OyaButton :dark-mode="darkMode" data-testid="pin-submit" @click="submitPin">
            {{ $t('config.pinSet') }}
          </OyaButton>
        </div>
      </div>
    </OyaModal>

    <OyaModal v-model:open="showPanic" @close="showPanic = false">
      <div class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="text-lg font-bold">{{ $t('vault.panicTitle') }}</p>
        <p class="text-sm text-warn-dark">{{ $t('vault.panicWarning') }}</p>
        <OyaTextField v-model="panicCurrent" type="password" :placeholder="$t('config.currentPass')" :disabled="panicBusy" />
        <OyaTextField v-model="panicNew" type="password" :placeholder="$t('vault.panicCode')" :disabled="panicBusy" />
        <OyaTextField v-model="panicConfirm" type="password" :placeholder="$t('vault.panicConfirm')" :disabled="panicBusy" />
        <p v-if="panicError" class="text-sm text-warn-dark">{{ panicError }}</p>
        <p v-if="panicDone" class="text-sm text-success-dark">{{ panicDone }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton :dark-mode="darkMode" variant="secondary" @click="showPanic = false">
            {{ $t('vault.cancel') }}
          </OyaButton>
          <!-- Removing only needs the real passphrase — the code fields stay blank. -->
          <OyaButton
            v-if="panicArmed"
            :dark-mode="darkMode"
            variant="secondary"
            :class="{ 'pointer-events-none opacity-60': panicBusy }"
            @click="removePanic"
          >
            <font-awesome-icon icon="trash" />{{ $t('config.panicCodeRemove') }}
          </OyaButton>
          <OyaButton
            :dark-mode="darkMode"
            :class="{ 'pointer-events-none opacity-60': panicBusy }"
            @click="submitPanic"
          >
            <font-awesome-icon :icon="panicBusy ? 'lock' : 'triangle-exclamation'" />{{ $t('config.panicCodeSet') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>

  </section>
</template>

<style scoped>
.config-control {
  color-scheme: light;
}

/* Native <select>/<option> can't take Tailwind classes reliably (color-scheme),
   so we style them here — but pull from the @theme tokens (exposed as :root CSS
   vars by Tailwind v4) instead of re-hardcoding the palette hexes. */
.config-control-light {
  background-color: var(--color-primary-bg-light);
  border-color: var(--color-accent-light);
  color: var(--color-text-main-light);
}

.config-control-light option {
  background-color: var(--color-primary-bg-light);
  color: var(--color-text-main-light);
}

.config-control-dark {
  color-scheme: dark;
  background-color: var(--color-primary-bg-dark);
  border-color: var(--color-accent-dark);
  color: var(--color-text-main-dark);
}

.config-control-dark option {
  background-color: var(--color-primary-bg-dark);
  color: var(--color-text-main-dark);
}

.config-control:focus {
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 18%, transparent);
}

.config-control:disabled {
  opacity: 0.75;
  -webkit-text-fill-color: currentColor;
}
</style>
