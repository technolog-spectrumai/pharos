<script setup lang="ts">
// The sketch editor as a standalone view. In enigma the drawing engine sat
// behind LocalPanel, which owned the file; zinnia has no panel yet, so this
// view owns both halves: the file lifecycle (New / Open / Save / Save As via
// the native dialogs, with a browser fallback) and the editing session.
//
// The editing half is a faithful port of enigma's SvgEditor.vue — the parse
// refusal, the baseline rule, the dirty watch, the keyboard map. Where that
// component emitted to a parent, this view acts on the file itself.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import OyaButton from "../components/OyaButton.vue";
import OyaIconButton from "../components/OyaIconButton.vue";
import OyaModal from "../components/OyaModal.vue";
import OyaTextField from "../components/OyaTextField.vue";
import SketchCanvas, { type Tool } from "../sketch/SketchCanvas.vue";
import SketchToolbar from "../sketch/SketchToolbar.vue";
import { createSketch, type Sketch } from "../sketch/useSketch";
import {
  emptySvgDocument,
  parseSvgDocument,
  serializeSvgDocument,
  type MeasureText,
  type ParseRefusal,
} from "../sketch/svgDocument";
import { SVG_FONT_STACK } from "../sketch/sketchModel";
import { backgroundImageFromFile, exportPng } from "../sketch/sketchExport";

const { t } = useI18n({ useScope: "global" });

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ── text metrics ────────────────────────────────────────────────────────────
// A text shape stores its measured box so hit-testing and export never need a
// font context. An imported <text> has none, so the parser is handed this.
let ctx: CanvasRenderingContext2D | null = null;
const measure: MeasureText = (text, size) => {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return { w: text.length * size * 0.6, h: size * 1.2 };
  ctx.font = `${size}px ${SVG_FONT_STACK}`;
  return { w: ctx.measureText(text).width, h: size * 1.2 };
};

// ── the file ────────────────────────────────────────────────────────────────
const path = ref<string | null>(null); // null until first Save As
const name = ref(t("file.untitled"));
const busy = ref(false);
const fileError = ref("");
const notice = ref("");

// ── the session ─────────────────────────────────────────────────────────────
const refusal = ref<{ reason: ParseRefusal; detail: string } | null>(null);
const rawText = ref(""); // shown read-only when the parser refused
// shallowRef: the orchestrator holds its own refs, and Vue must not walk into it.
const sketch = shallowRef<Sketch | null>(null);
const opaqueCount = computed(() => sketch.value?.opaqueCount.value ?? 0);

/** The text as of the last successful save; dirtiness is measured against it. */
let savedContent = "";
const dirty = ref(false);

function currentText(): string {
  return sketch.value?.toText() ?? savedContent;
}

/** Baseline against what we WOULD write, not the bytes we read: serialising
 *  normalises whitespace and attribute order, so a foreign file almost never
 *  round-trips byte-identically, and measuring against the raw text would mark
 *  every freshly opened drawing unsaved before the user touched it. */
function baseline() {
  savedContent = currentText();
  dirty.value = false;
}

function openText(text: string) {
  refusal.value = null;
  rawText.value = "";
  fileError.value = "";
  notice.value = "";
  if (!text.trim()) {
    sketch.value = createSketch(emptySvgDocument());
    void sketch.value.loadPalette();
    baseline();
    return;
  }
  const res = parseSvgDocument(text, measure);
  if (!res.ok) {
    refusal.value = { reason: res.reason, detail: res.detail };
    rawText.value = text;
    sketch.value = null;
    return;
  }
  sketch.value = createSketch(res.doc);
  void sketch.value.loadPalette();
  baseline();
}

const refusalMessage = computed(() => {
  const r = refusal.value;
  if (!r) return "";
  const key = {
    "active-content": "sketch.refusedActive",
    "external-reference": "sketch.refusedExternal",
    doctype: "sketch.refusedDoctype",
    "not-svg": "sketch.refusedNotSvg",
  }[r.reason];
  return t(key, { what: r.detail });
});

/** Cheap enough: serialising re-renders our own shapes into the envelope, and a
 *  drawing edit already re-renders the canvas. Watching the doc rather than
 *  every tool press keeps a palette swap from marking the file dirty. */
watch(
  () => [sketch.value?.doc.value, sketch.value?.backgroundImage.value] as const,
  () => { dirty.value = currentText() !== savedContent; },
  { deep: true },
);

