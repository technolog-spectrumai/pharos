<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { RouterView, RouterLink, useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useUserStore } from "./stores/user";
import { useChatStore } from "./stores/chat";
import { useCloudStore } from "./stores/cloud";
import { useMapStore } from "./stores/map";
import { barIcon } from "./assets/logos";
import { brand, policy } from "./config/app";
import { useIdleLock, type IdleLockHandle } from "./idleLock";
import {
  OyaButton, OyaTextField, getBuildConfig, getIdleLockMins, isTauri,
  vaultStatus, vaultSetup, vaultUnlock, vaultLock,
} from "rakotis";

const darkMode = ref(true);
const menuOpen = ref(false);
const route = useRoute();
const { t } = useI18n({ useScope: "global" });

// Class-based dark mode: toggle `.dark` on <html> so every `dark:` utility across the
// app (Oya primitives + chat surface) reacts. The `:dark-mode` prop is still passed to
// the not-yet-migrated Config/Profile views below during the transition.
watch(darkMode, (on) => {
  document.documentElement.classList.toggle("dark", on);
}, { immediate: true });

const userStore = useUserStore();
const chatStore = useChatStore();
const cloudStore = useCloudStore();
const mapStore = useMapStore();
const { displayName, avatarDataUrl } = storeToRefs(userStore);

// ── Encryption-at-rest gate ──────────────────────────────────────────────────
// Nothing loads until the vault is unlocked (or set up on first run). The three
// data loaders only run from `runLoaders`, behind this gate.
type GateMode = "loading" | "setup" | "unlock" | "ready";
const gateMode = ref<GateMode>("loading");
const passphrase = ref("");
const confirmPass = ref("");
const gateError = ref("");
const gateBusy = ref(false);
const MIN_LEN = policy.passphraseMinLen;

async function runLoaders() {
  await chatStore.syncRuntimeIdentity();
  await userStore.loadOfflineProfile();
  // Serverless: reopen the last P2P room (reconnect via persisted peer NodeIds).
  void chatStore.init();
  gateMode.value = "ready";
  // Auto-lock starts only once we're past the gate (the setting lives in the
  // encrypted kv, so it can't be read any earlier anyway).
  void startIdleLock();
}

// ── Auto-lock ────────────────────────────────────────────────────────────────
// After the configured idle time the vault re-locks: Rust tears the session down
// (vault_lock) and we reload, which is what clears every decrypted value out of
// the webview's memory. Unsent drafts are lost — the security trade the feature
// exists to make.
let idleLock: IdleLockHandle | null = null;

/** Background work that should hold the countdown off: nothing here involves the
 *  keyboard, but the user is still mid-task and locking would abort it. Outbound
 *  map-region offers ride file_xfer without their own store row, so they're only
 *  covered while the shared fileShare state reflects them. */
function isBusy(): boolean {
  if (chatStore.vox && chatStore.vox.phase.value !== "idle") return true;
  if (["offering", "incoming", "transferring"].includes(chatStore.fileShare.state.value)) return true;
  if (cloudStore.transfers.size > 0) return true;
  for (const rx of mapStore.receives.values()) {
    if (rx.state === "transferring" || rx.state === "importing") return true;
  }
  return false;
}

async function startIdleLock() {
  // Browser-fallback mode has no vault to lock (vaultStatus reports unlocked), so
  // a watcher there would just reload the dev server page on a timer.
  if (!isTauri()) return;
  const mins = await getIdleLockMins();
  idleLock?.stop();
  idleLock = useIdleLock({
    timeoutMs: mins * 60_000,
    isBusy,
    onLock: () => {
      void lockNow();
    },
  });
}

async function lockNow() {
  idleLock?.stop();
  idleLock = null;
  try {
    await vaultLock();
  } finally {
    // Reload regardless: even if the teardown errored the vault may be locked,
    // and a reload lands on the gate rather than a half-dead session.
    window.location.reload();
  }
}

async function doSetup() {
  gateError.value = "";
  if (passphrase.value.length < MIN_LEN) { gateError.value = t("vault.tooShort", { n: MIN_LEN }); return; }
  if (passphrase.value !== confirmPass.value) { gateError.value = t("vault.mismatch"); return; }
  gateBusy.value = true;
  try {
    await vaultSetup(passphrase.value);
    passphrase.value = ""; confirmPass.value = "";
    await runLoaders();
  } catch (e) {
    gateError.value = (e as Error).message || String(e);
  } finally {
    gateBusy.value = false;
  }
}

async function doUnlock() {
  gateError.value = "";
  gateBusy.value = true;
  try {
    await vaultUnlock(passphrase.value);
    passphrase.value = "";
    await runLoaders();
  } catch (_e) {
    gateError.value = t("vault.wrongPass");
  } finally {
    gateBusy.value = false;
  }
}

