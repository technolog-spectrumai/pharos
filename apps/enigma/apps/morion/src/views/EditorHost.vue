<script setup lang="ts">
// The file's owner — enigma's LocalPanel role, without the vault. Opens and
// writes files, prompts before discarding, and mounts the editor. Editors
// implement the contract in ../editors/types.ts and never touch disk.
//
// Every file this host holds lives on THIS MACHINE. The platform half — a
// buffer that remembered which vault row it came from and saved itself back
// there — is parked in limbo/cloud; see its LIMBO.md before reviving a save
// path that talks to a server.
//
// ONE INSTANCE FOR THE APP, and the FILE decides which editor it mounts. It
// used to be one host per tab, each pinned to a kind by a prop, so the user
// had to pick the right tab before opening anything. Now every way in — the
// Open dialog, a Files-panel row, a search hit — ends in `show`, which
// asks `kindForFile` (../files/openWith) and mounts that editor. New is the one
// place a kind is chosen by hand, because a file that does not exist yet has
// nothing to be read from.
//
// With no file open there is no editor at all, only the start screen: the
// app does not pretend an untitled document of some default kind exists.
//
// ENCRYPTED FILES open here too. Rust decrypts one into memory under a
// session (src-tauri/src/sealed.rs) and this host keeps only the token; every
// save of that file goes back through the session, so the disk never sees
// plaintext. The passphrase is asked for by padova's modal, handed to Rust
// once, and not kept. The shield in the header reads `isSealed` from here.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ModalPanel from "petalite/ModalPanel.vue";
import LockModal from "padova/LockModal.vue";
import { lockErrorKey, passphraseStatus, rememberPassphrase, sealFile, unsealFile } from "padova";
import { rekeyFile, sealedClose, sealedOpen, sealedOpenBytes, sealedWrite } from "../security/sealed";
import ManaCost from "../security/ManaCost.vue";
import { askMana, formatMana, manaRate, manaRecord, refreshMana } from "../security/mana";
import { useI18n } from "vue-i18n";
import TextEditor from "../editors/TextEditor.vue";
import DocumentEditor from "../editors/DocumentEditor.vue";
import PresentationEditor from "../editors/PresentationEditor.vue";
import SheetEditor from "../editors/SheetEditor.vue";
import SketchEditor from "../editors/SketchEditor.vue";
import StartView from "./StartView.vue";
import type { EditorHandle } from "../editors/types";
import { dumps, newDocument } from "../formats/document";
import { dumps as dumpsDeck, newPresentation } from "../formats/presentation";
import { dumps as dumpsSheet, newWorkbook } from "../formats/sheet";
import { ALL_EXTENSIONS, KIND_FILES, type EditorKind } from "../kinds";
import { kindForFile } from "../files/openWith";
import { dialogErrorKey, errorText, fsErrorKey, readText, writeText } from "../files/fs";
import { isImageName, toDataUri, useWorkspace } from "petalite/files";
import { OyaButton, OyaModal } from "petalite/primitives";

const props = defineProps<{
  /** Whether the editor is the view on screen (not Security or Settings).
   *  Defaults true so the host works standalone; App always passes it. See
   *  onKey for why it matters. */
  active?: boolean;
}>();

const emit = defineEmits<{
  /** The start screen's "Search notes" — the search box lives in the files
   *  panel, which is App's to show. */
  search: [];
}>();

const { t } = useI18n({ useScope: "global" });

/** The workspace: where Open looks, where Save As offers to write, and the
 *  boundary Rust holds every read and write to. Without one there is nothing
 *  to open from or save into, and the commands say so. */
const workspace = useWorkspace();
const hasWorkspace = computed(() => Boolean(workspace.root.value));

/** A Rust refusal as a sentence: a known prefix through the catalogue, anything
 *  else (a filesystem message) as it came. */
function explain(err: unknown): string {
  const message = errorText(err);
  const key = fsErrorKey(message) ?? lockErrorKey(message);
  return key ? t(key) : message;
}

/** For an action run inside padova's passphrase dialog, which only knows the
 *  sealing sentences: a workspace refusal ("not a text file", "outside the
 *  workspace") is turned into its own sentence here, so the dialog shows that
 *  rather than raw Rust or a sealing sentence that does not fit. */
