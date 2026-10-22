<script setup lang="ts">
// Local passphrase-protected files. Pick a file and "lock" it: it's encrypted in
// place on the device (opening it normally shows garbage), and unlockable later
// with the same passphrase. Passphrases are never stored — we only keep a record
// of which files are locked (in the encrypted kv store) so we can list them here.
//
// The tab also hosts the notes editor. Opening a file swaps this panel for the
// editor; a locked file is decrypted into memory after a passphrase prompt and
// re-sealed on save, so its plaintext never reaches disk. The passphrase is held
// only while that file is open and is dropped the moment the editor closes.
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue";
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
  getBuildConfig,
  keyringList,
  type KeyringSummary,
  type LockedFileRecord,
  type LockedFileResult,
  type LocalNoteContent,
  type LocalNoteStat,
  type NoteRecentRecord,
  formatDate,
  formatBytes,
} from "rakotis";
import { policy } from "../../config/app";
import LocalPassphraseModal, { type LockOutcome } from "./LocalPassphraseModal.vue";
// ACE is heavy (~1.4 MB of source) and only needed once a file is actually opened, so
// it loads on demand. Still fully offline — the chunk ships in the app bundle.
import type NoteEditorComponent from "./NoteEditor.vue";
const NoteEditor = defineAsyncComponent(() => import("./NoteEditor.vue"));
/** Same treatment as ACE: the drawing engine is its own chunk, loaded only when
 *  a .svg is actually opened. */
const SvgEditor = defineAsyncComponent(() => import("./SvgEditor.vue"));

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
  await refresh();
  if (getBuildConfig().keyring_enabled) {
    availableRings.value = await keyringList().catch(() => []);
  }
});

// ── passphrase modal (lock / unlock / rotate / open / encrypt) ──────────────────
const showModal = ref(false);
const modalMode = ref<"lock" | "unlock" | "rotate" | "open" | "encrypt">("lock");
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
/** The one New-file modal: fresh text, fresh drawing, or open from disk. */
const showNewFile = ref(false);
const newFileName = ref("");
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
  modalRing.value = false;
  modalSize.value = await statLocalNote(path)
    .then((s) => s.size)
    .catch(() => 0);
  showModal.value = true;
}

/** Lock a plain file straight from its recents row — same modal flow as the
 *  toolbar's picker, minus having to re-find the file in a dialog. */
function askLockRecent(rec: NoteRecentRecord) {
  modalMode.value = "lock";
  modalPath.value = rec.path;
  modalName.value = rec.name;
  modalAction.value = undefined;
  modalRing.value = false;
  modalSize.value = rec.size;
  showModal.value = true;
}

