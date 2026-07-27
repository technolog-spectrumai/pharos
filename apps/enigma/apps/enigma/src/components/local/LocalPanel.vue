<script setup lang="ts">
// Local passphrase-protected files. Pick a file and "lock" it: it's encrypted in
// place on the device (opening it normally shows garbage), and unlockable later
// with the same passphrase. Passphrases are never stored — we only keep a record
// of which files are locked (in the encrypted kv store) so we can list them here.
// A locked file can be uploaded to Cloud as-is: it's already ciphertext, so the
// server stores opaque bytes and learns nothing about the contents.
//
// The tab also hosts the notes editor. Opening a file swaps this panel for the
// editor; a locked file is decrypted into memory after a passphrase prompt and
// re-sealed on save, so its plaintext never reaches disk. The passphrase is held
// only while that file is open and is dropped the moment the editor closes.
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { OyaModal, OyaButton, OyaIconButton } from "rakotis";
import {
  getLockedFiles,
  addLockedFile,
  removeLockedFile,
  isLocalFileLocked,
  getFileKeyRotationDays,
  readLocalNote,
  writeLocalNote,
  statLocalNote,
  getNoteRecents,
  addNoteRecent,
  removeNoteRecent,
  type LockedFileRecord,
  type LockedFileResult,
  type LocalNoteContent,
  type LocalNoteStat,
  type NoteRecentRecord,
} from "rakotis";
import { policy } from "../../config/app";
import { useCloudStore } from "../../stores/cloud";
import CloudLoginModal from "../cloud/CloudLoginModal.vue";
import LocalPassphraseModal from "./LocalPassphraseModal.vue";
// ACE is heavy (~1.4 MB of source) and only needed once a file is actually opened, so
// it loads on demand. Still fully offline — the chunk ships in the app bundle.
import type NoteEditorComponent from "./NoteEditor.vue";
const NoteEditor = defineAsyncComponent(() => import("./NoteEditor.vue"));

defineProps<{ darkMode?: boolean }>();

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

// Recently edited files (plain or locked), and what's actually on disk for each.
const recents = ref<NoteRecentRecord[]>([]);
const recentStat = ref<Record<string, LocalNoteStat>>({});

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    files.value = await getLockedFiles();
    rotationDays.value = await getFileKeyRotationDays();
    recents.value = await getNoteRecents();
    const [checks, stats] = await Promise.all([
      Promise.all(
        files.value.map(
          async (r) => [r.path, await isLocalFileLocked(r.path).catch(() => true)] as const,
        ),
      ),
      Promise.all(
        recents.value.map(
          async (r) =>
            [
              r.path,
              await statLocalNote(r.path).catch(
                () => ({ exists: true, locked: r.locked, size: r.size }) as LocalNoteStat,
              ),
            ] as const,
        ),
      ),
    ]);
    onDisk.value = Object.fromEntries(checks);
    recentStat.value = Object.fromEntries(stats);
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

// ── passphrase modal (lock / unlock / rotate / open / encrypt) ──────────────────
const showModal = ref(false);
const modalMode = ref<"lock" | "unlock" | "rotate" | "open" | "encrypt">("lock");
const modalPath = ref("");
const modalName = ref("");
// What the "open"/"encrypt" modes do on submit; those flows depend on editor state,
// so the modal defers to us. Rejecting keeps the modal open with the message inline.
const modalAction = ref<((passphrase: string) => Promise<void>) | undefined>(undefined);

function askPassphrase(
  mode: "open" | "encrypt",
  name: string,
  action: (passphrase: string) => Promise<void>,
) {
  modalMode.value = mode;
  modalPath.value = "";
  modalName.value = name;
  modalAction.value = action;
  showModal.value = true;
}

async function pickAndLock() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false });
  if (typeof path !== "string" || !path) return; // cancelled
  modalMode.value = "lock";
  modalPath.value = path;
  modalName.value = path.split(/[\\/]/).pop() || path;
  modalAction.value = undefined;
  showModal.value = true;
}

function askUnlock(rec: LockedFileRecord) {
  modalMode.value = "unlock";
  modalPath.value = rec.path;
  modalName.value = rec.name;
  modalAction.value = undefined;
  showModal.value = true;
}