function inDialog(err: unknown, mode: "lock" | "unlock" | "open"): unknown {
  const key = dialogErrorKey(errorText(err), mode);
  return key ? new Error(t(key)) : err;
}

/** The new-file seed for a kind. Structured kinds are seeded rather than left
 *  empty because their editors parse on open — a blank buffer would arrive as
 *  "not a document". */
function seedFor(k: EditorKind): { name: string; text: string } {
  const spec = KIND_FILES[k];
  const name = t(spec.untitledKey);
  switch (k) {
    case "document": return { name, text: dumps(newDocument("")) };
    case "deck":     return { name, text: dumpsDeck(newPresentation("")) };
    case "code":     return { name, text: "" }; // ACE parses nothing on open
    case "markdown": return { name, text: "" };
    case "sheet":    return { name, text: dumpsSheet(newWorkbook(name.replace(/\.[^.]+$/, ""))) };
    case "sketch":   return { name, text: "" }; // the editor starts a blank board
  }
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Only used by the browser build's download fallback — a Tauri save writes the
 *  path the dialog returned and never needs a type. */
const MIME: Record<EditorKind, string> = {
  document: "application/xml",
  deck: "application/xml",
  code: "text/plain",
  markdown: "text/markdown",
  sheet: "application/json",
  sketch: "image/svg+xml",
};

// ── the open file ───────────────────────────────────────────────────────────
/** Which editor the open file asked for; null while no file is open. Set only
 *  by `show`, so the kind can never drift from the file it describes. */
const fileKind = ref<EditorKind | null>(null);
const path = ref<string | null>(null); // null until first Save As
const name = ref("");
const content = ref("");
/** Bumped on every open so the editor remounts with fresh state — an editor's
 *  buffer belongs to ONE file; reusing an instance across files would carry
 *  undo history and dirt from the last one. */
const generation = ref(0);

const busy = ref(false);
const fileError = ref("");
const notice = ref("");
const dirty = ref(false);

/** One loosely-held ref serves every editor — that is what the shared contract
 *  buys, and why an editor must not invent its own interface. */
const editorRef = ref<EditorHandle | null>(null);

/** Set when a .svg refused the visual editor and the user chose "open as
 *  text" — forces ACE for that one open, without renaming the file. */
const forceText = ref(false);

// ── encryption ──────────────────────────────────────────────────────────────
/** The Rust session holding this file's key, while an encrypted text file is
 *  open. Null for a plain file. */
const sealedToken = ref<number | null>(null);
/** An encrypted picture, shown from memory: no session, nothing to save. */
const sealedImage = ref(false);
/** The file was encrypted on disk while it was open here — from its row in
 *  the pane, or by a folder run. The buffer is still the plaintext; the next
 *  save asks for the passphrase and writes it back encrypted. */
const sealedPending = ref(false);
/** Whether the open file is encrypted on disk. */
const isSealed = computed(() => sealedToken.value !== null || sealedImage.value || sealedPending.value);
/** Whether the file exists on disk at all — a never-saved file cannot be
 *  encrypted yet. */
const hasPath = computed(() => path.value !== null);

function dropSession() {
  const token = sealedToken.value;
  sealedToken.value = null;
  sealedImage.value = false;
  sealedPending.value = false;
  if (token !== null) void sealedClose(token).catch(() => undefined);
}

// The passphrase prompt: one modal, four uses (open into memory, encrypt,
// decrypt permanently, change the passphrase). The action it runs is set per
// use; the passwords it collects go to that action and nowhere else.
type LockMode = "lock" | "unlock" | "open" | "rekey";
type LockAction = (password: string, remember: boolean, next?: string) => Promise<void>;
const lockOpen = ref(false);
const lockMode = ref<LockMode>("open");
const lockName = ref("");
const lockAction = ref<LockAction>(async () => undefined);
/** What the act does to Security Mana, shown inside the passphrase modal —
 *  one dialog, not two. */
const lockRate = ref<{ perHour: number; direction: "adds" | "saves" } | null>(null);
const lockConsequence = ref("");
/** Resolves when the modal closes, with whether the action ran. */
let lockSettle: ((ok: boolean) => void) | null = null;

function askPassphrase(mode: LockMode, fileName: string, action: LockAction,
                       rate: { perHour: number; direction: "adds" | "saves" } | null = null,
                       consequence = ""): Promise<boolean> {
  lockRate.value = rate;
  lockConsequence.value = consequence;
  lockMode.value = mode;
  lockName.value = fileName;
  lockAction.value = action;
  lockOpen.value = true;
  return new Promise((resolve) => { lockSettle = resolve; });
}
function lockDone(ran: boolean) {
  lockOpen.value = false;
  lockSettle?.(ran);
  lockSettle = null;
}

/** Whether a passphrase is remembered, so a file can be opened without
 *  asking. Off the desktop, or if the question fails, the answer is no. */
async function remembered(): Promise<boolean> {
  try {
    return (await passphraseStatus()).remembered;
  } catch {
    return false;
  }
}

/** Decrypt into memory and show. `password` null uses the remembered one. */
async function adoptSealed(fileName: string, filePath: string, password: string | null) {
  if (isImageName(fileName)) {
    const bytes = await sealedOpenBytes(filePath, password);
    show(fileName, filePath, toDataUri(fileName, bytes));
    sealedImage.value = true;
    return;
  }
  const opened = await sealedOpen(filePath, password);
  show(fileName, filePath, opened.text);
  sealedToken.value = opened.token;
}

/** The pane changed a file's encryption behind this host's back (a row
 *  shield, a folder run). Ask the disk again about the open file and follow
 *  it: decrypted there means the session goes and saves are plain; encrypted
 *  there means the next save asks for the passphrase. The buffer is never
 *  replaced — unsaved edits survive either way. */
async function resync(): Promise<void> {
  const target = path.value;
  if (target === null || !hasFile.value) return;
  await workspace.reprobe(target);
  const onDisk = workspace.isSealed(target);
  const held = sealedToken.value !== null || sealedImage.value;
  if (!onDisk) {
    // Plain on disk: whatever this host thought — a session, a picture, or
    // "encrypted while open" — the file is plain now, and so are its saves.
    if (held || sealedPending.value) dropSession();
  } else if (!held) {
    if (readOnly.value) sealedImage.value = true;
    else sealedPending.value = true;
  }
}

/** The key for saving a file that was encrypted while open. Not a new
 *  exposure — the plaintext is already on screen — so it costs no Mana. */
async function adoptSessionForSave(target: string): Promise<boolean> {
  const take = async (password: string | null) => {
    const opened = await sealedOpen(target, password);
    sealedToken.value = opened.token;
    sealedPending.value = false;
  };
  if (await remembered()) {
    try {
      await take(null);
      return true;
    } catch (err) {
      if (!/^(wrong_password|no_passphrase)/.test(errorText(err))) throw err;
    }
  }
  return askPassphrase("open", name.value, async (password, remember) => {
    try {
      await take(password);
    } catch (err) {
      throw inDialog(err, "open");
    }
    if (remember) await rememberPassphrase(password);
  }, null, "shield.encryptedWhileOpen");
}

/** Open an encrypted file: with the remembered passphrase if there is one,
 *  otherwise by asking. The file on disk stays encrypted throughout, so it
 *  costs no Security Mana — Mana is spent by plain files on disk, not by what
 *  is on screen. */
async function openSealed(fileName: string, filePath: string, confirmed = false): Promise<boolean> {
  if (!confirmed && !(await confirmDiscard())) return false;
  fileError.value = "";
  if (await remembered()) {
    try {
      await adoptSealed(fileName, filePath, null);
      return true;
    } catch (err) {
      // The remembered passphrase is not this file's: ask. Anything else is
      // a real refusal and is reported.
      if (!/^(wrong_password|no_passphrase)/.test(errorText(err))) {
        fileError.value = `${t("file.openFailed")} ${explain(err)}`;
        return false;
      }
    }
  }
  return askPassphrase("open", fileName, async (password, remember) => {
    try {
      await adoptSealed(fileName, filePath, password);
    } catch (err) {
      throw inDialog(err, "open");
    }
    if (remember) await rememberPassphrase(password);
  });
}

/** Encrypt the open file on disk with a passphrase, and keep editing it
 *  through a session. Needs a saved, clean file: the bytes on disk are what
 *  get encrypted, and an unsaved edit would be silently left out. */
async function encryptFile(): Promise<boolean> {
  const target = path.value;
  if (target === null || dirty.value || isSealed.value) return false;
  fileError.value = "";
  const rate = await manaRate(target);
  return askPassphrase("lock", name.value, async (password, remember) => {
    try {
      await sealFile(target, password);
    } catch (err) {
      throw inDialog(err, "lock");
    }
    // The file IS encrypted from here on. Keep editing it through a session;
    // if that cannot be had now, the next save asks for the passphrase —
    // either way the dialog must not report a failure that did not happen.
    if (readOnly.value) {
      sealedImage.value = true;
    } else {
      try {
        const opened = await sealedOpen(target, password);
        sealedToken.value = opened.token;
      } catch {
        sealedPending.value = true;
      }
    }
    if (remember) await rememberPassphrase(password);
    await workspace.reprobe(target);
    // Encrypting earns nothing: it stops this file's drain, and it is kept
    // in the history.
    await manaRecord("encrypt_file", target);
    await refreshMana();
  }, rate ? { perHour: rate.plainPerHour, direction: "saves" } : null);
}

/** Decrypt the open file on disk, permanently. The buffer is already the
 *  plaintext, so nothing reloads: the session is dropped and saves go plain. */
async function decryptFile(): Promise<boolean> {
  const target = path.value;
  if (target === null || dirty.value || !isSealed.value) return false;
  fileError.value = "";
  const finish = async () => {
    dropSession();
    await workspace.reprobe(target);
    await manaRecord("decrypt_file", target);
    await refreshMana();
  };
  // What the plain file will cost an hour, said before it is written. When
  // Rust cannot say (no workspace, off the desktop), a remembered passphrase
  // decrypts without a word, as it always did.
  const adds = (await manaRate(target))?.sealedPerHour ?? null;
  if (await remembered()) {
    if (adds !== null && !(await askMana(name.value, "mana.consequence.decrypt_file", adds))) return false;
    try {
      await unsealFile(target, null);
      await finish();
      return true;
    } catch (err) {
      if (!/^(wrong_password|no_passphrase)/.test(errorText(err))) {
        fileError.value = explain(err);
        return false;
      }
    }
  }
  return askPassphrase("unlock", name.value, async (password, remember) => {
    try {
      await unsealFile(target, password);
    } catch (err) {
      throw inDialog(err, "unlock");
    }
    await finish();
    // Remembered only once it proved to be this file's passphrase.
    if (remember) await rememberPassphrase(password);
  }, adds === null ? null : { perHour: adds, direction: "adds" }, "mana.consequence.decrypt_file");
}

/** Change the open encrypted file's passphrase. Rust re-encrypts it on disk
 *  under a new key and moves this host's session along with it, so saves
 *  carry on and the buffer — unsaved edits too — is never touched. It earns
 *  Security Mana, which the notice beside the file name says. */
async function changePassphrase(): Promise<boolean> {
  const target = path.value;
  if (target === null || !isSealed.value) return false;
  fileError.value = "";
  return askPassphrase("rekey", name.value, async (password, remember, next) => {
    if (!next) return;
    let gained = 0;
    try {
      ({ gained } = await rekeyFile(target, password, next));
    } catch (err) {
      throw inDialog(err, "open");
    }
    if (remember) await rememberPassphrase(next);
    await refreshMana();
    notice.value = gained > 0 ? t("mana.rekeyEarned", { gained: formatMana(gained) }) : t("mana.rekeyNoReward");
  });
}

/** The file's editor, unless that editor refused it and the user asked to see
 *  it as plain text; null is the start screen. */
const kind = computed<EditorKind | "text" | null>(() =>
  fileKind.value === null ? null : forceText.value ? "text" : fileKind.value);

/** Whether a file — saved or not — is open. */
const hasFile = computed(() => fileKind.value !== null);

function openAsText() {
  forceText.value = true;
  generation.value++;
}

// ── discard guard ───────────────────────────────────────────────────────────
const discardOpen = ref(false);
let discardResolve: ((ok: boolean) => void) | null = null;

function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) return Promise.resolve(true);
  discardOpen.value = true;
  return new Promise((resolve) => { discardResolve = resolve; });
}
function answerDiscard(ok: boolean) {
  discardOpen.value = false;
  discardResolve?.(ok);
  discardResolve = null;
}