// ── file operations ─────────────────────────────────────────────────────────
function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) return Promise.resolve(true);
  discardResolve = null;
  discardOpen.value = true;
  return new Promise((resolve) => { discardResolve = resolve; });
}
const discardOpen = ref(false);
let discardResolve: ((ok: boolean) => void) | null = null;
function answerDiscard(ok: boolean) {
  discardOpen.value = false;
  discardResolve?.(ok);
  discardResolve = null;
}

async function newDrawing() {
  if (!(await confirmDiscard())) return;
  path.value = null;
  name.value = t("file.untitled");
  openText("");
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
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (typeof picked !== "string") return;
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const text = await readTextFile(picked);
    path.value = picked;
    name.value = picked.split("/").pop() ?? picked;
    openText(text);
  } catch (err) {
    fileError.value = `${t("file.openFailed")} ${(err as Error)?.message ?? err}`;
  }
}

async function onBrowserFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  path.value = null; // a browser File has no path; saving becomes a download
  name.value = file.name;
  openText(await file.text());
}

async function saveAs(): Promise<boolean> {
  const text = currentText();
  if (!isTauri) {
    // Browser: a download is the only "save" there is.
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    a.download = name.value;
    a.click();
    URL.revokeObjectURL(a.href);
    baseline();
    notice.value = t("file.saved");
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({
    defaultPath: name.value,
    filters: [{ name: "SVG", extensions: ["svg"] }],
  });
  if (!picked) return false;
  path.value = picked;
  name.value = picked.split("/").pop() ?? picked;
  return writeTo(picked, text);
}

async function writeTo(target: string, text: string): Promise<boolean> {
  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(target, text);
    baseline();
    notice.value = t("file.saved");
    return true;
  } catch (err) {
    fileError.value = `${t("file.saveFailed")} ${(err as Error)?.message ?? err}`;
    return false;
  }
}

async function saveFile() {
  if (busy.value || !sketch.value) return;
  busy.value = true;
  fileError.value = "";
  notice.value = "";
  try {
    if (path.value === null) await saveAs();
    else await writeTo(path.value, currentText());
  } finally {
    busy.value = false;
  }
}

/** A never-saved drawing is always savable; an existing one only when changed. */
const canSave = computed(() => !busy.value && !!sketch.value && (dirty.value || path.value === null));

// ── background image + PNG export ───────────────────────────────────────────
const imageInput = ref<HTMLInputElement | null>(null);
const exportBusy = ref(false);
const localError = ref("");

const IMAGE_ERROR_KEYS: Record<string, string> = {
  "not-an-image": "sketch.imageNotAnImage",
  unreadable: "sketch.imageUnreadable",
};

function chooseImage() {
  imageInput.value?.click();
}

async function onImagePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // so re-picking the SAME file still fires a change event
  if (!file || !sketch.value) return;
  localError.value = "";
  try {
    sketch.value.setBackgroundImage(await backgroundImageFromFile(file));
  } catch (err) {
    const code = (err as Error)?.message ?? "";
    localError.value = t(IMAGE_ERROR_KEYS[code] ?? "sketch.imageFailed");
  }
}

async function runExportPng() {
  const s = sketch.value;
  if (!s || exportBusy.value) return;
  exportBusy.value = true;
  localError.value = "";
  notice.value = "";
  try {
    const stem = name.value.replace(/\.svg$/i, "") || "drawing";
    const ok = await exportPng(s.doc.value, `${stem}.png`, s.backgroundImage.value, s.boardW.value, s.boardH.value);
    if (ok) notice.value = t("sketch.exportDone");
  } catch (err) {
    localError.value = (err as Error)?.message ?? String(err);
  } finally {
    exportBusy.value = false;
  }
}

// ── text tool ───────────────────────────────────────────────────────────────
const tool = ref<Tool>("draw");
const textSize = ref(24);
const textModal = ref<null | { x: number; y: number }>(null);
const textInput = ref("");

function requestText(x: number, y: number) {
  textModal.value = { x, y };
  textInput.value = "";
}

function confirmText() {
  const at = textModal.value;
  const body = textInput.value.trim();
  if (!at || !body || !sketch.value) return;
  const box = measure(body, textSize.value);
  sketch.value.addText(at.x, at.y, body, textSize.value, box.w, box.h);
  textModal.value = null;
}

