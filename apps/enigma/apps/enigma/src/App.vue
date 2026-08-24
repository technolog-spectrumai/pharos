<script setup lang="ts">
import { ref, shallowRef, watch, onMounted, onBeforeUnmount } from "vue";
import { RouterView, RouterLink, useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useUserStore } from "./stores/user";
import { useChatStore } from "./stores/chat";
import { useMapStore } from "./stores/map";
import IdleLockWarning from "./components/IdleLockWarning.vue";
import HpChip from "./components/hp/HpChip.vue";
import HpFlash from "./components/hp/HpFlash.vue";
import HpConfirmModal from "./components/hp/HpConfirmModal.vue";
import { startHp, stopHp } from "./components/hp/useHp";
import PinPad from "./components/PinPad.vue";
import { appIcon, barIcon } from "./assets/logos";
import { brand, policy } from "./config/app";
import { useIdleLock, useHideLock, type IdleLockHandle, type HideLockHandle } from "./idleLock";
import { isTabVisible, loadTabVisibility } from "./tabs";
import {
  OyaButton, OyaTextField, getBuildConfig, getIdleLockMins, getLockOnHide, isTauri,
  vaultStatus, vaultSetup, vaultUnlock, vaultLock, vaultTouch,
  vaultPinStatus, vaultPinUnlock,
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
const mapStore = useMapStore();
const { displayName, avatarDataUrl } = storeToRefs(userStore);

// ── Encryption-at-rest gate ──────────────────────────────────────────────────
// Nothing loads until the vault is unlocked (or set up on first run). The three
// data loaders only run from `runLoaders`, behind this gate.
// "pin" is offered only after an IN-SESSION lock: the Rust side holds the
// sealed passphrase in memory, so a restart lands on "unlock" as before.
type GateMode = "loading" | "setup" | "unlock" | "pin" | "ready";
const gateMode = ref<GateMode>("loading");
const passphrase = ref("");
const confirmPass = ref("");
const gateError = ref("");
const gateBusy = ref(false);
const MIN_LEN = policy.passphraseMinLen;
const pinDigits = ref(getBuildConfig().pin_digits.default);

async function runLoaders() {
  // Which tabs this user wants in the nav (src/tabs.ts). It lives in the
  // encrypted kv, so this is the earliest point it can be read at all — awaited
  // before `ready` so the nav's first frame is already the right one, and the
  // router re-validates the route the app booted into off the same change.
  await loadTabVisibility();
  // Privacy HP meters. The ledger is sealed in the vault, so like the tab
  // choice this is the earliest point it can be read; not awaited past its own
  // first read, since a slow ledger must never hold up the app's first frame.
  void startHp();
  await chatStore.syncRuntimeIdentity();
  await userStore.loadOfflineProfile();
  // Serverless: reopen the last P2P room (reconnect via persisted peer NodeIds).
  void chatStore.init();
  // Device file sync listens app-wide: a push from the user's other device must
  // land even while they are on another tab.
  gateMode.value = "ready";
  // Auto-lock starts only once we're past the gate (the setting lives in the
  // encrypted kv, so it can't be read any earlier anyway).
  void startIdleLock();
  void startHideLock();
}

// ── Auto-lock ────────────────────────────────────────────────────────────────
// After the configured idle time the vault re-locks: Rust tears the session down
// (vault_lock) and we reload, which is what clears every decrypted value out of
// the webview's memory. Unsent drafts are lost — the security trade the feature
// exists to make. A ref (not a plain let) so the warning toast can bind to it.
const idleLock = shallowRef<IdleLockHandle | null>(null);
let hideLock: HideLockHandle | null = null;
// Shows the pre-lock countdown toast. Not suppressed while the window is hidden:
// the toast is invisible along with the window, and if the user restores it
// mid-warning that countdown is exactly the information they need.
const lockWarn = ref(false);

/** Background work that should hold the countdown off: nothing here involves the
 *  keyboard, but the user is still mid-task and locking would abort it. Outbound
 *  map-region offers ride file_xfer without their own store row, so they're only
 *  covered while the shared fileShare state reflects them. */
function isBusy(): boolean {
  if (chatStore.vox && chatStore.vox.phase.value !== "idle") return true;
  if (["offering", "incoming", "transferring"].includes(chatStore.fileShare.state.value)) return true;
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
  idleLock.value?.stop();
  idleLock.value = useIdleLock({
    timeoutMs: mins * 60_000,
    isBusy,
    onWarn: () => {
      lockWarn.value = true;
    },
    // Sign-of-life for the Rust watchdog (vault.rs), so it can re-lock on its
    // own if this webview dies with the vault open.
    onHeartbeat: () => {
      void vaultTouch();
    },
    onLock: () => {
      lockWarn.value = false;
      void lockNow();
    },
  });
}

async function startHideLock() {
  if (!isTauri()) return;
  const on = await getLockOnHide();
  hideLock?.stop();
  hideLock = useHideLock({
    enabled: on,
    isBusy,
    onLock: () => {
      lockWarn.value = false;
      void lockNow();
    },
  });
}

async function lockNow() {
  // Drop the HP meters before the vault goes: their ledger belongs to the
  // profile that is closing.
  stopHp();
  idleLock.value?.stop();
  idleLock.value = null;
  hideLock?.stop();
  hideLock = null;
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

/** PIN attempt. A failure clears the pad and, once the attempts run out, Rust
 *  drops the PIN entirely — so we re-check status and fall back to the
 *  passphrase rather than leaving the user at a keypad that can never work. */
async function doPinUnlock(pin: string) {
  gateError.value = "";
  gateBusy.value = true;
  try {
    await vaultPinUnlock(pin);
    await runLoaders();
  } catch (_e) {
    gateError.value = t("vault.wrongPin");
    const status = await vaultPinStatus().catch(() => null);
    if (!status?.enrolled) {
      gateMode.value = "unlock";
      gateError.value = t("vault.pinExhausted");
    }
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

// The Rust watchdog locked the vault (this webview was too frozen to do it
// itself) — reload onto the gate the moment we're running again.
let unlistenLocked: (() => void) | null = null;

onMounted(async () => {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    unlistenLocked = await listen("vault://locked", () => {
      window.location.reload();
    });
  }
  try {
    const s = await vaultStatus();
    if (!s.exists) gateMode.value = "setup";
    else if (!s.unlocked) {
      // A PIN exists only if this process enrolled one earlier, so its presence
      // is exactly the "locked within the same session" signal.
      const pin = getBuildConfig().pin_unlock ? await vaultPinStatus().catch(() => null) : null;
      if (pin?.enrolled) {
        pinDigits.value = pin.digits;
        gateMode.value = "pin";
      } else {
        gateMode.value = "unlock";
      }
    } else await runLoaders();
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

// Which nav entries exist: `isTabVisible` (src/tabs.ts) ANDs the compile-time
// build gate with the user's Settings → Tabs choice, and is a live read of a ref
// so ticking a checkbox re-renders both lists below. App.vue never remounts, so
// sampling it into a const here — the way the build flags used to be — would
// freeze the nav at whatever the profile had at unlock.
//
// This gates the LINKS only. The composables behind them stay wired app-wide
// (stores/chat.ts): hiding Calendar must not stop meeting reminders, and hiding
// Contacts must not stop the invite ALPN from being accepted.
//
// Files tab attention dot: an incoming file offer is waiting for accept/decline.
const fileShare = chatStore.fileShare;
// Calls / Contacts / Calendar (compile-time gated — pland.md): each is null in
// an edition without the feature, so every consumer below is null-guarded.
const vox = chatStore.vox;
const invites = chatStore.invites;
// Calendar tab attention dot: meeting invites awaiting an RSVP.
const meetings = chatStore.meetings;

// Close menu on navigation
watch(() => route.path, () => {
  menuOpen.value = false;
});

onBeforeUnmount(() => {
  idleLock.value?.stop();
  idleLock.value = null;
  hideLock?.stop();
  hideLock = null;
  unlistenLocked?.();
  unlistenLocked = null;
});
</script>

<template>
  <div
    class="flex h-[100dvh] flex-col overflow-hidden font-sans transition-colors duration-300 bg-primary-bg-light text-text-main-light dark:bg-primary-bg-dark dark:text-text-main-dark"
  >
    <!-- The shell is a fixed-height column measured against the DYNAMIC viewport
         (100dvh): on Android the URL bar / gesture area shrinks the visible area,
         and 100vh would leave the footer permanently below the fold. Nothing
         scrolls here — <main> below is the app's one scroll container. -->
    <!-- Encryption-at-rest gate: blocks everything until unlocked (non-dismissable) -->
    <div
      v-if="gateMode !== 'ready'"
      class="fixed inset-0 z-[80] flex items-center justify-center bg-primary-bg-light p-6 dark:bg-primary-bg-dark"
    >
      <div class="w-full max-w-sm space-y-5">
        <div class="space-y-2 text-center">
          <img :src="appIcon" :alt="brand.name" class="mx-auto h-28 w-28 rounded-2xl object-contain sm:h-32 sm:w-32" />
          <h1 class="text-2xl font-bold">{{ brand.name }}</h1>
          <p v-if="gateMode !== 'loading'" class="text-sm opacity-70">
            {{ gateMode === 'setup'
              ? $t('vault.setupHint')
              : gateMode === 'pin'
                ? $t('vault.pinHint')
                : $t('vault.unlockHint') }}
          </p>
        </div>

        <p v-if="gateMode === 'loading'" class="text-center opacity-60">…</p>

        <!-- PIN keypad: in-session re-unlock. The passphrase escape is always
             one click away, and is where an exhausted PIN lands. -->
        <div v-else-if="gateMode === 'pin'" class="space-y-5">
          <PinPad
            :digits="pinDigits"
            :busy="gateBusy"
            :error="gateError"
            @submit="doPinUnlock"
          />
          <button
            type="button"
            class="mx-auto block text-xs font-semibold opacity-60 hover:opacity-100"
            data-testid="gate-use-passphrase"
            @click="gateMode = 'unlock'; gateError = ''"
          >
            {{ $t('vault.usePassphrase') }}
          </button>
        </div>

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

        <!-- Logo → the welcome page (app info, your name, your HP meters).
             Deliberately not "/": that redirect is the lock cycle's re-entry
             point and must keep landing on a working tab. -->
        <RouterLink to="/welcome" class="flex items-center gap-3 hover:opacity-80 transition">
          <img :src="barIcon" alt="Enigma26 icon" class="h-9 w-9 rounded-lg object-contain" />
          <h1 class="text-xl font-bold tracking-wide sm:text-2xl">{{ brand.name }}</h1>
        </RouterLink>

        <!-- Desktop nav -->
        <nav class="hidden lg:flex items-center gap-x-4 gap-y-2 text-sm flex-wrap">
          <RouterLink v-if="isTabVisible('chat')" to="/chat" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.chat')">
            <font-awesome-icon icon="comments" />
            {{ $t('nav.chat') }}
          </RouterLink>
          <RouterLink v-if="isTabVisible('files')" to="/files" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.files')">
            <font-awesome-icon icon="file-arrow-up" />
            {{ $t('nav.files') }}
            <span
              v-if="fileShare.state.value === 'incoming'"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('fileShare.wantsToSend')"
            />
          </RouterLink>
          <RouterLink v-if="isTabVisible('vox')" to="/vox" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.calls')">
            <font-awesome-icon icon="phone" />
            {{ $t('nav.calls') }}
            <span
              v-if="vox?.phase.value === 'incoming'"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('vox.incomingTitle')"
            />
          </RouterLink>
          <RouterLink v-if="isTabVisible('calendar')" to="/calendar" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.calendar')">
            <font-awesome-icon icon="calendar" />
            {{ $t('nav.calendar') }}
            <span
              v-if="(meetings?.attentionCount.value ?? 0) > 0"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('calendar.attentionTitle')"
            />
          </RouterLink>
          <RouterLink v-if="isTabVisible('map')" to="/map" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.map')">
            <font-awesome-icon icon="map" />
            {{ $t('nav.map') }}
          </RouterLink>
          <RouterLink v-if="isTabVisible('contacts')" to="/contacts" class="relative inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.contacts')">
            <font-awesome-icon icon="address-book" />
            {{ $t('nav.contacts') }}
            <span
              v-if="invites?.incoming.value"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
              :title="$t('contacts.incomingTitle')"
            />
          </RouterLink>
          <RouterLink v-if="isTabVisible('privacy')" to="/privacy" class="inline-flex items-center gap-2 transition hover:opacity-70" :title="$t('nav.privacy')">
            <font-awesome-icon icon="shield-halved" />
            {{ $t('nav.privacy') }}
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

          <!-- Privacy HP, always in view: today's balance and this week's. -->
          <HpChip />
        </nav>

        <!-- Mobile: HP chip + hamburger. The chip sheds its weekly figure below
             `sm` (HpChip), so it stays a two-glyph badge on a narrow phone. -->
        <div class="flex items-center gap-3 lg:hidden">
          <HpChip />
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
          <RouterLink v-if="isTabVisible('chat')" to="/chat" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="comments" class="w-4 text-center" />
            {{ $t('nav.chat') }}
          </RouterLink>
          <RouterLink v-if="isTabVisible('files')" to="/files" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="file-arrow-up" class="w-4 text-center" />
            {{ $t('nav.files') }}
            <span
              v-if="fileShare.state.value === 'incoming'"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
          </RouterLink>
          <RouterLink v-if="isTabVisible('vox')" to="/vox" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="phone" class="w-4 text-center" />
            {{ $t('nav.calls') }}
            <span
              v-if="vox?.phase.value === 'incoming'"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
          </RouterLink>
          <RouterLink v-if="isTabVisible('calendar')" to="/calendar" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="calendar" class="w-4 text-center" />
            {{ $t('nav.calendar') }}
            <span
              v-if="(meetings?.attentionCount.value ?? 0) > 0"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
          </RouterLink>
          <RouterLink v-if="isTabVisible('map')" to="/map" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="map" class="w-4 text-center" />
            {{ $t('nav.map') }}
          </RouterLink>
          <RouterLink v-if="isTabVisible('contacts')" to="/contacts" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="address-book" class="w-4 text-center" />
            {{ $t('nav.contacts') }}
            <span
              v-if="invites?.incoming.value"
              class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
            />
          </RouterLink>
          <RouterLink v-if="isTabVisible('privacy')" to="/privacy" class="flex items-center gap-3 px-5 py-3.5 text-sm hover:opacity-70 transition">
            <font-awesome-icon icon="shield-halved" class="w-4 text-center" />
            {{ $t('nav.privacy') }}
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

    <!-- Main — THE scroll container of the app: every routed view that outgrows
         the pane scrolls here, between the sticky header and the footer.
         `min-h-0` is load-bearing: a flex child's automatic minimum size is its
         content, so without it <main> refuses to shrink, grows past the shell
         and `overflow-y-auto` never fires. Views that own their own scrolling
         (chat log, map) simply fill it with `h-full` and never overflow. -->
    <main class="flex min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
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

    <!-- Pre-lock countdown: any activity dismisses it (the window-level activity
         listeners fire first and clear the watcher's warned flag) -->
    <IdleLockWarning
      v-if="lockWarn && idleLock"
      :handle="idleLock"
      @close="lockWarn = false"
    />

    <!-- Privacy HP: the post-activation flash ("−10 HP · DHT presence enabled")
         and the confirmation that only high/severe prices raise. Both live at
         app level so a charge fired from a modal still reports itself after that
         modal has closed. -->
    <HpFlash />
    <HpConfirmModal />
    </template>
  </div>
</template>
