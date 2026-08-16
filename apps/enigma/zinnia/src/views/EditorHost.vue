<script setup lang="ts">
// The file's owner — enigma's LocalPanel role, without the vault. Opens and
// writes files, prompts before discarding, and mounts whichever editor claims
// the file's extension. Editors implement the contract in ../editors/types.ts
// and never touch disk themselves.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import OyaButton from "rakotis/components/primitives/OyaButton.vue";
import OyaIconButton from "rakotis/components/primitives/OyaIconButton.vue";
import OyaModal from "rakotis/components/primitives/OyaModal.vue";
import { useI18n } from "vue-i18n";
import SketchEditor from "../editors/SketchEditor.vue";
import TextEditor from "../editors/TextEditor.vue";
import DocumentEditor from "../editors/DocumentEditor.vue";
import PresentationEditor from "../editors/PresentationEditor.vue";
import SheetEditor from "../editors/SheetEditor.vue";
import type { EditorHandle } from "../editors/types";
import { dumps, newDocument, sniffIsDocument } from "../formats/document";
import { dumps as dumpsDeck, newPresentation, sniffIsPresentation } from "../formats/presentation";
import { dumps as dumpsSheet, isSheet, newWorkbook } from "../formats/sheet";

const { t } = useI18n({ useScope: "global" });

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ── the open file ───────────────────────────────────────────────────────────
const path = ref<string | null>(null); // null until first Save As
const name = ref(t("file.untitled"));
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

/** Which editor renders this file. The visual editor claims .svg; everything
 *  else opens in ACE, which already highlights .svg as XML. */
function editorKindFor(fileName: string): "sketch" | "text" | "document" | "deck" | "sheet" {
  if (/\.svg$/i.test(fileName)) return "sketch";
  // Documents and decks are both .xml; the extension cannot tell them apart, so
  // the ROOT ELEMENT decides. Sniffing beats a full parse here — the listing
  // would otherwise decode every embedded image just to look at one tag.
  if (/\.xml$/i.test(fileName)) {
    if (sniffIsDocument(content.value)) return "document";
    if (sniffIsPresentation(content.value)) return "deck";
  }
  // A sheet is a Univer snapshot in a .json file. Unlike the XML pair there is
  // no root element to look at, so the sniff has to parse — cheap enough, and
  // it is the same check primula's server makes.
  if (/\.json$/i.test(fileName) && isSheet(content.value)) return "sheet";
  return "text";
}
const kind = computed(() => (forceText.value ? "text" : editorKindFor(name.value)));

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
  path.value = filePath;
  name.value = fileName;
  content.value = text;
  forceText.value = false;
  dirty.value = false;
  fileError.value = "";
  notice.value = "";
  generation.value++;
}

async function newDrawing() {
  if (!(await confirmDiscard())) return;
  show(t("file.untitled"), null, "");
}

async function newDoc() {
  if (!(await confirmDiscard())) return;
  // Seeded with a real document rather than left empty: `editorKindFor` sniffs
  // the CONTENT to tell a cyprian document from any other .xml, and an empty
  // buffer would sniff as plain text and open in the wrong editor.
  show(t("file.untitledDoc"), null, dumps(newDocument("")));
}

async function newDeck() {
  if (!(await confirmDiscard())) return;
  // Seeded for the same reason a new document is: the kind is sniffed from the
  // CONTENT, and an empty buffer would open in the text editor.
  show(t("file.untitledDeck"), null, dumpsDeck(newPresentation("")));
}

async function newSheet() {
  if (!(await confirmDiscard())) return;
  // Seeded, like the other structured kinds: the editor is chosen from the
  // CONTENT, so an empty buffer would open as plain text.
  show(t("file.untitledSheet"), null, dumpsSheet(newWorkbook("New sheet")));
}

async function newText() {
  if (!(await confirmDiscard())) return;
  show(t("file.untitledText"), null, "");
}

const browserInput = ref<HTMLInputElement | null>(null);