// ── open / new ──────────────────────────────────────────────────────────────
/** The one way a file reaches an editor. `as` is only given by New; every
 *  opened file is routed by its name and bytes. */
function show(fileName: string, filePath: string | null, text: string,
              as: EditorKind = kindForFile(fileName, text) ?? "code") {
  dropSession();
  fileKind.value = as;
  path.value = filePath;
  name.value = fileName;
  content.value = text;
  forceText.value = false;
  dirty.value = false;
  fileError.value = "";
  notice.value = "";
  generation.value++;
}

/** New file of a chosen kind — the one place the user names the editor. */
async function newFile(k: EditorKind) {
  if (!(await confirmDiscard())) return;
  const seed = seedFor(k);
  show(seed.name, null, seed.text, k);
}

const browserInput = ref<HTMLInputElement | null>(null);

/** Open offers everything some editor reads, then an escape hatch — there is
 *  no "which editor" to narrow by, the file decides that after it is picked. */
function openFilters() {
  return [
    { name: t("file.supported"), extensions: [...ALL_EXTENSIONS] },
    { name: "All", extensions: ["*"] },
  ];
}

/** Save As offers the open file's own kind first: a Markdown note saved from
 *  here should be offered `.md`, not the union. */
function saveFilters() {
  const spec = KIND_FILES[fileKind.value ?? "code"];
  return [
    { name: t(spec.filterKey), extensions: spec.extensions },
    { name: "All", extensions: ["*"] },
  ];
}

