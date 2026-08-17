<script setup lang="ts">
// The file's owner — enigma's LocalPanel role, without the vault. Opens and
// writes files, prompts before discarding, and mounts the editor. Editors
// implement the contract in ../editors/types.ts and never touch disk.
//
// ONE INSTANCE PER TAB, each pinned to a `kind`. The tab decides which editor
// this is, not the file: a Sheets tab opens sheets, and a document dropped into
// it is refused by the editor with the plain-text offer rather than silently
// switching the tab into something else. That is the difference between an
// app with a Sheets tab and an app with a generic "open anything" window, and
// it is why `kind` is a prop rather than sniffed from the filename.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import OyaButton from "rakotis/components/primitives/OyaButton.vue";
import OyaModal from "rakotis/components/primitives/OyaModal.vue";
import ModalPanel from "../components/ModalPanel.vue";
import { useI18n } from "vue-i18n";
import SketchEditor from "../editors/SketchEditor.vue";
import TextEditor from "../editors/TextEditor.vue";
import DocumentEditor from "../editors/DocumentEditor.vue";
import PresentationEditor from "../editors/PresentationEditor.vue";
import SheetEditor from "../editors/SheetEditor.vue";
import type { EditorHandle } from "../editors/types";
import { useCloudFiles, describe } from "../files/useCloudFiles";
import { ApiFailure } from "../api/errors";
import { dumps, newDocument } from "../formats/document";
import { dumps as dumpsDeck, newPresentation } from "../formats/presentation";
import { dumps as dumpsSheet, newWorkbook } from "../formats/sheet";
import { KIND_FILES, type EditorKind } from "../tabs";

const props = defineProps<{
  kind: EditorKind;
  /** Whether this tab is the one on screen. Defaults true so the host works
   *  standalone; App always passes it. See onKey for why it matters. */
  active?: boolean;
}>();

const { t } = useI18n({ useScope: "global" });

/** The new-file seed for this tab's kind. Structured kinds are seeded rather
 *  than left empty because their editors parse on open — a blank buffer would
 *  arrive as "not a document". */
function seedFor(k: EditorKind): { name: string; text: string } {
  const spec = KIND_FILES[k];
  const name = t(spec.untitledKey);
  switch (k) {
    case "document": return { name, text: dumps(newDocument("")) };
    case "deck":     return { name, text: dumpsDeck(newPresentation("")) };
    case "sheet":    return { name, text: dumpsSheet(newWorkbook("New sheet")) };
    case "sketch":   return { name, text: "" }; // the SVG editor starts from empty
  }
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Only used by the browser build's download fallback — a Tauri save writes the
 *  path the dialog returned and never needs a type. */
const MIME: Record<EditorKind, string> = {
  sketch: "image/svg+xml",
  document: "application/xml",
  deck: "application/xml",
  sheet: "application/json",
};

// ── the open file ───────────────────────────────────────────────────────────
const cloudFiles = useCloudFiles();

const path = ref<string | null>(null); // null until first Save As
/** Where this buffer came from, when it came from the vault. `baseHash` is the
 *  state it was read at: the save sends it back so the server can refuse an
 *  overwrite of work done meanwhile, rather than silently winning. */
const remote = ref<{ key: string; baseHash: string } | null>(null);
// Seeded from THIS TAB's kind, not a default: a Write tab that opened showing
// `untitled.svg` with an empty buffer would hand its editor a file it refuses.
const initial = seedFor(props.kind);
const name = ref(initial.name);
const content = ref(initial.text);
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

/** This tab's editor, unless its editor refused the file and the user asked to
 *  see it as plain text. */
const kind = computed<EditorKind | "text">(() => (forceText.value ? "text" : props.kind));

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
function show(fileName: string, filePath: string | null, text: string) {
  // Cleared FIRST: every other open path funnels through here, and a stale
  // origin surviving one would write the new file over the old one's vault row.
  remote.value = null;
  path.value = filePath;
  name.value = fileName;
  content.value = text;
  forceText.value = false;
  dirty.value = false;
  fileError.value = "";
  notice.value = "";
  generation.value++;
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  const seed = seedFor(props.kind);
  show(seed.name, null, seed.text);
}

const browserInput = ref<HTMLInputElement | null>(null);

/** This tab's own extensions first, then an escape hatch. A tab that offered
 *  every type would invite opening a deck in Sheets, which the editor would
 *  then have to refuse — better to make the common case the easy one. */
function dialogFilters() {
  const spec = KIND_FILES[props.kind];
  return [
    { name: t(spec.filterKey), extensions: spec.extensions },
    { name: "All", extensions: ["*"] },
  ];
}

/** `accept` for the browser build's file input, from the same source. */
const acceptAttr = computed(() =>
  KIND_FILES[props.kind].extensions.map((e) => `.${e}`).join(","));

async function openFile() {
  if (!(await confirmDiscard())) return;
  fileError.value = "";
  if (!isTauri) {
    browserInput.value?.click();
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, filters: dialogFilters() });
    if (typeof picked !== "string") return;
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    show(picked.split("/").pop() ?? picked, picked, await readTextFile(picked));
  } catch (err) {
    fileError.value = `${t("file.openFailed")} ${(err as Error)?.message ?? err}`;
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
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(target, text);
    editorRef.value?.markSaved();
    dirty.value = false;
    notice.value = t("file.saved");
    return true;
  } catch (err) {
    fileError.value = `${t("file.saveFailed")} ${(err as Error)?.message ?? err}`;
    return false;
  }
}

