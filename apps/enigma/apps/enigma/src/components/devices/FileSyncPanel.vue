<script setup lang="ts">
// Files → Devices → Files: the enigma-folder tree and the two buttons that
// move files. NOTHING happens on its own — the user checks files and presses
// Push or Pull, an unsolicited incoming push waits in the consent card until
// accepted, and a hash-diverged ("changed") file can only be resolved by
// pulling the version you want; push refuses it.
//
// Two kinds of buckets, both rendered by FileTree from flat DFS rows:
//   · This device — everything inside the enigma folder (scan), plus ghost
//     rows for shared files with no bytes here yet. Selectable.
//   · One bucket per linked sibling — names only (their paths are their own
//     business), markers relative to this device.
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaCard, OyaEmptyState, isTauri } from "rakotis";
import { useNetworkStore } from "../../stores/network";
import { useFileSyncStore, type BucketFile } from "../../stores/fileSync";
import FileTree from "./FileTree.vue";
import { buildTree } from "./treeBuilder";

const { t } = useI18n({ useScope: "global" });
const store = useFileSyncStore();

// Disabled-with-reason, never hidden (the pairing panel's convention). Live
// from the shared store, so flipping "Connect via Tor" in Settings disables
// Push/Pull here without a remount.
const network = useNetworkStore();
const offline = computed(() => network.offline);
const torMode = computed(() => network.useTor);

const blockedReason = computed(() => {
  if (!isTauri()) return t("fsync.desktopOnly");
  if (offline.value) return t("devices.blockedOffline");
  if (torMode.value) return t("devices.blockedTor");
  if (!store.linked) return t("fsync.notLinked");
  if (!store.online) return t("fsync.peerOffline");
  return "";
});

const MARKER_KEYS: Record<string, string> = {
  missing: "fsync.stateMissing",
  excess: "fsync.stateLocalOnly",
  changed: "fsync.stateDiffers",
  notShared: "fsync.stateNotShared",
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
  declined: "fsync.outcomeDeclined",
};

const myRows = computed(() => buildTree(store.myBucket));
const selectionSet = computed(() => new Set(store.selection));

/** Selectable rows in my bucket (ghosts included; unshared scans excluded). */
const selectableIds = computed(() =>
  store.myBucket.filter((f: BucketFile) => f.selectable).map((f: BucketFile) => f.id),
);
const allSelected = computed(
  () => selectableIds.value.length > 0 && selectableIds.value.every((id: string) => store.selection.has(id)),
);
function selectAll(): void {
  const on = !allSelected.value;
  store.selectAll(false);
  if (on) for (const id of selectableIds.value) store.toggle(id);
}