/** `accept` for the browser build's file input, from the same source. */
const acceptAttr = ALL_EXTENSIONS.map((e) => `.${e}`).join(",");

async function openFile() {
  if (!(await confirmDiscard())) return;
  fileError.value = "";
  if (!isTauri) {
    browserInput.value?.click();
    return;
  }
  if (!hasWorkspace.value) {
    fileError.value = t("workspace.errors.no_workspace");
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    // The dialog opens on the workspace; a file picked elsewhere is refused by
    // Rust, which is the boundary, not the dialog.
    const picked = await open({ multiple: false, defaultPath: workspace.root.value, filters: openFilters() });
    if (typeof picked !== "string") return;
    const fileName = picked.split("/").pop() ?? picked;
    try {
      show(fileName, picked, await readText(picked));
    } catch (err) {
      // Encrypted: the same file, through the passphrase. The discard
      // question was already answered above.
      if (!/^locked/.test(errorText(err))) throw err;
      await openSealed(fileName, picked, true);
    }
  } catch (err) {
    fileError.value = `${t("file.openFailed")} ${explain(err)}`;
  }
}

async function onBrowserFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  // A browser File has no path; saving becomes a download.
  show(file.name, null, await file.text());
}

// ── save ────────────────────────────────────────────────────────────────────
async function writeTo(target: string, text: string): Promise<boolean> {
  try {
    // Encrypted while it was open: get its key first, or write nothing — and
    // say so, rather than leaving a save that silently did not happen.
    if (sealedPending.value && !(await adoptSessionForSave(path.value ?? target))) {
      fileError.value = t("shield.saveCancelled");
      return false;
    }
    // An encrypted file goes back through its session and is re-sealed in
    // Rust; a plain one is written as it is.
    if (sealedToken.value !== null) await sealedWrite(sealedToken.value, target, text);
    else await writeText(target, text);
    editorRef.value?.markSaved();
    dirty.value = false;
    notice.value = t("file.saved");
    return true;
  } catch (err) {
    fileError.value = `${t("file.saveFailed")} ${explain(err)}`;
    return false;
  }
}

