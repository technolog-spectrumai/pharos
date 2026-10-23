<script setup lang="ts">
// Local passphrase-protected files. Pick a file and "lock" it: it's encrypted in
// place on the device (opening it normally shows garbage), and unlockable later
// with the same passphrase. Passphrases are never stored — we only keep a record
// of which files are locked (in the encrypted kv store) so we can list them here.
//
// Editing files is Morion's job. Enigma's own text and drawing editors were
// removed; see README.md ("Removed features") for the commit that still has them.
import { onMounted, ref } from "vue";
import { OyaModal, OyaButton, OyaIconButton } from "rakotis";
import {
  getLockedFiles,
  addLockedFile,
  removeLockedFile,
  isLocalFileLocked,
  getFileKeyRotationDays,
  statLocalNote,
  getBuildConfig,
  keyringList,
  type KeyringSummary,
  type LockedFileRecord,
  type LockedFileResult,
  formatDate,
  formatBytes,
} from "rakotis";
import { policy } from "../../config/app";
import LocalPassphraseModal, { type LockOutcome } from "./LocalPassphraseModal.vue";

defineProps<{ darkMode?: boolean }>();

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

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
      files.value.map(
        async (r) =>
          [
            r.path,
            // ENIGLOCK magic for per-file locks; ring files (.enigr) carry a
            // different magic, so mere existence is the right check there.
            r.ring
              ? await statLocalNote(r.path).then((s) => s.exists).catch(() => true)
              : await isLocalFileLocked(r.path).catch(() => true),
          ] as const,
      ),
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
  await refresh();
  if (getBuildConfig().keyring_enabled) {
    availableRings.value = await keyringList().catch(() => []);
  }
});

// ── passphrase modal (lock / unlock / rotate) ───────────────────────────────────
const showModal = ref(false);
const modalMode = ref<"lock" | "unlock" | "rotate">("lock");
const modalPath = ref("");
const modalName = ref("");
/** Unlock of a ring-locked record: the ring passphrase is the only key. */
const modalRing = ref(false);
/** Unlock: the ring that holds this file's key (from its record). */
const modalRingId = ref("");
/** Plaintext size handed to the modal when the caller knows it (ring outcomes
 *  don't measure). */
const modalSize = ref(0);
/** Key ring exists in this build AND on this profile — offers the lock-method
 *  chooser. Checked once per mount; creating the ring happens in Files → Keys. */
const availableRings = ref<KeyringSummary[]>([]);

async function pickAndLock() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false });
  if (typeof path !== "string" || !path) return; // cancelled
  modalMode.value = "lock";
  modalPath.value = path;
  modalName.value = path.split(/[\\/]/).pop() || path;
  modalRing.value = false;
  modalRingId.value = "";
  modalSize.value = await statLocalNote(path)
    .then((s) => s.size)
    .catch(() => 0);
  showModal.value = true;
}

function askUnlock(rec: LockedFileRecord) {
  modalMode.value = "unlock";
  modalPath.value = rec.path;
  modalName.value = rec.name;
  // A ring-locked file only opens with the ring's passphrase — no choice shown.
  modalRing.value = !!rec.ring;
  modalRingId.value = rec.ringId ?? "";
  modalSize.value = rec.size;
  showModal.value = true;
}

function askRotate(rec: LockedFileRecord) {
  modalMode.value = "rotate";
  modalPath.value = rec.path;
  modalName.value = rec.name;
  showModal.value = true;
}

async function onLocked(res: LockOutcome) {
  await addLockedFile({
    // The ring renames to `.enigr`; ENIGLOCK seals in place.
    path: res.newPath ?? modalPath.value,
    name: res.name,
    size: res.size,
    lockedAt: Date.now(),
    ...(res.ring ? { ring: true, ringId: res.ringId } : {}),
  });
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

// ── forget (remove from list; the file stays encrypted on disk) ──────────────────
const forgetTarget = ref<LockedFileRecord | null>(null);

async function confirmForget() {
  if (!forgetTarget.value) return;
  await removeLockedFile(forgetTarget.value.path);
  forgetTarget.value = null;
  await refresh();
}

// ── formatting ───────────────────────────────────────────────────────────────────
// The app's one byte formatter, so a size in the Files tab and the same size
// elsewhere cannot disagree about the decimal separator.
const fmtSize = formatBytes;

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return formatDate(d, "date");
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
      <!-- `min-h-0`: without it this column item cannot shrink below the file
           list, so it never scrolls and the panel's `overflow-hidden` clips. -->
      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        <div
          v-for="f in files"
          :key="f.path"
          class="flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
        >
          <font-awesome-icon
            :icon="onDisk[f.path] === false ? 'triangle-exclamation' : f.ring ? 'key' : 'lock'"
            class="shrink-0"
            :class="onDisk[f.path] === false
              ? 'text-warn-dark'
              : f.ring
                ? 'text-accent-light dark:text-accent-dark'
                : 'opacity-50'"
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
          <!-- Ring files rotate through the ring's change-passphrase, not per file. -->
          <OyaIconButton
            v-if="!f.ring"
            size="sm"
            icon="rotate-right"
            :label="$t('local.rotate')"
            :disabled="onDisk[f.path] === false"
            @click="askRotate(f)"
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
    </template>

    <!-- Passphrase (lock / unlock / rotate) -->
    <LocalPassphraseModal
      v-model:open="showModal"
      :mode="modalMode"
      :path="modalPath"
      :name="modalName"
      :min-len="policy.passphraseMinLen"
      :rings="availableRings"
      :ring-forced="modalRing"
      :ring-id="modalRingId"
      :file-size="modalSize"
      @locked="onLocked"
      @unlocked="onUnlocked"
      @rotated="onRotated"
    />

    <!-- Forget confirm -->
    <OyaModal :open="forgetTarget !== null" @close="forgetTarget = null">
      <div class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
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
