<script setup lang="ts">
// Local passphrase-protected files. Pick a file and "lock" it: it's encrypted in
// place on the device (opening it normally shows garbage), and unlockable later
// with the same passphrase. Passphrases are never stored — we only keep a record
// of which files are locked (in the encrypted kv store) so we can list them here.
// A locked file can be uploaded to Cloud as-is: it's already ciphertext, so the
// server stores opaque bytes and learns nothing about the contents.
import { onMounted, ref, watch } from "vue";
import { OyaModal, OyaButton, OyaIconButton } from "rakotis";
import {
  getLockedFiles,
  addLockedFile,
  removeLockedFile,
  isLocalFileLocked,
  getFileKeyRotationDays,
  type LockedFileRecord,
  type LockedFileResult,
} from "rakotis";
import { policy } from "../../config/app";
import { useCloudStore } from "../../stores/cloud";
import CloudLoginModal from "../cloud/CloudLoginModal.vue";
import LocalPassphraseModal from "./LocalPassphraseModal.vue";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

const cloud = useCloudStore();

const files = ref<LockedFileRecord[]>([]);
// path → is the file still a locked blob on disk? (reconciles our record with reality)
const onDisk = ref<Record<string, boolean>>({});
// "Rotate keys every N days" reminder interval (0 = off). See appStorage.
const rotationDays = ref(0);
const loading = ref(false);
const error = ref("");

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    files.value = await getLockedFiles();
    rotationDays.value = await getFileKeyRotationDays();
    const checks = await Promise.all(
      files.value.map(async (r) => [r.path, await isLocalFileLocked(r.path).catch(() => true)] as const),
    );
    onDisk.value = Object.fromEntries(checks);
  } catch (e) {
    error.value = (e as Error)?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

const DAY_MS = 86_400_000;
/** A locked file is "rotation due" when its key is older than the interval. Reminder
 *  only — nothing rotates automatically. Files not actually locked on disk don't count. */
function isDue(rec: LockedFileRecord): boolean {
  if (rotationDays.value <= 0 || onDisk.value[rec.path] === false) return false;
  const last = rec.rotatedAt ?? rec.lockedAt;
  return Date.now() - last >= rotationDays.value * DAY_MS;
}

onMounted(async () => {
  await cloud.init(); // idempotent; makes upload work even if Cloud tab wasn't opened
  await refresh();
});

// ── passphrase modal (lock / unlock / rotate) ────────────────────────────────────
const showModal = ref(false);
const modalMode = ref<"lock" | "unlock" | "rotate">("lock");
const modalPath = ref("");
const modalName = ref("");

async function pickAndLock() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false });
  if (typeof path !== "string" || !path) return; // cancelled
  modalMode.value = "lock";
  modalPath.value = path;
  modalName.value = path.split(/[\\/]/).pop() || path;
  showModal.value = true;
}

function askUnlock(rec: LockedFileRecord) {
  modalMode.value = "unlock";
  modalPath.value = rec.path;
  modalName.value = rec.name;
  showModal.value = true;
}

function askRotate(rec: LockedFileRecord) {
  modalMode.value = "rotate";
  modalPath.value = rec.path;
  modalName.value = rec.name;
  showModal.value = true;
}

async function onLocked(res: LockedFileResult) {
  await addLockedFile({ path: modalPath.value, name: res.name, size: res.size, lockedAt: Date.now() });
  await refresh();
}

async function onUnlocked() {
  await removeLockedFile(modalPath.value);
  await refresh();
}

async function onRotated(res: LockedFileResult) {
  // Keep the original lock time; stamp the rotation so the "due" clock resets.
  const existing = files.value.find((r) => r.path === modalPath.value);
  await addLockedFile({
    path: modalPath.value,
    name: res.name,
    size: res.size,
    lockedAt: existing?.lockedAt ?? Date.now(),
    rotatedAt: Date.now(),
  });
  await refresh();
}

// ── upload to Cloud (ciphertext uploaded as-is) ──────────────────────────────────
const showLogin = ref(false);
const pendingUpload = ref<string | null>(null);

async function uploadToCloud(rec: LockedFileRecord) {
  if (!cloud.loggedIn) {
    pendingUpload.value = rec.path; // resume after login
    showLogin.value = true;
    return;
  }
  await cloud.upload(rec.path);
}

// If the user logs in from the prompt, finish the upload they asked for.
watch(
  () => cloud.loggedIn,
  (v) => {
    if (v && pendingUpload.value) {
      const p = pendingUpload.value;
      pendingUpload.value = null;
      void cloud.upload(p);
    }
  },
);

// ── forget (remove from list; the file stays encrypted on disk) ──────────────────
const forgetTarget = ref<LockedFileRecord | null>(null);

