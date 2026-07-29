<script setup lang="ts">
// The saved-servers list on the Cloud → Connection sub-tab. Exactly one entry
// is active; picking another switches everything the app does with the server
// (files, invites, location shares, the Local tab's upload target) because they
// all read `cloud.serverUrl` from the store.
//
// Switching sends ZERO bytes: it writes kv and re-reads `cloud_status`, which is
// a local read — the other server's session comes back from its own encrypted
// kv scope. In-flight transfers are deliberately left running (see the store's
// `switchTo`), so a row can belong to a connection that is no longer on screen.
import { computed, ref } from "vue";
import { OyaCard, OyaIconButton, OyaModal, OyaButton, type CloudServerEntry } from "rakotis";
import { useCloudStore } from "../../stores/cloud";
import CloudConnectionModal from "./CloudConnectionModal.vue";

defineProps<{ darkMode?: boolean }>();

const cloud = useCloudStore();

const showEditor = ref(false);
const editing = ref<CloudServerEntry | null>(null);
const removing = ref<CloudServerEntry | null>(null);
const busy = ref(false);
const error = ref("");

/** Removing the last entry would leave nothing active, so the button is
 *  disabled with the reason (house style) — rakotis throws as the backstop. */
const onlyOne = computed(() => cloud.servers.length <= 1);

function openAdd() {
  editing.value = null;
  showEditor.value = true;
}

function openEdit(entry: CloudServerEntry) {
  editing.value = entry;
  showEditor.value = true;
}

async function pick(entry: CloudServerEntry) {
  if (entry.id === cloud.activeId || cloud.switching) return;
  error.value = "";
  try {
    await cloud.switchTo(entry.id);
  } catch (e) {
    // Recoverable (a locked vault fails the kv write) — show it here rather
    // than escalating to the global fatal overlay, the toggleForceTor precedent.
    error.value = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
  }
}

async function confirmRemove() {
  const entry = removing.value;
  if (!entry || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    // The store clears the saved session FIRST: `cloud:auth` is scoped by URL
    // and nothing can enumerate kv scopes, so dropping the entry first would
    // orphan the bearer token where no future version could ever find it.
    await cloud.removeServer(entry.id);
    removing.value = null;
  } catch (e) {
    error.value = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
  } finally {
    busy.value = false;
  }
}

/** Only says something when a capability is KNOWN absent — unknown stays quiet,
 *  because assuming a server is limited before asking would be a guess. */
function vaultOnly(entry: CloudServerEntry): boolean {
  return entry.id === cloud.activeId && cloud.caps !== null && !cloud.hasAster && !cloud.hasBeacon;
}
</script>

<template>
  <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-3">
    <div class="flex items-center gap-3">
      <font-awesome-icon icon="server" class="shrink-0 opacity-60" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">{{ $t('cloud.connections') }}</p>
        <p class="text-xs opacity-60">{{ $t('cloud.connectionsHint') }}</p>
      </div>
    </div>

    <p
      v-if="cloud.registryUnreadable"
      class="rounded-lg border border-warn-dark/30 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark"
      data-testid="cloud-connections-unreadable"
    >
      {{ $t('cloud.connectionUnreadable') }}
    </p>

    <ul v-else class="space-y-1" data-testid="cloud-connection-list">
      <li v-for="entry in cloud.servers" :key="entry.id">
        <div
          :class="[
            entry.id === cloud.activeId
              ? (darkMode ? 'border-accent-dark' : 'border-accent-light')
              : (darkMode ? 'border-accent-1' : 'border-accent-2'),
            cloud.switching ? 'opacity-60' : '',
          ]"
          class="flex items-center gap-2 rounded-lg border px-3 py-2"
          :data-testid="`cloud-connection-${entry.id}`"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            :aria-current="entry.id === cloud.activeId"
            :aria-label="$t('cloud.connectionSwitch')"
            :disabled="cloud.switching"
            @click="pick(entry)"
          >
            <font-awesome-icon
              :icon="entry.id === cloud.activeId ? 'circle-dot' : 'circle'"
              :class="entry.id === cloud.activeId ? 'text-accent-dark' : 'opacity-40'"
              class="shrink-0"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold">{{ entry.name }}</span>
              <span class="block truncate text-xs opacity-60">{{ entry.url }}</span>
              <span
                v-if="entry.id === cloud.activeId"
                class="block truncate text-xs opacity-60"
                data-testid="cloud-connection-session"
              >
                {{ cloud.loggedIn
                  ? $t('cloud.connectionSignedInAs', { name: cloud.username })
                  : $t('cloud.connectionSignedOut') }}
              </span>
              <span
                v-if="vaultOnly(entry)"
                class="block truncate text-xs opacity-60"
                data-testid="cloud-connection-vault-only"
              >
                {{ $t('cloud.connectionVaultOnly') }}
              </span>
            </span>
          </button>
          <OyaIconButton
            size="sm"
            icon="pen"
            :label="$t('cloud.connectionEdit')"
            @click="openEdit(entry)"
          />
          <OyaIconButton
            size="sm"
            icon="trash"
            :label="onlyOne ? $t('cloud.connectionRemoveOnly') : $t('cloud.connectionRemove')"
            :class="onlyOne ? 'cursor-not-allowed opacity-40' : ''"
            :data-testid="`cloud-connection-delete-${entry.id}`"
            @click="onlyOne ? undefined : (removing = entry)"
          />
        </div>
      </li>
    </ul>

    <div class="flex items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-2 text-sm font-semibold text-accent-light transition hover:opacity-70 dark:text-accent-dark"
        data-testid="cloud-connection-add"
        @click="openAdd"
      >
        <font-awesome-icon icon="plus" />{{ $t('cloud.connectionAdd') }}
      </button>
      <span class="flex-1" />
      <!-- The only way to refresh capabilities on demand. Deliberately a press:
           nothing re-checks them on a timer (cloud.md D6). -->
      <button
        v-if="cloud.loggedIn && cloud.enabled"
        type="button"
        class="text-xs opacity-60 transition hover:opacity-100"
        data-testid="cloud-caps-recheck"
        @click="cloud.fetchCaps()"
      >
        <font-awesome-icon icon="rotate" />
      </button>
    </div>

    <p v-if="error" class="text-xs text-warn-dark" data-testid="cloud-connection-list-error">{{ error }}</p>

    <CloudConnectionModal v-model:open="showEditor" :entry="editing" />

    <!-- Danger confirm, the CloudEnableCard pattern. The wording is blunt on
         purpose: a bearer-only logout does NOT revoke the token server-side, so
         removing it here is the only revocation the user actually gets. -->
    <OyaModal :open="!!removing" @close="removing = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('cloud.connectionRemoveTitle', { name: removing?.name ?? '' }) }}
        </p>
        <p class="text-sm opacity-80">{{ $t('cloud.connectionRemoveBody') }}</p>
        <p v-if="error" class="text-sm text-warn-dark">{{ error }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="removing = null">
            {{ $t('common.cancel') }}
          </OyaButton>
          <OyaButton
            :class="{ 'pointer-events-none opacity-60': busy }"
            data-testid="cloud-connection-remove-confirm"
            @click="confirmRemove"
          >
            <font-awesome-icon :icon="busy ? 'spinner' : 'trash'" :spin="busy" />
            {{ $t('cloud.connectionRemove') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>
  </OyaCard>
</template>
