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
// Open dialog, a Files-panel row, a notes-search hit — ends in `show`, which
// asks `kindForFile` (../files/openWith) and mounts that editor. New is the one
// place a kind is chosen by hand, because a file that does not exist yet has
// nothing to be read from.
//
// With no file open there is no editor at all, only the start screen: the
// app does not pretend an untitled document of some default kind exists.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ModalPanel from "petalite/ModalPanel.vue";
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
import { isImageName } from "petalite/files";
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
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, filters: openFilters() });
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
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ defaultPath: name.value, filters: saveFilters() });
  if (!picked) return false;
  path.value = picked;
  name.value = picked.split("/").pop() ?? picked;
  return writeTo(picked, text);
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
 *  the file back where it came from. The panel reads inside the folder the
 *  user picked, and the dialog plugin's grant for that folder covers the
 *  write too. */
function openLocal(fileName: string, filePath: string, text: string) {
  show(fileName, filePath, text);
}

defineExpose({
  newFile, openFile, saveFile, saveAs, exports, openLocal,
  name, dirty, busy, canSave, hasFile, notice, fileError,
});

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <input ref="browserInput" type="file" :accept="acceptAttr" class="hidden" @change="onBrowserFile" />

    <!-- No file: no editor, only the ways to get one. -->
    <StartView v-if="kind === null" :busy="busy" class="min-h-0 flex-1"
               @new="newFile" @open="openFile" @search="emit('search')" />

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