async function confirmForget() {
  if (!forgetTarget.value) return;
  await removeLockedFile(forgetTarget.value.path);
  forgetTarget.value = null;
  await refresh();
}

// ── formatting ───────────────────────────────────────────────────────────────────
function fmtSize(bytes: number): string {
  if (!bytes) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
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
      <font-awesome-icon icon="lock" class="text-accent-light dark:text-accent-dark" />
      <h2 class="text-lg font-bold">{{ $t('local.title') }}</h2>
      <OyaIconButton
        v-if="_isTauri()"
        size="sm"
        icon="rotate-right"
        class="ml-auto"
        :label="$t('local.refresh')"
        :disabled="loading"
        @click="refresh"
      />
    </div>

    <!-- Desktop-only -->
    <div
      v-if="!_isTauri()"
      class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <font-awesome-icon icon="desktop" class="text-3xl opacity-30" />
      <p class="text-sm opacity-60">{{ $t('local.desktopOnly') }}</p>
    </div>

    <template v-else>
      <!-- Toolbar -->
      <div class="flex flex-wrap items-center gap-2 border-b border-current/10 px-4 py-2">
        <p class="min-w-0 flex-1 text-xs opacity-60">{{ $t('local.hint') }}</p>
        <button
          class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
          @click="pickAndLock"
        >
          <font-awesome-icon icon="lock" /> {{ $t('local.lockFile') }}
        </button>
      </div>

      <p v-if="error" class="border-b border-current/10 px-4 py-2 text-xs text-warn-dark">
        {{ error }}
      </p>

      <!-- Listing -->
      <div class="flex-1 space-y-2 overflow-y-auto p-3">
        <div
          v-for="f in files"
          :key="f.path"
          class="flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
        >
          <font-awesome-icon
            :icon="onDisk[f.path] === false ? 'triangle-exclamation' : 'lock'"
            class="shrink-0"
            :class="onDisk[f.path] === false ? 'text-warn-dark' : 'opacity-50'"
          />
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2">
              <span class="truncate text-sm font-semibold">{{ f.name }}</span>
              <span
                v-if="isDue(f)"
                class="shrink-0 rounded-full bg-warn-light/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn-dark dark:bg-warn-dark/20"
              >
                {{ $t('local.rotationDue') }}
              </span>
            </p>
            <p class="truncate text-xs opacity-50">
              {{ fmtSize(f.size) }} · {{ fmtDate(f.rotatedAt ?? f.lockedAt) }}
              <template v-if="onDisk[f.path] === false"> · {{ $t('local.notOnDisk') }}</template>
            </p>
          </div>
          <OyaIconButton
            size="sm"
            icon="lock-open"
            :label="$t('local.unlock')"
            :disabled="onDisk[f.path] === false"
            @click="askUnlock(f)"
          />
          <OyaIconButton
            size="sm"
            icon="rotate-right"
            :label="$t('local.rotate')"
            :disabled="onDisk[f.path] === false"
            @click="askRotate(f)"
          />
          <OyaIconButton
            size="sm"
            icon="cloud-arrow-up"
            :label="$t('local.uploadToCloud')"
            @click="uploadToCloud(f)"
          />
          <OyaIconButton
            size="sm"
            icon="xmark"
            :label="$t('local.forget')"
            @click="forgetTarget = f"
          />
        </div>

        <!-- Loading / empty -->
        <div v-if="loading && !files.length" class="flex justify-center pt-8">
          <font-awesome-icon icon="spinner" spin class="text-2xl opacity-50" />
        </div>
        <p v-else-if="!files.length" class="pt-8 text-center text-xs opacity-40">
          {{ $t('local.noFiles') }}
        </p>
      </div>

      <!-- Active transfers (shared with the Cloud tab) -->
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

    <!-- Passphrase (lock / unlock / rotate) -->
    <LocalPassphraseModal
      v-model:open="showModal"
      :mode="modalMode"
      :path="modalPath"
      :name="modalName"
      :min-len="policy.passphraseMinLen"
      @locked="onLocked"
      @unlocked="onUnlocked"
      @rotated="onRotated"
    />

    <!-- Cloud login (when uploading while logged out) -->
    <CloudLoginModal v-model:open="showLogin" />

    <!-- Forget confirm -->
    <OyaModal :open="forgetTarget !== null" @close="forgetTarget = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="xmark" />{{ $t('local.forgetTitle') }}
        </p>
        <p class="text-sm opacity-80">{{ $t('local.forgetConfirm', { name: forgetTarget?.name }) }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="forgetTarget = null">
            {{ $t('common.cancel') }}
          </OyaButton>
          <OyaButton @click="confirmForget">
            <font-awesome-icon icon="xmark" /> {{ $t('local.forget') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>
  </div>
</template>
