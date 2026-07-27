<script setup lang="ts">
// Cloud tab — the single home for everything that talks to the user's own
// faros server. Three sub-tabs: Files (CloudPanel, moved from the Files tab),
// Invites (CloudInvitesPanel, moved from Contacts) and Connection — the
// settings half: the runtime master switch, server URL, login, transport badge
// and route-through-Tor (CloudSetupCard).
//
// The tab itself is compile-time gated (cloud.allow_connections, router guard);
// the runtime master switch gates the content. It lives in Settings →
// Connections (CloudEnableCard, beside the other network toggles) — off ⇒
// Connection is the only sub-tab here, explaining what Cloud is and pointing
// there, while Rust refuses every cloud/beacon/aster request app-wide.
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { OyaCard } from "rakotis";
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

onMounted(async () => {
  await cloud.init();
  // Airplane mode has no event to subscribe to, so every entry to the tab
  // re-reads it. Entering the tab is a press, so this stays D6-clean.
  await cloud.syncOffline();
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

      <!-- Connection: server URL, login, transport badge, route-through-Tor.
           The master switch itself lives in Settings → Connections. -->
      <div v-else class="mx-auto w-full max-w-2xl space-y-4">
        <CloudSetupCard v-if="cloud.enabled" :dark-mode="darkMode" />
        <OyaCard v-else :dark-mode="darkMode" :padded="true" class="space-y-3" data-testid="cloud-off-card">
          <p class="text-sm opacity-70">{{ $t('cloud.offExplanation') }}</p>
          <div class="rounded-lg border border-warn-dark/30 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark">
            {{ $t('cloud.offNotice') }}
          </div>
          <p class="text-sm opacity-70">{{ $t('cloud.offPointer') }}</p>
          <RouterLink
            to="/config?tab=connections"
            class="inline-flex items-center gap-2 text-sm font-semibold text-accent-light transition hover:opacity-70 dark:text-accent-dark"
            data-testid="cloud-settings-link"
          >
            <font-awesome-icon icon="gear" />
            {{ $t('nav.connections') }}
            <font-awesome-icon icon="chevron-right" class="text-xs opacity-60" />
          </RouterLink>
        </OyaCard>
      </div>
    </div>
  </div>
</template>