async function saveAs(): Promise<boolean> {
  if (!hasFile.value || readOnly.value) return false;
  const text = editorRef.value?.getContent() ?? content.value;
  if (!isTauri) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: MIME[fileKind.value ?? "code"] }));
    a.download = name.value;
    a.click();
    URL.revokeObjectURL(a.href);
    editorRef.value?.markSaved();
    dirty.value = false;
    notice.value = t("file.saved");
    return true;
  }
  if (!hasWorkspace.value) {
    fileError.value = t("workspace.errors.no_workspace");
    return false;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  // Offered where the file is, or in the workspace root for one never saved.
  const defaultPath = path.value ?? `${workspace.root.value}/${name.value}`;
  const picked = await save({ defaultPath, filters: saveFilters() });
  if (!picked) return false;
  const ok = await writeTo(picked, text);
  if (ok) {
    path.value = picked;
    name.value = picked.split("/").pop() ?? picked;
  }
  return ok;
}

async function saveFile(text?: string) {
  if (busy.value || !hasFile.value || readOnly.value) return;
  busy.value = true;
  fileError.value = "";
  notice.value = "";
  try {
    const body = text ?? editorRef.value?.getContent() ?? content.value;
    if (path.value === null) await saveAs();
    else await writeTo(path.value, body);
  } finally {
    busy.value = false;
  }
}