onMounted(async () => {
  try {
    const s = await vaultStatus();
    if (!s.exists) gateMode.value = "setup";
    else if (!s.unlocked) gateMode.value = "unlock";
    else await runLoaders();
  } catch (e) {
    gateMode.value = "unlock";
    gateError.value = (e as Error).message || String(e);
  }
});

// The chat display name is the local profile's display name (identity otherwise).
watch(displayName, (name) => {
  if (name) chatStore.p2p.currentUserName.value = name;
}, { immediate: true });

// The chat avatar is the local profile's picture — the channel shares it over
// encrypted presence and message envelopes (change propagates live).
watch(avatarDataUrl, (avatar) => {
  chatStore.p2p.myAvatar.value = avatar;
}, { immediate: true });

// Files tab attention dot: an incoming file offer is waiting for accept/decline.
const fileShare = chatStore.fileShare;
// Calls / Contacts / Calendar (compile-time gated — pland.md): each is null in
// an edition without the feature, so every consumer below is null-guarded.
const vox = chatStore.vox;
const callsEnabled = chatStore.callsEnabled;
const invites = chatStore.invites;
const contactsEnabled = chatStore.contactsEnabled;
// Calendar tab attention dot: meeting invites awaiting an RSVP.
const meetings = chatStore.meetings;
const calendarEnabled = chatStore.calendarEnabled;
// Board tab (compile-time gated): remote board changes awaiting a look.
const kanban = chatStore.kanban;
const kanbanEnabled = chatStore.kanbanEnabled;
// Sketch tab (compile-time gated) — a standalone local drawing board.
const sketchEnabled = getBuildConfig().sketch_enabled;
// Map tab (compile-time gated) — offline PMTiles maps, pins, routes.
const mapsEnabled = getBuildConfig().maps_enabled;

// Close menu on navigation
watch(() => route.path, () => {
  menuOpen.value = false;
});

onBeforeUnmount(() => {
  idleLock?.stop();
  idleLock = null;
});
</script>

