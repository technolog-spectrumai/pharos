<script setup lang="ts">
// Enigma Cloud UI — the account-backed file locker on the user's own server.
// Same card shell as FilePanel; all state lives in the cloud Pinia store, so
// transfers keep running while the user is on another tab.
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaModal, OyaTextField, OyaButton, OyaIconButton } from "rakotis";
import CloudLoginModal from "./CloudLoginModal.vue";
import {
  useCloudStore,
  type CloudBucket,
  type CloudDirectory,
  type CloudFile,
} from "../../stores/cloud";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

const { t } = useI18n({ useScope: "global" });
const cloud = useCloudStore();

onMounted(async () => {
  await cloud.init();
  if (cloud.loggedIn) void cloud.refresh();
});

const showLogin = ref(false);

// ── navigation ─────────────────────────────────────────────────────────────────
// One bucket (or none) → the root IS that bucket's contents. Multiple buckets →
// the root lists buckets as folders, and Upload / New-folder only appear inside
// a bucket (the server needs a concrete bucket_slug then).
const currentBucketSlug = ref<string | null>(null);
const currentDirId = ref<number | null>(null);

watch(
  () => cloud.loggedIn,
  () => {
    currentBucketSlug.value = null;
    currentDirId.value = null;
  },
);

const multiBucket = computed(() => cloud.buckets.length > 1);
const atBucketList = computed(() => multiBucket.value && currentBucketSlug.value === null);
const activeBucketSlug = computed<string | null>(() =>
  multiBucket.value ? currentBucketSlug.value : (cloud.buckets[0]?.slug ?? null),
);
const activeBucket = computed<CloudBucket | null>(
  () => cloud.buckets.find((b) => b.slug === activeBucketSlug.value) ?? null,
);

const currentDirs = computed<CloudDirectory[]>(() => {
  if (atBucketList.value) return [];
  return (activeBucket.value?.directories ?? [])
    .filter((d) => (d.parent_id ?? null) === currentDirId.value)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
});

const currentFiles = computed<CloudFile[]>(() => {
  if (atBucketList.value) return [];
  return cloud.files
    .filter(
      (f) =>
        (activeBucketSlug.value === null || f.bucket_slug === activeBucketSlug.value) &&
        (f.directory_id ?? null) === currentDirId.value,
    )
    .slice()
    .sort((a, b) => (a.title || a.key).localeCompare(b.title || b.key));
});

interface Crumb {
  label: string;
  dirId: number | null;
  bucketList: boolean;
}

const breadcrumb = computed<Crumb[]>(() => {
  const crumbs: Crumb[] = [];
  if (multiBucket.value) {
    crumbs.push({ label: t("cloud.buckets"), dirId: null, bucketList: true });
    if (currentBucketSlug.value === null) return crumbs;
  }
  const b = activeBucket.value;
  crumbs.push({ label: b?.name || t("cloud.root"), dirId: null, bucketList: false });
  // Walk the parent chain up from the current directory.
  const dirs = b?.directories ?? [];
  const chain: CloudDirectory[] = [];
  let id = currentDirId.value;
  while (id !== null) {
    const d = dirs.find((x) => x.id === id);
    if (!d) break;
    chain.unshift(d);
    id = d.parent_id ?? null;
  }
  for (const d of chain) crumbs.push({ label: d.name, dirId: d.id, bucketList: false });
  return crumbs;
});

function goCrumb(c: Crumb) {
  if (c.bucketList) {
    currentBucketSlug.value = null;
    currentDirId.value = null;
    return;
  }
  currentDirId.value = c.dirId;
}

function enterBucket(b: CloudBucket) {
  currentBucketSlug.value = b.slug;
  currentDirId.value = null;
}

function enterDir(d: CloudDirectory) {
  currentDirId.value = d.id;
}