/** A picture is SHOWN, not held — there is no buffer behind it, only the bytes
 *  that were read. Saving would write the `data:` URI out as text, which is a
 *  corrupt copy of the file it came from, so the whole save path is closed for
 *  one. The editor asks the same function about the same name, so the view and
 *  this cannot disagree about what is on screen. */
const readOnly = computed(() => isImageName(name.value));

/** A never-saved file is always savable; an existing one only when changed;
 *  no file, nothing to save. */
const canSave = computed(() =>
  hasFile.value && !busy.value && !readOnly.value && (dirty.value || path.value === null));

// ── keyboard: only what is the FILE's, not the buffer's ─────────────────────
function onKey(e: KeyboardEvent) {
  // The host stays MOUNTED while Security or Settings is on screen (that is
  // the point — a half-written document must survive a look at Settings), so
  // its window listener is live there too. Ctrl+O from Settings is not a
  // request to open a file behind it.
  if (props.active === false) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void openFile();
  }
}
/** The file commands, for the app menu. The host owns the file — which path it
 *  came from, whether it is dirty, whether a write is in flight — so the menu
 *  asks it rather than keeping a second copy of any of that. */
/** The mounted editor's extra file commands, if it offers any. Read off the
 *  editor rather than declared per kind: the editor knows what it can make. */
const exports = computed(() =>
  (editorRef.value as { exports?: Array<{ labelKey: string; icon: string; run: () => void }> } | null)
    ?.exports ?? []);

/** Open a file the Files panel — a clicked row or a search hit — handed over
 *  rather than the Open dialog.
 *
 *  It ends in the same `show` the dialog does, path included, so Save writes
 *  the file back where it came from, through the same Rust workspace
 *  boundary that read it. */
function openLocal(fileName: string, filePath: string, text: string) {
  show(fileName, filePath, text);
}