/** Batch outcomes summarized under the tree (per-row text lives on hover). */
const outcomes = computed(() =>
  [...store.items.entries()]
    .map(([entryId, item]) => {
      const entry = store.entries.find((e) => e.id === entryId);
      return entry ? { entryId, name: entry.name, item } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null),
);

function isShared(row: BucketFile): boolean {
  return row.marker !== "notShared" && !row.id.startsWith("s:");
}

onMounted(async () => {
  await network.refresh();
  await store.init();
  await store.refresh();
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
        <OyaButton variant="secondary" :disabled="!isTauri()" data-testid="fsync-rescan" @click="store.refresh()">
          <font-awesome-icon icon="rotate" />{{ t('fsync.rescan') }}
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
    <p v-if="store.scanTruncated" class="text-sm opacity-65">
      {{ t('fsync.scanTruncated', { count: store.scanFiles.length }) }}
    </p>

    <!-- Incoming pushes wait here for consent; nothing lands until Accept. -->
    <div
      v-for="offer in store.pendingPushOffers"
      :key="offer.offerId"
      class="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2"
      data-testid="fsync-offer"
    >
      <p class="text-sm font-semibold">
        {{ t('fsync.incomingFrom', { name: offer.fromLabel, count: offer.items.length }) }}
      </p>
      <p class="mt-0.5 truncate text-xs opacity-65">
        {{ offer.items.map((i) => i.name).join(', ') }}
      </p>
      <p class="mt-0.5 text-xs opacity-50">{{ t('fsync.incomingHint') }}</p>
      <div class="mt-2 flex gap-2">
        <OyaButton :data-testid="`fsync-accept-${offer.offerId}`" @click="store.acceptPushOffer(offer.offerId)">
          {{ t('fsync.incomingAccept') }}
        </OyaButton>
        <OyaButton variant="secondary" :data-testid="`fsync-decline-${offer.offerId}`" @click="store.declinePushOffer(offer.offerId)">
          {{ t('fsync.incomingDecline') }}
        </OyaButton>
      </div>
    </div>

    <!-- Files added before the enigma folder existed still sit elsewhere. -->
    <div
      v-if="store.legacyEntries.length"
      class="rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
      data-testid="fsync-migrate"
    >
      <p class="text-sm font-semibold">{{ t('fsync.migrateTitle') }}</p>
      <p class="mt-0.5 text-xs opacity-65">{{ t('fsync.migrateHint') }}</p>
      <OyaButton class="mt-2" variant="secondary" data-testid="fsync-migrate-run" @click="store.migrateLegacy()">
        {{ t('fsync.migrateRun') }} ({{ store.legacyEntries.length }})
      </OyaButton>
    </div>

    <!-- This device -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-semibold">
        <font-awesome-icon icon="folder" class="mr-1 text-accent-light dark:text-accent-dark" />
        {{ t('fsync.thisDeviceBucket') }}
        <span class="ml-1 text-xs font-normal opacity-50">{{ store.root }}</span>
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="h-4 w-4 accent-accent-light dark:accent-accent-dark"
            data-testid="fsync-select-all"
            :checked="allSelected"
            @change="selectAll()"
          />
          {{ t('fsync.selectAll') }}
          <span class="text-xs opacity-60">({{ store.selection.size }}/{{ selectableIds.length }})</span>
        </label>
        <OyaButton
          :disabled="!store.canTransfer || !store.selection.size || store.selectionHasChanged"
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
    <p v-if="store.selectionHasChanged" class="text-xs font-semibold text-orange-500" data-testid="fsync-pull-only">
      {{ t('fsync.pullOnlyChanged') }}
    </p>

    <OyaEmptyState v-if="!myRows.length" icon="file-arrow-up" class="py-8">
      {{ t('fsync.empty') }}
    </OyaEmptyState>
    <FileTree
      v-else
      :items="myRows"
      :selection="selectionSet"
      :disabled="store.batchActive"
      data-testid="fsync-tree-mine"
      @toggle-select="store.toggle($event)"
    >
      <template #marker-label="{ marker }">{{ t(MARKER_KEYS[marker]) }}</template>
      <template #actions="{ item }">
        <button
          v-if="store.myBucket.find((f: BucketFile) => f.id === item.id && f.marker === 'notShared')"
          class="rounded px-2 py-0.5 text-xs font-semibold text-accent-light hover:underline dark:text-accent-dark"
          :title="t('fsync.shareHint')"
          :data-testid="`fsync-share-${item.id}`"
          @click="store.shareFile(store.myBucket.find((f: BucketFile) => f.id === item.id)!.dir, item.name)"
        >
          {{ t('fsync.share') }}
        </button>
        <button
          v-else-if="isShared({ id: item.id, dir: '', name: item.name })"
          class="rounded px-2 py-0.5 text-xs text-red-500 hover:underline"
          :data-testid="`fsync-remove-${item.id}`"
          @click="store.removeEntry(item.id)"
        >
          <font-awesome-icon icon="trash" />
        </button>
      </template>
    </FileTree>

    <!-- Batch outcomes -->
    <ul v-if="outcomes.length" class="space-y-0.5 text-xs opacity-75" data-testid="fsync-outcomes">
      <li v-for="o in outcomes" :key="o.entryId">
        <span class="font-semibold">{{ o.name }}</span> ·
        <span :class="o.item.status === 'failed' ? 'text-red-500' : ''">
          {{ t(OUTCOME_KEYS[o.item.status] ?? 'fsync.outcomeWorking') }}
        </span>
        <template v-if="o.item.total"> ({{ o.item.transferred }} / {{ o.item.total }})</template>
      </li>
    </ul>

    <!-- One bucket per linked sibling: names only, markers relative to us. -->
    <div v-for="bucket in store.siblingBuckets" :key="bucket.deviceId" class="space-y-1 pt-2">
      <p class="text-sm font-semibold">
        <font-awesome-icon icon="mobile-screen" class="mr-1 opacity-60" />
        {{ bucket.label }}
      </p>
      <FileTree :items="buildTree(bucket.files)" :data-testid="`fsync-tree-${bucket.deviceId}`">
        <template #marker-label="{ marker }">{{ t(MARKER_KEYS[marker]) }}</template>
        <template #empty>{{ t('fsync.empty') }}</template>
      </FileTree>
    </div>
  </OyaCard>
</template>