/** Only empty folders get a delete button (the server 409s otherwise anyway). */
function isEmptyDir(d: CloudDirectory): boolean {
  const dirs = activeBucket.value?.directories ?? [];
  if (dirs.some((x) => (x.parent_id ?? null) === d.id)) return false;
  const slug = activeBucketSlug.value;
  return !cloud.files.some(
    (f) => (slug === null || f.bucket_slug === slug) && (f.directory_id ?? null) === d.id,
  );
}

// ── session ────────────────────────────────────────────────────────────────────
async function doLogout() {
  await cloud.logout();
}

// ── upload ─────────────────────────────────────────────────────────────────────
async function pickAndUpload() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false });
  if (typeof path !== "string" || !path) return; // user cancelled
  await cloud.upload(path, {
    bucketSlug: activeBucketSlug.value ?? undefined,
    directoryId: currentDirId.value ?? undefined,
  });
}

// ── download ───────────────────────────────────────────────────────────────────
/** Save-dialog default name: the title, with an extension inferred from the
 *  media URL when the title has none. */
function suggestedName(f: CloudFile): string {
  const base = (f.title || f.key || "file").trim();
  if (/\.[A-Za-z0-9]{1,8}$/.test(base)) return base;
  const path = (f.download_url || "").split(/[?#]/)[0];
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const m = last.match(/(\.[A-Za-z0-9]{1,8})$/);
  return m ? base + m[1] : base;
}

async function downloadFile(f: CloudFile) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({ defaultPath: suggestedName(f) });
  if (!dest) return; // user cancelled
  await cloud.download(f.key, dest);
}

// ── new folder ─────────────────────────────────────────────────────────────────
const showNewFolder = ref(false);
const newFolderName = ref("");
const newFolderError = ref("");
const newFolderBusy = ref(false);

function openNewFolder() {
  newFolderName.value = "";
  newFolderError.value = "";
  showNewFolder.value = true;
}

async function submitNewFolder() {
  const name = newFolderName.value.trim();
  if (!name || newFolderBusy.value) return;
  newFolderBusy.value = true;
  newFolderError.value = "";
  try {
    await cloud.mkdir(name, {
      bucketSlug: activeBucketSlug.value ?? undefined,
      parentId: currentDirId.value ?? undefined,
    });
    showNewFolder.value = false;
  } catch (e) {
    newFolderError.value = (e as Error)?.message ?? String(e);
  } finally {
    newFolderBusy.value = false;
  }
}

// ── delete (file or empty folder) — confirm via a minimal modal ────────────────
const confirmDelete = ref<
  { kind: "file"; file: CloudFile } | { kind: "dir"; dir: CloudDirectory } | null
>(null);
const deleteBusy = ref(false);
const deleteError = ref("");

const deleteName = computed(() => {
  const c = confirmDelete.value;
  if (!c) return "";
  return c.kind === "file" ? c.file.title || c.file.key : c.dir.name;
});

function askDeleteFile(f: CloudFile) {
  deleteError.value = "";
  confirmDelete.value = { kind: "file", file: f };
}

function askDeleteDir(d: CloudDirectory) {
  deleteError.value = "";
  confirmDelete.value = { kind: "dir", dir: d };
}

async function submitDelete() {
  const target = confirmDelete.value;
  if (!target || deleteBusy.value) return;
  deleteBusy.value = true;
  deleteError.value = "";
  try {
    if (target.kind === "file") await cloud.remove(target.file.key);
    else await cloud.rmdir(target.dir.id);
    confirmDelete.value = null;
  } catch (e) {
    deleteError.value = (e as Error)?.message ?? String(e);
  } finally {
    deleteBusy.value = false;
  }
}

// ── move (folder-select dropdown in a small modal) ─────────────────────────────
const moveFile = ref<CloudFile | null>(null);
const moveDest = ref(""); // "" = bucket root, else the directory id as string
const moveBusy = ref(false);
const moveError = ref("");

const moveOptions = computed<CloudDirectory[]>(() => {
  const f = moveFile.value;
  if (!f) return [];
  const b = cloud.buckets.find((x) => x.slug === f.bucket_slug) ?? activeBucket.value;
  return (b?.directories ?? []).slice().sort((a, c) => (a.path || a.name).localeCompare(c.path || c.name));
});

function openMove(f: CloudFile) {
  moveFile.value = f;
  moveDest.value = f.directory_id === null ? "" : String(f.directory_id);
  moveError.value = "";
}

async function submitMove() {
  const f = moveFile.value;
  if (!f || moveBusy.value) return;
  moveBusy.value = true;
  moveError.value = "";
  try {
    await cloud.move(f.key, moveDest.value === "" ? null : Number(moveDest.value));
    moveFile.value = null;
  } catch (e) {
    moveError.value = (e as Error)?.message ?? String(e);
  } finally {
    moveBusy.value = false;
  }
}

// ── formatting ─────────────────────────────────────────────────────────────────
function fmtSize(bytes: number): string {
  if (!bytes) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

function pct(tr: { transferred: number; total: number }): number {
  return tr.total ? Math.min(100, Math.round((tr.transferred / tr.total) * 100)) : 0;
}
</script>

<template>
  <div
    class="flex h-full w-full flex-col overflow-hidden rounded-lg border shadow-md bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1"
  >
    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-current/10 p-4">
      <font-awesome-icon icon="cloud" class="text-accent-light dark:text-accent-dark" />
      <h2 class="text-lg font-bold">{{ $t('cloud.title') }}</h2>
      <template v-if="_isTauri() && cloud.loggedIn">
        <span
          class="ml-auto inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-accent-2 px-2.5 py-1 text-xs font-semibold dark:border-accent-1"
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
    </div>

    <!-- Desktop-only -->
    <div
      v-if="!_isTauri()"
      class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <font-awesome-icon icon="desktop" class="text-3xl opacity-30" />
      <p class="text-sm opacity-60">{{ $t('cloud.desktopOnly') }}</p>
    </div>

    <!-- Checking the stored session -->
    <div
      v-else-if="cloud.checking"
      class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <font-awesome-icon icon="spinner" spin class="text-3xl text-accent-light dark:text-accent-dark" />
    </div>

    <!-- Logged out -->
    <div
      v-else-if="!cloud.loggedIn"
      class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <font-awesome-icon icon="cloud" class="text-3xl opacity-30" />
      <p class="max-w-xs text-sm opacity-70">{{ $t('cloud.loggedOutHint') }}</p>
      <button
        class="rounded-lg bg-accent-light px-4 py-2 text-sm font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
        @click="showLogin = true"
      >
        <font-awesome-icon icon="right-to-bracket" /> {{ $t('cloud.loginPrompt') }}
      </button>
      <p v-if="cloud.error" class="max-w-sm text-xs text-warn-dark">{{ cloud.error }}</p>
    </div>

    <!-- Logged in: the browser -->
    <template v-else>
      <!-- Toolbar: breadcrumb + actions -->
      <div class="flex flex-wrap items-center gap-2 border-b border-current/10 px-4 py-2">
        <nav class="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          <template v-for="(c, i) in breadcrumb" :key="`${c.bucketList}-${c.dirId}-${i}`">
            <font-awesome-icon v-if="i > 0" icon="chevron-right" class="shrink-0 text-[10px] opacity-40" />
            <button
              v-if="i < breadcrumb.length - 1"
              class="max-w-40 truncate font-semibold underline-offset-2 opacity-70 transition hover:underline hover:opacity-100"
              @click="goCrumb(c)"
            >{{ c.label }}</button>
            <span v-else class="max-w-40 truncate font-semibold">{{ c.label }}</span>
          </template>
        </nav>
        <OyaIconButton
          size="sm"
          icon="rotate-right"
          :label="$t('cloud.refresh')"
          :disabled="cloud.loading"
          @click="cloud.refresh()"
        />
        <template v-if="!atBucketList">
          <button
            class="shrink-0 rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80"
            @click="openNewFolder"
          >
            <font-awesome-icon icon="folder-plus" /> {{ $t('cloud.newFolder') }}
          </button>
          <button
            class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
            @click="pickAndUpload"
          >
            <font-awesome-icon icon="cloud-arrow-up" /> {{ $t('cloud.upload') }}
          </button>
        </template>
      </div>

      <p v-if="cloud.error" class="border-b border-current/10 px-4 py-2 text-xs text-warn-dark">
        {{ cloud.error }}
      </p>

      <!-- Listing -->
      <div class="flex-1 space-y-2 overflow-y-auto p-3">
        <!-- Root with multiple buckets: buckets as folders -->
        <template v-if="atBucketList">
          <button
            v-for="b in cloud.buckets"
            :key="b.slug"
            class="flex w-full items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 text-left transition hover:opacity-80 dark:border-accent-1"
            @click="enterBucket(b)"
          >
            <font-awesome-icon icon="hard-drive" class="shrink-0 text-accent-light dark:text-accent-dark" />
            <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ b.name || b.slug }}</span>
            <font-awesome-icon icon="chevron-right" class="shrink-0 text-xs opacity-40" />
          </button>
        </template>

        <template v-else>
          <!-- Folders first -->
          <div
            v-for="d in currentDirs"
            :key="d.id"
            class="flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
          >
            <button class="flex min-w-0 flex-1 items-center gap-3 text-left transition hover:opacity-80" @click="enterDir(d)">
              <font-awesome-icon icon="folder" class="shrink-0 text-accent-light dark:text-accent-dark" />
              <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ d.name }}</span>
            </button>
            <OyaIconButton
              v-if="isEmptyDir(d)"
              size="sm"
              icon="trash"
              :label="$t('cloud.deleteFolder')"
              @click="askDeleteDir(d)"
            />
          </div>

          <!-- Then files -->
          <div
            v-for="f in currentFiles"
            :key="f.key"
            class="flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
          >
            <font-awesome-icon icon="file" class="shrink-0 opacity-50" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ f.title || f.key }}</p>
              <p class="text-xs opacity-50">{{ fmtSize(f.file_size_bytes) }} · {{ fmtDate(f.uploaded_at) }}</p>
            </div>
            <OyaIconButton size="sm" icon="arrow-right-arrow-left" :label="$t('cloud.move')" @click="openMove(f)" />
            <OyaIconButton size="sm" icon="download" :label="$t('cloud.download')" @click="downloadFile(f)" />
            <OyaIconButton size="sm" icon="trash" :label="$t('cloud.deleteFile')" @click="askDeleteFile(f)" />
          </div>

          <!-- Loading / empty states -->
          <div
            v-if="cloud.loading && !currentDirs.length && !currentFiles.length"
            class="flex justify-center pt-8"
          >
            <font-awesome-icon icon="spinner" spin class="text-2xl opacity-50" />
          </div>
          <p
            v-else-if="!currentDirs.length && !currentFiles.length"
            class="pt-8 text-center text-xs opacity-40"
          >
            {{ currentDirId === null ? $t('cloud.noFiles') : $t('cloud.emptyFolder') }}
          </p>
        </template>
      </div>

      <!-- Active transfers -->
      <div v-if="cloud.transfers.size" class="space-y-2 border-t border-current/10 p-3">
        <div v-for="[id, tr] in cloud.transfers" :key="id" class="space-y-1">
          <div class="flex items-center gap-2 text-xs">
            <font-awesome-icon
              :icon="tr.dir === 'up' ? 'arrow-up' : 'arrow-down'"
              class="shrink-0 text-accent-light dark:text-accent-dark"
            />
            <span class="min-w-0 flex-1 truncate font-semibold">{{ tr.name }}</span>
            <span class="shrink-0 opacity-50">
              {{ fmtSize(tr.transferred) }}<template v-if="tr.total"> / {{ fmtSize(tr.total) }}</template>
            </span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-sunken-light dark:bg-sunken-dark">
            <div
              class="h-full rounded-full bg-accent-light transition-all dark:bg-accent-dark"
              :style="`width:${pct(tr)}%`"
            />
          </div>
          <p v-if="tr.error" class="text-xs text-warn-dark">{{ tr.error }}</p>
        </div>
      </div>
    </template>

    <!-- Login / register -->
    <CloudLoginModal v-model:open="showLogin" />

    <!-- New folder -->
    <OyaModal :open="showNewFolder" @close="showNewFolder = false">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="folder-plus" />{{ $t('cloud.newFolderTitle') }}
        </p>
        <OyaTextField
          v-model="newFolderName"
          :placeholder="$t('cloud.folderName')"
          :disabled="newFolderBusy"
          @enter="submitNewFolder"
        />
        <p v-if="newFolderError" class="text-sm text-warn-dark">{{ newFolderError }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="showNewFolder = false">
            {{ $t('common.cancel') }}
          </OyaButton>
          <OyaButton
            :class="{ 'pointer-events-none opacity-60': newFolderBusy || !newFolderName.trim() }"
            @click="submitNewFolder"
          >
            <font-awesome-icon :icon="newFolderBusy ? 'spinner' : 'folder-plus'" :spin="newFolderBusy" />
            {{ $t('cloud.create') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>

    <!-- Confirm delete (file or empty folder) -->
    <OyaModal :open="confirmDelete !== null" @close="confirmDelete = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="trash" />{{ $t('cloud.deleteTitle') }}
        </p>
        <p class="text-sm opacity-80">
          {{
            confirmDelete?.kind === 'dir'
              ? $t('cloud.deleteFolderConfirm', { name: deleteName })
              : $t('cloud.deleteFileConfirm', { name: deleteName })
          }}
        </p>
        <p v-if="deleteError" class="text-sm text-warn-dark">{{ deleteError }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="confirmDelete = null">
            {{ $t('common.cancel') }}
          </OyaButton>
          <button
            type="button"
            :class="{ 'pointer-events-none opacity-60': deleteBusy }"
            class="inline-flex items-center justify-center gap-2 rounded-lg bg-warn-light/90 px-4 py-2 text-sm font-bold text-white transition hover:opacity-90 dark:bg-warn-dark/90"
            @click="submitDelete"
          >
            <font-awesome-icon :icon="deleteBusy ? 'spinner' : 'trash'" :spin="deleteBusy" />
            {{ $t('cloud.delete') }}
          </button>
        </div>
      </template>
    </OyaModal>

    <!-- Move file -->
    <OyaModal :open="moveFile !== null" @close="moveFile = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="arrow-right-arrow-left" />{{ $t('cloud.moveTitle') }}
        </p>
        <p class="truncate text-sm opacity-70">{{ moveFile?.title || moveFile?.key }}</p>
        <select
          v-model="moveDest"
          :disabled="moveBusy"
          class="w-full rounded-lg border bg-primary-bg-light px-3 py-2 text-sm outline-none transition border-accent-2 text-text-main-light dark:border-accent-1 dark:bg-primary-bg-dark dark:text-text-main-dark"
        >
          <option value="">{{ $t('cloud.rootFolder') }}</option>
          <option v-for="d in moveOptions" :key="d.id" :value="String(d.id)">
            {{ d.path || d.name }}
          </option>
        </select>
        <p v-if="moveError" class="text-sm text-warn-dark">{{ moveError }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="moveFile = null">
            {{ $t('common.cancel') }}
          </OyaButton>
          <OyaButton :class="{ 'pointer-events-none opacity-60': moveBusy }" @click="submitMove">
            <font-awesome-icon :icon="moveBusy ? 'spinner' : 'arrow-right-arrow-left'" :spin="moveBusy" />
            {{ $t('cloud.move') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>
  </div>
</template>