defineExpose({
  newFile, openFile, saveFile, saveAs, exports, openLocal, openSealed, encryptFile, decryptFile, changePassphrase, resync,
  name, path, generation, dirty, busy, canSave, hasFile, hasPath, hasWorkspace, isSealed, notice, fileError,
});

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  dropSession();
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <input ref="browserInput" type="file" :accept="acceptAttr" class="hidden" @change="onBrowserFile" />

    <!-- No file: no editor, only the ways to get one. -->
    <StartView v-if="kind === null" :busy="busy" :workspace="workspace.root.value" class="min-h-0 flex-1"
               @new="newFile" @open="openFile" @search="emit('search')"
               @pick-workspace="workspace.pickRoot()" />

    <!-- keyed by generation: a fresh file gets a fresh editor instance -->

    <DocumentEditor
      v-if="kind === 'document'"
      :key="'d' + generation"
      ref="editorRef"
      :path="path"
      :name="name"
      :content="content"
      :busy="busy"
      :error="fileError"
      :active="active !== false"
      class="min-h-0 flex-1"
      @save="saveFile($event)"
      @update:dirty="dirty = $event"
      @open-as-text="openAsText"
    />

    <PresentationEditor
      v-if="kind === 'deck'"
      :key="'p' + generation"
      ref="editorRef"
      :path="path"
      :name="name"
      :content="content"
      :busy="busy"
      :error="fileError"
      :active="active !== false"
      class="min-h-0 flex-1"
      @save="saveFile($event)"
      @update:dirty="dirty = $event"
      @open-as-text="openAsText"
    />


    <TextEditor
      v-if="kind === 'code'"
      :key="'c' + generation"
      ref="editorRef"
      :path="path"
      :name="name"
      :content="content"
      :busy="busy"
      :error="fileError"
      :active="active !== false"
      with-picker
      class="min-h-0 flex-1"
      @save="saveFile($event)"
      @update:dirty="dirty = $event"
    />

    <!-- A drawing — plain SVG. Its toolbar is the engine's; PNG export reaches
         the app menu through the editor's `exports`. A file it cannot open
         safely is refused with the offer to open it as text. -->
    <SketchEditor
      v-if="kind === 'sketch'"
      :key="'k' + generation"
      ref="editorRef"
      :path="path"
      :name="name"
      :content="content"
      :busy="busy"
      :error="fileError"
      :active="active !== false"
      class="min-h-0 flex-1"
      @save="saveFile($event)"
      @update:dirty="dirty = $event"
      @open-as-text="openAsText"
    />

    <!-- A Univer workbook. Its toolbar is Univer's own ribbon; CSV export
         reaches the app menu through the editor's `exports`. -->
    <SheetEditor
      v-if="kind === 'sheet'"
      :key="'s' + generation"
      ref="editorRef"
      :path="path"
      :name="name"
      :content="content"
      :busy="busy"
      :error="fileError"
      :active="active !== false"
      class="min-h-0 flex-1"
      @save="saveFile($event)"
      @update:dirty="dirty = $event"
      @open-as-text="openAsText"
    />

    <!-- The same ACE as Code, in the mode the .md name selects, with the
         undo/redo strip but no language picker: a note IS Markdown. -->
    <TextEditor
      v-if="kind === 'markdown'"
      :key="'m' + generation"
      ref="editorRef"
      :path="path"
      :name="name"
      :content="content"
      :busy="busy"
      :error="fileError"
      :active="active !== false"
      toolbar
      class="min-h-0 flex-1"
      @save="saveFile($event)"
      @update:dirty="dirty = $event"
    />

    <TextEditor
      v-if="kind === 'text'"
      :key="'t' + generation"
      ref="editorRef"
      :path="path"
      :name="name"
      :content="content"
      :busy="busy"
      :error="fileError"
      :active="active !== false"
      class="min-h-0 flex-1"
      @save="saveFile($event)"
      @update:dirty="dirty = $event"
    />

    <LockModal :open="lockOpen" :mode="lockMode" :name="lockName" :action="lockAction"
               :offer-remember="isTauri"
               @update:open="(v: boolean) => { if (!v && lockOpen) lockDone(false); }"
               @done="lockDone(true)">
      <template #notice>
        <p v-if="lockConsequence" class="text-xs" data-testid="lock-consequence">{{ t(lockConsequence) }}</p>
        <ManaCost v-if="lockRate" :per-hour="lockRate.perHour" :direction="lockRate.direction" />
      </template>
    </LockModal>

    <OyaModal :open="discardOpen" @close="answerDiscard(false)">
      <ModalPanel>
        <p class="text-sm font-semibold">{{ t("file.discardTitle") }}</p>
        <p class="text-sm opacity-70">{{ t("file.discardBody") }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" data-testid="discard-cancel" @click="answerDiscard(false)">{{ t("common.cancel") }}</OyaButton>
          <OyaButton data-testid="discard-confirm" @click="answerDiscard(true)">{{ t("file.discardConfirm") }}</OyaButton>
        </div>
      </ModalPanel>
    </OyaModal>
  </div>
</template>