function askRotate(rec: LockedFileRecord) {
  modalMode.value = "rotate";
  modalPath.value = rec.path;
  modalName.value = rec.name;
  modalAction.value = undefined;
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

// ── notes editor ─────────────────────────────────────────────────────────────────
// This panel is either the file list or the editor. The open file's passphrase lives
// in `note` and nowhere else: it's needed on every save (each save re-derives the key
// from the file's current header, so a file re-keyed elsewhere fails closed instead of
// being clobbered), and it's dropped when the editor closes.

interface OpenNote {
  /** null until a new note has been saved somewhere. */
  path: string | null;
  name: string;
  /** True once the file is stored encrypted on disk. */
  locked: boolean;
  passphrase: string | null;
  /** A new note the user chose to encrypt: seal it on its first save. */
  pendingEncrypt: boolean;
  content: string;
}

const view = ref<"list" | "editor">("list");
const note = ref<OpenNote | null>(null);
const editorRef = ref<InstanceType<typeof NoteEditorComponent> | null>(null);
const editorDirty = ref(false);
const noteBusy = ref(false);
const noteError = ref("");
/** Set while the discard prompt is up; runs if the user confirms. */
const discardAction = ref<(() => void) | null>(null);

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function errText(e: unknown): string {
  return typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
}

function enterEditor(path: string, read: LocalNoteContent, passphrase: string | null) {
  note.value = {
    path,
    name: read.name,
    locked: read.locked,
    passphrase,
    pendingEncrypt: false,
    content: read.content,
  };
  editorDirty.value = false;
  noteError.value = "";
  view.value = "editor";
  void addNoteRecent({
    path,
    name: read.name,
    size: read.size,
    locked: read.locked,
    openedAt: Date.now(),
  });
}

/** Open a file in the editor, prompting for its passphrase first if it's locked. */
async function openPath(path: string) {
  error.value = "";
  try {
    if (await isLocalFileLocked(path)) {
      askPassphrase("open", baseName(path), async (pass) => {
        enterEditor(path, await readLocalNote(path, pass), pass);
      });
      return;
    }
    enterEditor(path, await readLocalNote(path), null);
  } catch (e) {
    error.value = errText(e);
  }
}

async function openFilePicker() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false });
  if (typeof path !== "string" || !path) return; // cancelled
  await openPath(path);
}

function newNote() {
  note.value = {
    path: null,
    name: "untitled.txt",
    locked: false,
    passphrase: null,
    pendingEncrypt: false,
    content: "",
  };
  editorDirty.value = false;
  noteError.value = "";
  view.value = "editor";
}

/** Remember an encrypted note in the locked-file list too, so it keeps its rotate /
 *  upload actions there. Preserves the original lock time if we already knew it. */
async function rememberLocked(path: string, res: LockedFileResult) {
  const existing = files.value.find((r) => r.path === path);
  await addLockedFile({
    path,
    name: res.name,
    size: res.size,
    lockedAt: existing?.lockedAt ?? Date.now(),
    rotatedAt: existing?.rotatedAt,
  });
}

async function saveNote(content: string) {
  const n = note.value;
  if (!n || noteBusy.value) return;

  // A note that has never been saved needs somewhere to go first.
  if (!n.path) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const chosen = await save({ defaultPath: n.name });
    if (!chosen) return; // cancelled
    n.path = chosen;
    n.name = baseName(chosen);
  }

  noteBusy.value = true;
  noteError.value = "";
  try {
    await writeSealedOrPlain(n, content);
  } catch (e) {
    const msg = errText(e);
    // The file was re-keyed by something else while we had it open: ask again rather
    // than silently failing, then retry with the passphrase it has now.
    if (n.locked && msg.includes("wrong passphrase")) {
      askPassphrase("open", n.name, async (pass) => {
        await writeSealedOrPlain(n, content, pass);
        n.passphrase = pass;
      });
    } else {
      noteError.value = msg;
    }
  } finally {
    noteBusy.value = false;
  }
}

/** The write itself, shared by the first attempt and the re-prompt retry. */
async function writeSealedOrPlain(n: OpenNote, content: string, passOverride?: string) {
  const pass = passOverride ?? (n.locked || n.pendingEncrypt ? (n.passphrase ?? undefined) : undefined);
  const res = await writeLocalNote(n.path!, content, pass);
  if (pass) {
    n.locked = true;
    n.pendingEncrypt = false;
    await rememberLocked(n.path!, res);
  }
  await addNoteRecent({
    path: n.path!,
    name: res.name,
    size: res.size,
    locked: n.locked,
    openedAt: Date.now(),
  });
  editorRef.value?.markSaved();
  noteError.value = "";
  await refresh();
}

/** Seal a plain note. An existing file is sealed right away; a never-saved one just
 *  remembers the passphrase, so its first save writes ciphertext and its plaintext
 *  never lands on disk at all. */
function encryptNote() {
  const n = note.value;
  if (!n) return;
  askPassphrase("encrypt", n.name, async (pass) => {
    if (!n.path) {
      n.passphrase = pass;
      n.pendingEncrypt = true;
      return;
    }
    const res = await writeLocalNote(n.path, editorRef.value?.getContent() ?? n.content, pass);
    n.locked = true;
    n.passphrase = pass;
    n.pendingEncrypt = false;
    await rememberLocked(n.path, res);
    await addNoteRecent({ path: n.path, name: res.name, size: res.size, locked: true, openedAt: Date.now() });
    editorRef.value?.markSaved();
    await refresh();
  });
}