// ── keyboard ────────────────────────────────────────────────────────────────
function onKey(e: KeyboardEvent) {
  const s = sketch.value;
  if (!s || textModal.value || discardOpen.value) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void saveFile();
  } else if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void openFile();
  } else if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) s.redo();
    else s.undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    s.redo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && s.selected.value) {
    e.preventDefault();
    s.deleteSelected();
  } else if (e.key === "Escape") {
    s.clearSelection();
  }
}

onMounted(() => {
  openText("");
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

// Re-serialise through the parser to keep serializeSvgDocument tree-shaken in.
// (No runtime purpose; documents the round-trip pair for the reader.)
void serializeSvgDocument;
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- File bar -->
    <div class="flex flex-wrap items-center gap-2 border-b border-current/10 px-3 py-2">
      <OyaIconButton size="sm" icon="file-circle-plus" :label="t('file.newDrawing')" @click="newDrawing" />
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
        :disabled="!sketch || busy"
        @click="saveAs"
      >
        {{ t("file.saveAs") }}
      </button>
      <button
        class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
        :class="{ 'pointer-events-none opacity-50': !canSave }"
        data-testid="sketch-save"
        @click="saveFile"
      >
        <font-awesome-icon :icon="busy ? 'spinner' : 'floppy-disk'" :spin="busy" />
        {{ t("file.save") }}
      </button>
    </div>

    <!-- Refused: say what and why, and show the bytes read-only so nothing is lost. -->
    <div v-if="refusal" class="flex min-h-0 flex-1 flex-col gap-3 p-6">
      <div class="flex flex-col items-center gap-2 text-center">
        <font-awesome-icon icon="triangle-exclamation" class="text-3xl text-warn-dark" />
        <p class="text-sm font-semibold">{{ t("sketch.refusedTitle") }}</p>
        <p class="max-w-md text-sm opacity-70" data-testid="svg-refusal">{{ refusalMessage }}</p>
        <p class="max-w-md text-xs opacity-50">{{ t("file.rawView") }}</p>
      </div>
      <textarea
        readonly
        class="min-h-0 flex-1 resize-none rounded-lg border border-current/20 bg-transparent p-3 font-mono text-xs"
        :value="rawText"
      ></textarea>
    </div>

    <template v-else-if="sketch">
      <SketchToolbar
        :sketch="sketch"
        :tool="tool"
        :text-size="textSize"
        :busy="busy"
        @update:tool="tool = $event"
        @update:text-size="textSize = $event"
        @clear="sketch.clearBoard()"
        @choose-image="chooseImage"
      />

      <div class="flex items-center gap-2 border-b border-current/10 px-3 py-1.5">
        <button
          class="shrink-0 rounded-lg border border-accent-2 px-2.5 py-1 text-xs font-semibold transition hover:opacity-80 disabled:opacity-40 dark:border-accent-1"
          :disabled="exportBusy"
          data-testid="svg-export-png"
          @click="runExportPng"
        >
          <font-awesome-icon :icon="exportBusy ? 'spinner' : 'image'" :spin="exportBusy" />
          {{ t("sketch.exportPng") }}
        </button>
        <p v-if="localError" class="min-w-0 flex-1 truncate text-xs text-warn-dark">{{ localError }}</p>
      </div>

      <input ref="imageInput" type="file" accept="image/*" class="hidden" @change="onImagePicked" />
      <input ref="browserInput" type="file" accept=".svg,image/svg+xml" class="hidden" @change="onBrowserFile" />

      <!-- Parts of the file this editor cannot represent are still drawn, just
           not selectable — say so rather than letting them look like a bug. -->
      <p v-if="opaqueCount > 0" class="border-b border-current/10 px-3 py-1.5 text-xs opacity-60" data-testid="svg-opaque-notice">
        <font-awesome-icon icon="circle-info" class="mr-1" />
        {{ t("sketch.opaqueNotice", { n: opaqueCount }) }}
      </p>

      <SketchCanvas :sketch="sketch" :tool="tool" class="min-h-0 flex-1" @request-text="requestText" />
    </template>

    <OyaModal :open="textModal !== null" @close="textModal = null">
      <div class="w-full max-w-sm space-y-3">
        <p class="text-sm font-semibold">{{ t("sketch.addText") }}</p>
        <OyaTextField v-model="textInput" :placeholder="t('sketch.textPlaceholder')" @enter="confirmText" />
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="textModal = null">{{ t("common.cancel") }}</OyaButton>
          <OyaButton @click="confirmText">{{ t("common.save") }}</OyaButton>
        </div>
      </div>
    </OyaModal>

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