async function openFile() {
  if (!(await confirmDiscard())) return;
  fileError.value = "";
  if (!isTauri) {
    browserInput.value?.click();
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [
        { name: "SVG", extensions: ["svg"] },
        { name: "Text", extensions: ["txt", "md", "json", "yaml", "yml", "xml", "html", "css", "js", "ts", "py", "rs", "sh", "toml", "ini", "csv"] },
        { name: "All", extensions: ["*"] },
      ],
    });
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
    a.href = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    a.download = name.value;
    a.click();
    URL.revokeObjectURL(a.href);
    editorRef.value?.markSaved();
    dirty.value = false;
    notice.value = t("file.saved");
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({
    defaultPath: name.value,
    filters: kind.value === "sketch"
      ? [{ name: "SVG", extensions: ["svg"] }]
      : kind.value === "document" || kind.value === "deck"
        ? [{ name: "XML", extensions: ["xml"] }]
      : kind.value === "sheet"
        ? [{ name: "Sheet", extensions: ["json"] }]
        : [{ name: "All", extensions: ["*"] }],
  });
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
    if (path.value === null) await saveAs();
    else await writeTo(path.value, body);
  } finally {
    busy.value = false;
  }
}

/** A never-saved file is always savable; an existing one only when changed. */
const canSave = computed(() => !busy.value && (dirty.value || path.value === null));

// ── keyboard: only what is the FILE's, not the buffer's ─────────────────────
function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void openFile();
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- File bar -->
    <div class="flex flex-wrap items-center gap-2 border-b border-current/10 px-3 py-2">
      <OyaIconButton size="sm" icon="file-circle-plus" :label="t('file.newDrawing')" @click="newDrawing" />
      <OyaIconButton size="sm" icon="file-lines" :label="t('file.newDoc')" data-testid="new-doc" @click="newDoc" />
      <OyaIconButton size="sm" icon="file-powerpoint" :label="t('file.newDeck')" data-testid="new-deck" @click="newDeck" />
      <OyaIconButton size="sm" icon="table-cells" :label="t('file.newSheet')" data-testid="new-sheet" @click="newSheet" />
      <OyaIconButton size="sm" icon="file-pen" :label="t('file.newText')" @click="newText" />
      <OyaIconButton size="sm" icon="folder-open" :label="t('file.open')" @click="openFile" />
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-1.5">
          <span class="truncate text-sm font-semibold" data-testid="file-name">{{ name }}</span>
          <span v-if="dirty" class="shrink-0 opacity-60" :title="t('file.unsavedTitle')">•</span>
        </p>
        <p v-if="!isTauri" class="truncate text-xs opacity-50">{{ t("file.browserNote") }}</p>
      </div>
      <p v-if="notice" class="text-xs opacity-60">{{ notice }}</p>
      <p v-if="fileError" class="min-w-0 truncate text-xs text-warn-dark" data-testid="file-error">{{ fileError }}</p>
      <button
        class="shrink-0 rounded-lg border border-accent-2 px-2.5 py-1 text-xs font-semibold transition hover:opacity-80 disabled:opacity-40 dark:border-accent-1"
        :disabled="busy"
        @click="saveAs()"
      >
        {{ t("file.saveAs") }}
      </button>
      <button
        class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
        :class="{ 'pointer-events-none opacity-50': !canSave }"
        data-testid="file-save"
        @click="saveFile()"
      >
        <font-awesome-icon :icon="busy ? 'spinner' : 'floppy-disk'" :spin="busy" />
        {{ t("file.save") }}
      </button>
    </div>

    <input ref="browserInput" type="file" class="hidden" @change="onBrowserFile" />

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
      class="min-h-0 flex-1"
      @save="saveFile($event)"
      @update:dirty="dirty = $event"
    />

    <OyaModal :open="discardOpen" @close="answerDiscard(false)">
      <div class="w-full max-w-sm space-y-3">
        <p class="text-sm font-semibold">{{ t("file.discardTitle") }}</p>
        <p class="text-sm opacity-70">{{ t("file.discardBody") }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="answerDiscard(false)">{{ t("common.cancel") }}</OyaButton>
          <OyaButton @click="answerDiscard(true)">{{ t("file.discardConfirm") }}</OyaButton>
        </div>
      </div>
    </OyaModal>
  </div>
</template>
