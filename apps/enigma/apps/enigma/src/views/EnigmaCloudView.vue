<script setup lang="ts">
// Cloud tab — the single home for everything that talks to the user's own
// faros server. Three sub-tabs: Files (CloudPanel, moved from the Files tab),
// Invites (CloudInvitesPanel, moved from Contacts) and Connection — the
// settings half: the runtime master switch, server URL, login, transport badge
// and route-through-Tor (CloudSetupCard).
//
// The tab itself is compile-time gated (cloud.allow_connections, router guard);
// the KNOB gates the content. Off ⇒ Connection is the only sub-tab, holding
// just the switch and an explanation, and Rust refuses every cloud/beacon/aster
// request app-wide — zero bytes to the server. Turning it ON is a conscious
// act: a danger-style confirm modal lists what the server will see and the
// per-transport risks BEFORE the kv flag is written. Turning it off is instant
// and aborts in-flight transfers.
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { OyaCard, OyaModal } from "rakotis";
import { useCloudStore } from "../stores/cloud";
import CloudSetupCard from "../components/cloud/CloudSetupCard.vue";
import CloudPanel from "../components/cloud/CloudPanel.vue";
import CloudInvitesPanel from "../components/cloud/CloudInvitesPanel.vue";

defineProps<{ darkMode?: boolean }>();

const route = useRoute();
const cloud = useCloudStore();

// ── Sub-tabs (Notes pill pattern) ─────────────────────────────────────────────
const ORDER = ["files", "invites", "connection"] as const;
type CloudTab = (typeof ORDER)[number];
const TAB_META: Record<CloudTab, { icon: string; label: string }> = {
  files: { icon: "folder", label: "cloud.filesTab" },
  invites: { icon: "paper-plane", label: "cloud.invitesTab" },
  connection: { icon: "server", label: "cloud.connectionTab" },
};

// With the switch off, Connection is the whole tab: Files and Invites have
// nothing behind them and their pills would be dead ends.
const visibleTabs = computed<readonly CloudTab[]>(() =>
  cloud.enabled ? ORDER : (["connection"] as const),
);

function tabFromQuery(q: unknown): CloudTab {
  return typeof q === "string" && (ORDER as readonly string[]).includes(q)
    ? (q as CloudTab)
    : "files";
}
const activeTab = ref<CloudTab>(tabFromQuery(route.query.tab));
// An explicit ?tab= (or a click) pins the choice, so the logged-out landing
// rule below never overrides what the user actually asked for.
let tabPinned = typeof route.query.tab === "string";
watch(() => route.query.tab, (tab) => {
  activeTab.value = tabFromQuery(tab);
  tabPinned = true;
});

function selectTab(tab: CloudTab) {
  activeTab.value = tab;
  tabPinned = true;
}

/** What actually renders — a stale Files/Invites selection can't survive the
 *  switch going off, since those sub-tabs no longer exist. */
const effectiveTab = computed<CloudTab>(() =>
  cloud.enabled ? activeTab.value : "connection",
);

/** Without a session, Files and Invites have nothing to show and no way to get
 *  one — land on Connection, where the server URL and login live. */
function landOnConnectionIfSignedOut() {
  if (!tabPinned && !cloud.loggedIn) activeTab.value = "connection";
}

// ── Master knob (conscious enable — modal first, then the kv write) ───────────
const showEnableConfirm = ref(false);
const knobBusy = ref(false);
// A failed flip (e.g. the vault locked, so the kv write errors) is a
// recoverable condition — surface it under the knob instead of letting the
// rejection escalate to the global fatal overlay.
const knobError = ref("");

function asMessage(e: unknown): string {
  return typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
}

function onKnobClick() {
  if (knobBusy.value) return;
  knobError.value = "";
  if (cloud.enabled) {
    // Off is instant — no ceremony to STOP talking to a server.
    knobBusy.value = true;
    cloud
      .setEnabled(false)
      .catch((e) => { knobError.value = asMessage(e); })
      .finally(() => { knobBusy.value = false; });
  } else {
    showEnableConfirm.value = true;
  }
}

async function confirmEnable() {
  if (knobBusy.value) return;
  knobBusy.value = true;
  knobError.value = "";
  try {
    await cloud.setEnabled(true);
    showEnableConfirm.value = false;
    // The knob lives in Connection, so the user is already looking at it —
    // stay put instead of yanking them to Files the instant it flips on.
    selectTab("connection");
  } catch (e) {
    knobError.value = asMessage(e);
    showEnableConfirm.value = false;
  } finally {
    knobBusy.value = false;
  }
}