async function saveAs(): Promise<boolean> {
  const text = editorRef.value?.getContent() ?? content.value;
  if (!isTauri) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: MIME[props.kind] }));
    a.download = name.value;
    a.click();
    URL.revokeObjectURL(a.href);
    editorRef.value?.markSaved();
    dirty.value = false;
    notice.value = t("file.saved");
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ defaultPath: name.value, filters: dialogFilters() });
  if (!picked) return false;
  path.value = picked;
  name.value = picked.split("/").pop() ?? picked;
  return writeTo(picked, text);
}

async function saveFile(text?: string) {
  if (busy.value) return;
  busy.value = true;
  fileError.value = "";
  notice.value = "";
  try {
    const body = text ?? editorRef.value?.getContent() ?? content.value;
    if (remote.value) await saveToVault(body);
    else if (path.value === null) await saveAs();
    else await writeTo(path.value, body);
  } finally {
    busy.value = false;
  }
}

/** A never-saved file is always savable; an existing one only when changed. */
const canSave = computed(() => !busy.value && (dirty.value || path.value === null));

// ── keyboard: only what is the FILE's, not the buffer's ─────────────────────
function onKey(e: KeyboardEvent) {
  // Every visited tab stays MOUNTED (that is the point — a half-written
  // document must survive a tab switch), so every one of them has a live
  // window listener. Without this gate a single Ctrl+O opens one file dialog
  // per visited tab.
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
/** The mounted editor's optional extra command, if it offers one. */
const exportLabelKey = computed(() =>
  (editorRef.value as { exportLabelKey?: string } | null)?.exportLabelKey ?? "");

function exportFile() {
  (editorRef.value as { exportFile?: () => void } | null)?.exportFile?.();
}

/** Open a buffer that did not come from this machine's filesystem — a vault
 *  file. `path` stays null (there is no local file behind it) and `remote`
 *  carries the vault identity instead, so Save writes back to the vault.
 *
 *  Without an `origin` this stays a read-only-ish buffer whose Save is a Save
 *  As to disk — which is what it was for every vault file until the server
 *  grew a lock check and a content-hash precondition on its content endpoint.
 *  Before that, saving here was a last-writer-wins clobber. */
function openRemote(
  fileName: string, text: string, origin?: { key: string; baseHash: string },
) {
  show(fileName, null, text);
  remote.value = origin ?? null;
  dirty.value = !origin;   // a vault file opens clean; it is already saved
}

/** Write the buffer back to the vault file it came from. */
async function saveToVault(body: string): Promise<void> {
  const origin = remote.value;
  if (!origin) return;
  try {
    const saved = await cloudFiles.save(origin.key, body, origin.baseHash);
    // The state the NEXT save will be based on. Not refreshing this is how a
    // client ends up conflicting with its own previous save.
    origin.baseHash = await freshHash(origin.key);
    name.value = saved.title || name.value;
    editorRef.value?.markSaved();
    dirty.value = false;
    notice.value = t("file.savedToCloud");
  } catch (err) {
    if (err instanceof ApiFailure && err.error.kind === "conflict") {
      // The server kept our text as a version, so nothing is lost — but this
      // buffer is still the only editable copy, so it stays dirty.
      fileError.value = t("file.cloudConflict");
      return;
    }
    if (err instanceof ApiFailure && err.error.kind === "locked") {
      fileError.value = t("file.cloudLocked", { holder: err.error.holder });
      return;
    }
    fileError.value = describe(err);
  }
}

/** Re-read just the hash after a save. The PUT returns the file dict, which
 *  carries size and type but not the content hash. */
async function freshHash(key: string): Promise<string> {
  try {
    return (await cloudFiles.open({ key } as never)).content_hash;
  } catch {
    return "";   // next save falls back to an unconditional write
  }
}

defineExpose({
  newFile, openFile, saveFile, saveAs, exportFile, exportLabelKey, openRemote,
  name, dirty, busy, canSave, notice, fileError, remote,
});

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <input ref="browserInput" type="file" :accept="acceptAttr" class="hidden" @change="onBrowserFile" />

    <!-- keyed by generation: a fresh file gets a fresh editor instance -->
    <SketchEditor
      v-if="kind === 'sketch'"
      :key="generation"
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

    <OyaModal :open="discardOpen" @close="answerDiscard(false)">
      <ModalPanel>
        <p class="text-sm font-semibold">{{ t("file.discardTitle") }}</p>
        <p class="text-sm opacity-70">{{ t("file.discardBody") }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="answerDiscard(false)">{{ t("common.cancel") }}</OyaButton>
          <OyaButton @click="answerDiscard(true)">{{ t("file.discardConfirm") }}</OyaButton>
        </div>
      </ModalPanel>
    </OyaModal>
  </div>
</template>
