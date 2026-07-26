<script setup lang="ts">
// Files → Devices → Files: the shared list of allowed files and the two
// buttons that move them. NOTHING happens on its own — the user checks entries
// and presses Push or Pull, and that press is the consent for replacing the
// destination copy. Files whose bytes already match on the other side are
// skipped rather than re-sent.
//
// The list itself is shared (it replicates over the devlink room), but each
// device's local path is its own business and never leaves the device.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaCard, OyaEmptyState, isTauri, getOffline, getUseTor } from "rakotis";
import { useFileSyncStore } from "../../stores/fileSync";
import type { SyncedFileEntry } from "rakotis";

const { t } = useI18n({ useScope: "global" });
const store = useFileSyncStore();

// Disabled-with-reason, never hidden (the pairing panel's convention).
const offline = ref(false);
const torMode = ref(false);

const blockedReason = computed(() => {
  if (!isTauri()) return t("fsync.desktopOnly");
  if (offline.value) return t("devices.blockedOffline");
  if (torMode.value) return t("devices.blockedTor");
  if (!store.linked) return t("fsync.notLinked");
  if (!store.online) return t("fsync.peerOffline");
  return "";
});

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** The size we can show: our own copy if we have it, else what a sibling claims. */
function entrySize(entry: SyncedFileEntry): number {
  const mine = store.localRecord(entry.id);
  if (mine) return mine.size;
  const sib = store.siblingIds.map((id) => entry.copies[id]).find(Boolean);
  return sib?.size ?? 0;
}

const STATE_KEYS: Record<string, string> = {
  synced: "fsync.stateSynced",
  differs: "fsync.stateDiffers",
  "local-only": "fsync.stateLocalOnly",
  "remote-only": "fsync.stateRemoteOnly",
  missing: "fsync.stateMissing",
};

const OUTCOME_KEYS: Record<string, string> = {
  working: "fsync.outcomeWorking",
  sent: "fsync.outcomeSent",
  received: "fsync.outcomeReceived",
  skipped: "fsync.outcomeSkipped",
  missing: "fsync.outcomeMissing",
  "too-large": "fsync.outcomeTooLarge",
  failed: "fsync.outcomeFailed",
  unavailable: "fsync.outcomeUnavailable",
};

onMounted(async () => {
  offline.value = await getOffline().catch(() => false);
  torMode.value = await getUseTor().catch(() => false);
  await store.init();
});
</script>

<template>
  <OyaCard :padded="true" class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ t('fsync.title') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ t('fsync.hint') }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <OyaButton variant="secondary" :disabled="!isTauri()" data-testid="fsync-add" @click="store.addFile()">
          <font-awesome-icon icon="plus" />{{ t('fsync.addFile') }}
        </OyaButton>
        <OyaButton variant="secondary" :disabled="!isTauri()" @click="store.openFolder()">
          <font-awesome-icon icon="folder-open" />{{ t('fsync.openFolder') }}
        </OyaButton>
      </div>
    </div>

    <p v-if="blockedReason" class="text-sm font-semibold text-amber-500" data-testid="fsync-blocked">
      {{ blockedReason }}
    </p>
    <p v-if="store.lastError" class="text-sm font-semibold text-red-500">
      {{ store.lastError === 'full' ? t('fsync.listFull') : store.lastError }}
    </p>

    <OyaEmptyState v-if="!store.entries.length" icon="file-arrow-up" class="py-8">
      {{ t('fsync.empty') }}
    </OyaEmptyState>

    <template v-else>
      <!-- Select all + the two transfer buttons -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-accent-2 pb-2 dark:border-accent-1">
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="h-4 w-4 accent-accent-light dark:accent-accent-dark"
            data-testid="fsync-select-all"
            :checked="store.allSelected"
            @change="store.selectAll()"
          />
          {{ t('fsync.selectAll') }}
          <span class="text-xs opacity-60">({{ store.selection.size }}/{{ store.entries.length }})</span>
        </label>
        <div class="flex flex-wrap gap-2">
          <OyaButton
            :disabled="!store.canTransfer || !store.selection.size"
            data-testid="fsync-push"
            @click="store.pushSelected()"
          >
            <font-awesome-icon icon="arrow-up" />{{ t('fsync.push') }}
          </OyaButton>
          <OyaButton
            :disabled="!store.canTransfer || !store.selection.size"
            data-testid="fsync-pull"
            @click="store.pullSelected()"
          >
            <font-awesome-icon icon="arrow-down" />{{ t('fsync.pull') }}
          </OyaButton>
        </div>
      </div>

      <ul class="space-y-2">
        <li
          v-for="entry in store.entries"
          :key="entry.id"
          class="flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
        >
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 accent-accent-light dark:accent-accent-dark"
            :data-testid="`fsync-check-${entry.id}`"
            :checked="store.selection.has(entry.id)"
            @change="store.toggle(entry.id)"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ entry.name }}</p>
            <p class="truncate text-xs opacity-60">
              {{ fmtSize(entrySize(entry)) }} · {{ t(STATE_KEYS[store.entryState(entry)]) }}
              <template v-if="store.items.get(entry.id)">
                ·
                <span :class="store.items.get(entry.id)!.status === 'failed' ? 'text-red-500' : ''">
                  {{ t(OUTCOME_KEYS[store.items.get(entry.id)!.status] ?? 'fsync.outcomeWorking') }}
                </span>
                <template v-if="store.items.get(entry.id)!.total">
                  ({{ fmtSize(store.items.get(entry.id)!.transferred) }} /
                  {{ fmtSize(store.items.get(entry.id)!.total) }})
                </template>
              </template>
            </p>
          </div>
          <OyaButton variant="secondary" :data-testid="`fsync-remove-${entry.id}`" @click="store.removeEntry(entry.id)">
            <font-awesome-icon icon="trash" />
          </OyaButton>
        </li>
      </ul>
    </template>
  </OyaCard>
</template>