onMounted(async () => {
  await cloud.init();
  landOnConnectionIfSignedOut();
});
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-4 overflow-y-auto">
    <header class="mx-auto w-full max-w-2xl">
      <h1 class="flex items-center gap-3 text-2xl font-bold">
        <font-awesome-icon icon="cloud" />
        {{ $t('cloud.title') }}
      </h1>
      <p class="mt-1 text-sm opacity-70">{{ $t('cloud.subtitle') }}</p>
    </header>

    <!-- Sub-tab bar. Off ⇒ Connection is the only pill (Files and Invites
         would be dead ends), so it doubles as the switch's home. -->
    <div
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex gap-1 rounded-xl border p-1 text-sm font-semibold"
    >
      <button
        v-for="tab in visibleTabs"
        :key="tab"
        type="button"
        :class="effectiveTab === tab
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        :data-testid="`cloud-tab-${tab}`"
        @click="selectTab(tab)"
      >
        <font-awesome-icon :icon="TAB_META[tab].icon" />{{ $t(TAB_META[tab].label) }}
      </button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col">
      <CloudPanel v-if="effectiveTab === 'files'" />
      <CloudInvitesPanel v-else-if="effectiveTab === 'invites'" :dark-mode="darkMode" />

      <!-- Connection: the master switch, then (once on) server URL, login,
           transport badge and route-through-Tor. -->
      <div v-else class="mx-auto w-full max-w-2xl space-y-4">
        <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-3">
          <div class="flex items-center gap-3">
            <font-awesome-icon
              icon="cloud"
              :class="cloud.enabled ? 'text-accent-dark' : 'opacity-60'"
              class="shrink-0"
            />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold">{{ $t('cloud.enableTitle') }}</p>
              <p class="text-xs opacity-60">
                {{ cloud.enabled ? $t('cloud.enableHintOn') : $t('cloud.enableHintOff') }}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="cloud.enabled"
              :aria-label="$t('cloud.enableTitle')"
              data-testid="cloud-knob"
              :class="cloud.enabled ? 'bg-accent-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
              class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
              @click="onKnobClick"
            >
              <span
                :class="cloud.enabled ? 'translate-x-6' : 'translate-x-1'"
                class="inline-block h-4 w-4 transform rounded-full bg-white transition"
              />
            </button>
          </div>
          <p v-if="knobError" class="text-xs text-warn-dark" data-testid="cloud-knob-error">
            {{ knobError }}
          </p>

          <!-- OFF: the explanation is all there is -->
          <template v-if="!cloud.enabled">
            <div class="space-y-3 border-t border-current/10 pt-3" data-testid="cloud-off-card">
              <p class="text-sm opacity-70">{{ $t('cloud.offExplanation') }}</p>
              <div class="rounded-lg border border-warn-dark/30 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark">
                {{ $t('cloud.offNotice') }}
              </div>
            </div>
          </template>
        </OyaCard>

        <CloudSetupCard v-if="cloud.enabled" :dark-mode="darkMode" />
      </div>
    </div>

    <!-- Conscious-enable confirm: the full risk list BEFORE any kv write -->
    <OyaModal :open="showEnableConfirm" @close="showEnableConfirm = false">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('cloud.confirmTitle') }}
        </p>
        <p class="text-sm opacity-80">{{ $t('cloud.confirmIntro') }}</p>
        <ul class="list-disc space-y-1 pl-5 text-sm opacity-80">
          <li>{{ $t('cloud.confirmMeta1') }}</li>
          <li>{{ $t('cloud.confirmMeta2') }}</li>
          <li>{{ $t('cloud.confirmMeta3') }}</li>
        </ul>
        <p class="text-sm opacity-80">{{ $t('cloud.confirmTransport') }}</p>
        <ul class="list-disc space-y-1 pl-5 text-sm opacity-80">
          <li>{{ $t('cloud.confirmClearnet') }}</li>
          <li>{{ $t('cloud.confirmTor') }}</li>
          <li>{{ $t('cloud.confirmOnion') }}</li>
        </ul>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="showEnableConfirm = false"
        >
          {{ $t('common.cancel') }}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border border-warn-dark/50 px-4 py-2 text-sm font-semibold text-warn-dark transition hover:bg-warn-dark/10"
          data-testid="cloud-enable-confirm"
          @click="confirmEnable"
        >
          <font-awesome-icon :icon="knobBusy ? 'spinner' : 'cloud'" :spin="knobBusy" />
          {{ $t('cloud.confirmEnable') }}
        </button>
      </template>
    </OyaModal>
  </div>
</template>