function askUnlock(rec: LockedFileRecord) {
  modalMode.value = "unlock";
  modalPath.value = rec.path;
  modalName.value = rec.name;
  modalAction.value = undefined;
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
  modalAction.value = undefined;
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

// ── notes editor ─────────────────────────────────────────────────────────────────
// This panel is either the file list or the editor. The open file's passphrase lives
// in `note` and nowhere else: it's needed on every save (each save re-derives the key
// from the file's current header, so a file re-keyed elsewhere fails closed instead of
// being clobbered), and it's dropped when the editor closes.

interface OpenNote {
  /** Which editor renders this file. Derived from the extension on open; the
   *  rest of this record is deliberately type-agnostic, so the save path,
   *  the passphrase handling and the recents list are shared by both. */
  kind: "text" | "svg";
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
/** Set when a .svg refused the visual editor and the user picked "open as XML" —
 *  it forces the text editor for that one open, without renaming the file. */
const forceText = ref(false);
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
    kind: editorKindFor(read.name),
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
/** Files the visual editor claims. Everything else opens in ACE, which already
 *  syntax-highlights .svg as XML. */
function editorKindFor(name: string): "text" | "svg" {
  return /\.svg$/i.test(name) ? "svg" : "text";
}

async function openPath(path: string) {
  error.value = "";
  forceText.value = false;
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

/** "shopping" → "shopping.txt" / "shopping.svg"; a typed extension is kept. */
function fileNameFor(typed: string, ext: "txt" | "svg"): string {
  const name = typed.trim().replace(/[\\/:]/g, "");
  if (!name) return `untitled.${ext}`;
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}.${ext}`;
}

function newDrawing(typedName = "") {
  note.value = {
    kind: "svg",
    path: null,
    name: fileNameFor(typedName, "svg"),
    locked: false,
    passphrase: null,
    pendingEncrypt: false,
    // Empty: SvgEditor seeds a blank document rather than parsing nothing.
    content: "",
  };
  editorDirty.value = false;
  noteError.value = "";
  forceText.value = false;
  view.value = "editor";
}

/** Fall back to the text editor for a drawing the visual one refused. The file
 *  is untouched — this only changes which component renders this open. */
function openCurrentAsXml() {
  forceText.value = true;
}

function newNote(typedName = "") {
  note.value = {
    kind: "text",
    path: null,
    name: fileNameFor(typedName, "txt"),
    locked: false,
    passphrase: null,
    pendingEncrypt: false,
    content: "",
  };
  editorDirty.value = false;
  noteError.value = "";
  view.value = "editor";
}

/** Remember an encrypted note in the locked-file list too, so it keeps its rotate
 *  action there. Preserves the original lock time if we already knew it. */
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
// The app's one byte formatter, so a size in the Files tab and the same size on a
// map card cannot disagree about the decimal separator.
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

    <template v-else-if="view === 'editor' && note && note.kind === 'svg' && !forceText">
      <SvgEditor
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
        @open-as-xml="openCurrentAsXml"
        @update:dirty="editorDirty = $event"
      />
    </template>

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
          data-testid="new-file"
          @click="newFileName = ''; showNewFile = true"
        >
          <font-awesome-icon icon="plus" /> {{ $t('local.newFile') }}
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
          <!-- Ring files: the editor can't open ENIGRLK and per-file rotation
               doesn't apply (the ring rotates via its change-passphrase). -->
          <OyaIconButton
            v-if="!f.ring"
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
            <!-- Plain files only: a locked one is already in the list above. -->
            <OyaIconButton
              v-if="recentStat[r.path]?.exists !== false && !(recentStat[r.path]?.locked ?? r.locked)"
              size="sm"
              icon="lock"
              :label="$t('local.lockFile')"
              data-testid="recent-lock"
              @click="askLockRecent(r)"
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
    </template>

    <!-- New file: fresh text, fresh drawing, or an existing file from disk. -->
    <OyaModal :open="showNewFile" @close="showNewFile = false">
      <div class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="plus" />
          {{ $t('local.newFile') }}
        </p>
        <p class="text-xs opacity-60">{{ $t('local.newFileHint') }}</p>
        <input
          v-model="newFileName"
          type="text"
          :placeholder="$t('local.fileName')"
          class="w-full rounded-lg border border-accent-2 bg-transparent px-3 py-2 text-sm dark:border-accent-1"
          data-testid="new-file-name"
        />
        <button
          class="flex w-full items-center gap-3 rounded-lg border border-accent-2 px-4 py-3 text-sm font-semibold transition hover:opacity-80 dark:border-accent-1"
          data-testid="new-file-text"
          @click="showNewFile = false; newNote(newFileName)"
        >
          <font-awesome-icon icon="file" class="text-accent-light dark:text-accent-dark" />
          {{ $t('local.newNote') }}
        </button>
        <button
          class="flex w-full items-center gap-3 rounded-lg border border-accent-2 px-4 py-3 text-sm font-semibold transition hover:opacity-80 dark:border-accent-1"
          data-testid="new-file-svg"
          @click="showNewFile = false; newDrawing(newFileName)"
        >
          <font-awesome-icon icon="pencil" class="text-accent-light dark:text-accent-dark" />
          {{ $t('sketch.newDrawing') }}
        </button>
        <button
          class="flex w-full items-center gap-3 rounded-lg border border-accent-2 px-4 py-3 text-sm font-semibold transition hover:opacity-80 dark:border-accent-1"
          data-testid="new-file-open"
          @click="showNewFile = false; openFilePicker()"
        >
          <font-awesome-icon icon="folder-open" class="text-accent-light dark:text-accent-dark" />
          {{ $t('local.openFile') }}
        </button>
      </div>
    </OyaModal>

    <!-- Passphrase (lock / unlock / rotate / open / encrypt) -->
    <LocalPassphraseModal
      v-model:open="showModal"
      :mode="modalMode"
      :path="modalPath"
      :name="modalName"
      :min-len="policy.passphraseMinLen"
      :action="modalAction"
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

    <!-- Unsaved-changes confirm (leaving the editor) -->
    <OyaModal :open="discardAction !== null" @close="discardAction = null">
      <div class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
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