<template>
  <div
    class="min-h-screen flex flex-col font-sans transition-colors duration-300 bg-primary-bg-light text-text-main-light dark:bg-primary-bg-dark dark:text-text-main-dark"
  >
    <!-- Encryption-at-rest gate: blocks everything until unlocked (non-dismissable) -->
    <div
      v-if="gateMode !== 'ready'"
      class="fixed inset-0 z-[80] flex items-center justify-center bg-primary-bg-light p-6 dark:bg-primary-bg-dark"
    >
      <div class="w-full max-w-sm space-y-5">
        <div class="space-y-2 text-center">
          <img :src="barIcon" :alt="brand.name" class="mx-auto h-14 w-14 rounded-xl object-contain" />
          <h1 class="text-2xl font-bold">{{ brand.name }}</h1>
          <p v-if="gateMode !== 'loading'" class="text-sm opacity-70">
            {{ gateMode === 'setup' ? $t('vault.setupHint') : $t('vault.unlockHint') }}
          </p>
        </div>

        <p v-if="gateMode === 'loading'" class="text-center opacity-60">…</p>

        <form
          v-else
          class="space-y-3"
          @submit.prevent="gateMode === 'setup' ? doSetup() : doUnlock()"
        >
          <OyaTextField
            v-model="passphrase"
            type="password"
            :placeholder="$t('vault.enterPass')"
            :disabled="gateBusy"
          />
          <OyaTextField
            v-if="gateMode === 'setup'"
            v-model="confirmPass"
            type="password"
            :placeholder="$t('vault.confirmPass')"
            :disabled="gateBusy"
          />
          <p v-if="gateError" class="text-sm text-warn-dark">{{ gateError }}</p>
          <OyaButton
            type="submit"
            :dark-mode="darkMode"
            class="w-full justify-center"
            :class="{ 'pointer-events-none opacity-60': gateBusy }"
          >
            <font-awesome-icon :icon="gateBusy ? 'lock' : gateMode === 'setup' ? 'shield-halved' : 'lock-open'" />
            {{ gateBusy ? $t('vault.deriving') : gateMode === 'setup' ? $t('vault.create') : $t('vault.unlock') }}
          </OyaButton>
        </form>
      </div>
    </div>

    <!-- App shell (only after unlock) -->
    <template v-if="gateMode === 'ready'">
    <!-- Header -->
    <header
      class="sticky top-0 z-50 border-b border-current/10 shadow-md pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] bg-header-bg-light text-appbar-text-light dark:bg-header-bg-dark dark:text-appbar-text-dark"
    >
      <div class="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">

        <!-- Logo -->
        <RouterLink to="/" class="flex items-center gap-3 hover:opacity-80 transition">
          <img :src="barIcon" alt="Enigma icon" class="h-9 w-9 rounded-lg object-contain" />
          <h1 class="text-xl font-bold tracking-wide sm:text-2xl">{{ brand.name }}</h1>
        </RouterLink>

        <!-- Desktop nav -->
        <nav class="hidden lg:flex items-center gap-x-4 gap-y-2 text-sm flex-wrap">
          <RouterLink to="/chat" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.chat')">
            <font-awesome-icon icon="comments" />
            {{ $t('nav.chat') }}
          </RouterLink>
          <RouterLink to="/files" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.files')">
            <font-awesome-icon icon="file-arrow-up" />
            {{ $t('nav.files') }}
            <span
              v-if="fileShare.state.value === 'incoming'"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('fileShare.wantsToSend')"
            />
          </RouterLink>
          <RouterLink v-if="callsEnabled" to="/calls" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.calls')">
            <font-awesome-icon icon="phone" />
            {{ $t('nav.calls') }}
            <span
              v-if="vox?.phase.value === 'incoming'"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('vox.incomingTitle')"
            />
          </RouterLink>
          <RouterLink v-if="calendarEnabled" to="/calendar" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.calendar')">
            <font-awesome-icon icon="calendar" />
            {{ $t('nav.calendar') }}
            <span
              v-if="(meetings?.attentionCount.value ?? 0) > 0"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('calendar.attentionTitle')"
            />
          </RouterLink>
          <RouterLink v-if="kanbanEnabled" to="/board" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.board')">
            <font-awesome-icon icon="table-columns" />
            {{ $t('nav.board') }}
            <span
              v-if="(kanban?.attentionCount.value ?? 0) > 0"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('kanban.attentionTitle')"
            />
          </RouterLink>
          <RouterLink v-if="sketchEnabled" to="/sketch" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.sketch')">
            <font-awesome-icon icon="pencil" />
            {{ $t('nav.sketch') }}
          </RouterLink>
          <RouterLink v-if="mapsEnabled" to="/map" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.map')">
            <font-awesome-icon icon="map" />
            {{ $t('nav.map') }}
          </RouterLink>
          <RouterLink v-if="contactsEnabled" to="/contacts" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.contacts')">
            <font-awesome-icon icon="address-book" />
            {{ $t('nav.contacts') }}
            <span
              v-if="invites?.incoming.value"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('contacts.incomingTitle')"
            />
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
          class="lg:hidden border-t divide-y divide-current/10 bg-header-bg-light border-accent-2 dark:bg-header-bg-dark dark:border-accent-1"
        >
          <RouterLink to="/chat" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="comments" class="w-4 text-center" />
            {{ $t('nav.chat') }}
          </RouterLink>
          <RouterLink to="/files" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="file-arrow-up" class="w-4 text-center" />
            {{ $t('nav.files') }}
            <span
              v-if="fileShare.state.value === 'incoming'"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
          </RouterLink>
          <RouterLink v-if="callsEnabled" to="/calls" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="phone" class="w-4 text-center" />
            {{ $t('nav.calls') }}
            <span
              v-if="vox?.phase.value === 'incoming'"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
          </RouterLink>
          <RouterLink v-if="calendarEnabled" to="/calendar" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="calendar" class="w-4 text-center" />
            {{ $t('nav.calendar') }}
            <span
              v-if="(meetings?.attentionCount.value ?? 0) > 0"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
          </RouterLink>
          <RouterLink v-if="kanbanEnabled" to="/board" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="table-columns" class="w-4 text-center" />
            {{ $t('nav.board') }}
            <span
              v-if="(kanban?.attentionCount.value ?? 0) > 0"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
          </RouterLink>
          <RouterLink v-if="sketchEnabled" to="/sketch" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="pencil" class="w-4 text-center" />
            {{ $t('nav.sketch') }}
          </RouterLink>
          <RouterLink v-if="mapsEnabled" to="/map" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="map" class="w-4 text-center" />
            {{ $t('nav.map') }}
          </RouterLink>
          <RouterLink v-if="contactsEnabled" to="/contacts" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="address-book" class="w-4 text-center" />
            {{ $t('nav.contacts') }}
            <span
              v-if="invites?.incoming.value"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
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
      class="border-t border-current/10 px-4 py-4 text-center text-sm shadow-lg pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] bg-footer-bg-light text-footer-text-light dark:bg-footer-bg-dark dark:text-footer-text-dark"
    >
      <p class="opacity-90">{{ brand.copyright }}</p>
    </footer>
    </template>
  </div>
</template>
