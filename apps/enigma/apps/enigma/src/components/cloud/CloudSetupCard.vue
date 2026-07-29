<script setup lang="ts">
// Cloud tab setup/status card: server URL (moved here from Settings — the Cloud
// tab is the single home for everything server-related), login state, the live
// transport badge, and the "route through Tor" knob. Only rendered when the
// master switch is on (EnigmaCloudView gates it).
import { ref, computed } from "vue";
import { OyaCard, OyaIconButton } from "rakotis";
import { useCloudStore } from "../../stores/cloud";
import CloudLoginModal from "./CloudLoginModal.vue";
import CloudConnectionList from "./CloudConnectionList.vue";

defineProps<{ darkMode?: boolean }>();

const cloud = useCloudStore();
const showLogin = ref(false);

// The single server-URL input moved into CloudConnectionList: the address is now
// a property of a named connection rather than a global setting. Everything
// below still applies to whichever connection is active, and says so.
const activeName = computed(() => cloud.activeServer?.name ?? "");

async function doLogout() {
  await cloud.logout();
}

// ── Transport badge ───────────────────────────────────────────────────────────
// "loopback" renders as Local; the force-Tor knob is inert for onion (always
// Tor) and loopback (never Tor) hosts — disabled with the reason, house style.
const transportMeta = computed(() => {
  switch (cloud.transport) {
    case "onion":
      return { label: "cloud.transportOnion", notice: "cloud.noticeOnion", dot: "bg-success-dark", warn: false };
    case "tor":
      return { label: "cloud.transportTor", notice: "cloud.noticeTor", dot: "bg-success-dark", warn: false };
    case "loopback":
      return { label: "cloud.transportLocal", notice: "cloud.noticeLocal", dot: "bg-accent-dark", warn: false };
    default:
      return { label: "cloud.transportClearnet", notice: "cloud.noticeClearnet", dot: "bg-warn-dark", warn: true };
  }
});
const forceTorLocked = computed(() => cloud.transport === "onion" || cloud.transport === "loopback");
const forceTorBusy = ref(false);
async function toggleForceTor() {
  if (forceTorLocked.value || forceTorBusy.value) return;
  forceTorBusy.value = true;
  try {
    await cloud.setForceTor(!cloud.forceTor);
  } catch (e) {
    // Recoverable (e.g. vault locked mid-flip) — show it in the card's error
    // slot rather than escalating to the global fatal overlay.
    cloud.error = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
  } finally {
    forceTorBusy.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- Saved connections: pick one, add, edit, remove. -->
    <CloudConnectionList :dark-mode="darkMode" />

    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
    <!-- Everything below belongs to the ACTIVE connection — named, so there is
         never a doubt which server Log in targets. -->
    <div class="flex items-center gap-3">
      <font-awesome-icon icon="server" class="shrink-0 opacity-60" />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold" data-testid="cloud-active-name">{{ activeName }}</p>
        <p class="truncate text-xs opacity-60" data-testid="cloud-server-url">{{ cloud.serverUrl }}</p>
      </div>
    </div>

    <!-- Login state -->
    <div class="flex items-center gap-2 border-t border-current/10 pt-3">
      <template v-if="cloud.loggedIn">
        <span
          class="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-accent-2 px-2.5 py-1 text-xs font-semibold dark:border-accent-1"
        >
          <font-awesome-icon icon="user" class="opacity-60" />
          <span class="truncate">{{ cloud.username }}</span>
        </span>
        <OyaIconButton
          size="sm"
          icon="right-from-bracket"
          :label="$t('cloud.logout')"
          @click="doLogout"
        />
      </template>
      <template v-else>
        <p class="min-w-0 flex-1 text-sm opacity-70">{{ $t('cloud.notLoggedIn') }}</p>
        <button
          class="rounded-lg bg-accent-light px-4 py-2 text-sm font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
          data-testid="cloud-login-button"
          @click="showLogin = true"
        >
          <font-awesome-icon icon="right-to-bracket" /> {{ $t('cloud.loginPrompt') }}
        </button>
      </template>
    </div>
    <p class="text-xs opacity-60">
      {{ $t('cloud.registerExternalHint', { url: `${cloud.serverUrl}/sso/` }) }}
    </p>
    <p v-if="cloud.error" class="text-xs text-warn-dark">{{ cloud.error }}</p>

    <!-- Transport badge + per-transport notice -->
    <div class="flex items-center gap-2 border-t border-current/10 pt-3 text-sm" data-testid="cloud-transport">
      <span :class="transportMeta.dot" class="inline-block h-2 w-2 shrink-0 rounded-full" />
      <span class="font-semibold">{{ $t('cloud.transport') }}:</span>
      <span>{{ $t(transportMeta.label) }}</span>
    </div>
    <p
      v-if="transportMeta.warn"
      class="rounded-lg border border-warn-dark/30 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark"
    >
      {{ $t(transportMeta.notice) }}
    </p>
    <p v-else class="text-xs opacity-60">{{ $t(transportMeta.notice) }}</p>

    <!-- Route through Tor -->
    <div class="flex items-center gap-3 border-t border-current/10 pt-3">
      <font-awesome-icon
        icon="shield-halved"
        :class="cloud.forceTor ? 'text-accent-dark' : 'opacity-60'"
        class="shrink-0"
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">{{ $t('cloud.forceTor') }}</p>
        <p class="text-xs opacity-60">
          {{ forceTorLocked
            ? (cloud.transport === 'onion' ? $t('cloud.forceTorOnion') : $t('cloud.forceTorLocal'))
            : $t('cloud.forceTorHint') }}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="cloud.forceTor"
        :aria-label="$t('cloud.forceTor')"
        :disabled="forceTorLocked"
        data-testid="cloud-force-tor"
        :class="[
          cloud.forceTor ? 'bg-accent-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2',
          forceTorLocked ? 'cursor-not-allowed opacity-40' : '',
        ]"
        class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
        @click="toggleForceTor"
      >
        <span
          :class="cloud.forceTor ? 'translate-x-6' : 'translate-x-1'"
          class="inline-block h-4 w-4 transform rounded-full bg-white transition"
        />
      </button>
    </div>

    <CloudLoginModal v-model:open="showLogin" />
    </OyaCard>
  </div>
</template>