/** Leave the editor, dropping the buffer and the passphrase with it. */
function closeEditor() {
  note.value = null;
  editorDirty.value = false;
  noteError.value = "";
  view.value = "list";
}

function backToList() {
  if (editorDirty.value) {
    discardAction.value = () => {
      closeEditor();
      void refresh();
    };
    return;
  }
  closeEditor();
  void refresh();
}

function confirmDiscard() {
  const run = discardAction.value;
  discardAction.value = null;
  run?.();
}

async function forgetNote(rec: NoteRecentRecord) {
  await removeNoteRecent(rec.path);
  await refresh();
}

// Switching tabs unmounts this panel; make sure the passphrase doesn't outlive it.
onBeforeUnmount(closeEditor);

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

    <template v-else-if="view === 'editor' && note">
      <NoteEditor
        ref="editorRef"
        :path="note.path"
        :name="note.name"
        :content="note.content"
        :locked="note.locked"
        :dark-mode="darkMode"
        :busy="noteBusy"
        :error="noteError"
        @save="saveNote"
        @back="backToList"
        @encrypt="encryptNote"
        @update:dirty="editorDirty = $event"
      />
    </template>

    <template v-else>
      <!-- Toolbar -->
      <div class="flex flex-wrap items-center gap-2 border-b border-current/10 px-4 py-2">
        <p class="min-w-0 flex-1 text-xs opacity-60">{{ $t('local.hint') }}</p>
        <button
          class="shrink-0 rounded-lg border border-accent-2 px-3 py-1.5 text-xs font-bold transition hover:opacity-80 dark:border-accent-1"
          @click="openFilePicker"
        >
          <font-awesome-icon icon="file" /> {{ $t('local.openFile') }}
        </button>
        <button
          class="shrink-0 rounded-lg border border-accent-2 px-3 py-1.5 text-xs font-bold transition hover:opacity-80 dark:border-accent-1"
          @click="newNote"
        >
          <font-awesome-icon icon="plus" /> {{ $t('local.newNote') }}
        </button>
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
            icon="pencil"
            :label="$t('local.edit')"
            :disabled="onDisk[f.path] === false"
            @click="openPath(f.path)"
          />
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
          <!-- Only offered while the Cloud master switch is on (cloud.md). -->
          <OyaIconButton
            v-if="cloud.enabled"
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

        <!-- Recently edited files (plain or encrypted) -->
        <div v-if="recents.length" class="space-y-2 pt-4">
          <p class="px-1 text-xs font-semibold uppercase tracking-wide opacity-40">
            {{ $t('local.recentNotes') }}
          </p>
          <div
            v-for="r in recents"
            :key="r.path"
            class="flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
          >
            <font-awesome-icon
              :icon="recentStat[r.path]?.exists === false
                ? 'triangle-exclamation'
                : (recentStat[r.path]?.locked ?? r.locked) ? 'lock' : 'file'"
              class="shrink-0"
              :class="recentStat[r.path]?.exists === false ? 'text-warn-dark' : 'opacity-50'"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ r.name }}</p>
              <p class="truncate text-xs opacity-50">
                {{ fmtSize(r.size) }} · {{ fmtDate(r.openedAt) }}
                <template v-if="recentStat[r.path]?.exists === false">
                  · {{ $t('local.notOnDiskNote') }}
                </template>
              </p>
            </div>
            <OyaIconButton
              size="sm"
              icon="pencil"
              :label="$t('local.edit')"
              :disabled="recentStat[r.path]?.exists === false"
              @click="openPath(r.path)"
            />
            <OyaIconButton
              size="sm"
              icon="xmark"
              :label="$t('local.removeNote')"
              @click="forgetNote(r)"
            />
          </div>
        </div>
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

    <!-- Passphrase (lock / unlock / rotate / open / encrypt) -->
    <LocalPassphraseModal
      v-model:open="showModal"
      :mode="modalMode"
      :path="modalPath"
      :name="modalName"
      :min-len="policy.passphraseMinLen"
      :action="modalAction"
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

    <!-- Unsaved-changes confirm (leaving the editor) -->
    <OyaModal :open="discardAction !== null" @close="discardAction = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="triangle-exclamation" />{{ $t('local.unsavedTitle') }}
        </p>
        <p class="text-sm opacity-80">{{ $t('local.unsavedBody', { name: note?.name }) }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="discardAction = null">
            {{ $t('local.keepEditing') }}
          </OyaButton>
          <OyaButton @click="confirmDiscard">
            <font-awesome-icon icon="xmark" /> {{ $t('local.discard') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>
  </div>
</template>
