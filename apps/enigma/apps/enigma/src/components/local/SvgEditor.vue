<script setup lang="ts">
// Visual editor for one local .svg file — the drawing counterpart of NoteEditor.
//
// It clones NoteEditor's interface EXACTLY (same props, emits and exposed
// methods) so LocalPanel's save path is shared verbatim: the parent still owns
// the file, the lock state and the passphrase, and this component never touches
// disk or crypto. `getContent()` returns SVG text, which is what makes the
// sealed `local_note_write` round trip work with no Rust change at all.
//
// A file it cannot represent is REFUSED rather than silently flattened — the
// parent then offers the plain XML editor. See svgDocument.ts for why.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { OyaButton, OyaIconButton, OyaModal, OyaTextField } from "rakotis";
import { useI18n } from "vue-i18n";
import SketchCanvas, { type Tool } from "../sketch/SketchCanvas.vue";
import SketchToolbar from "../sketch/SketchToolbar.vue";
import { createSketch, type Sketch } from "../sketch/useSketch";
import {
  emptySvgDocument,
  parseSvgDocument,
  type ParseRefusal,
  type MeasureText,
} from "../sketch/svgDocument";
import { SVG_FONT_STACK } from "../sketch/sketchModel";
import { backgroundImageFromFile, exportPng } from "../sketch/sketchExport";

const props = defineProps<{
  /** null while the drawing has never been saved (awaiting Save As). */
  path: string | null;
  name: string;
  content: string;
  /** True if the file is stored encrypted on disk. */
  locked: boolean;
  darkMode?: boolean;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  save: [content: string];
  back: [];
  encrypt: [];
  "update:dirty": [boolean];
  /** The file cannot be edited visually — the parent offers the XML editor. */
  "open-as-xml": [];
}>();

const { t } = useI18n({ useScope: "global" });

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

// ── open ────────────────────────────────────────────────────────────────────
const refusal = ref<{ reason: ParseRefusal; detail: string } | null>(null);
// shallowRef: the orchestrator holds its own refs, and Vue must not walk into it.
const sketch = shallowRef<Sketch | null>(null);
const opaqueCount = computed(() => sketch.value?.opaqueCount.value ?? 0);

function open(text: string) {
  refusal.value = null;
  // An empty buffer is a brand-new drawing, not a parse failure.
  if (!text.trim()) {
    sketch.value = createSketch(emptySvgDocument());
    void sketch.value.loadPalette();
    baseline();
    return;
  }
  const res = parseSvgDocument(text, measure);
  if (!res.ok) {
    refusal.value = { reason: res.reason, detail: res.detail };
    sketch.value = null;
    return;
  }
  sketch.value = createSketch(res.doc);
  void sketch.value.loadPalette();
  baseline();
}

/** Baseline dirtiness against what we WOULD write, not against the bytes we
 *  read. Re-serializing normalises whitespace and attribute order, so a foreign
 *  file almost never round-trips byte-identically — measuring against the raw
 *  text would mark every freshly opened drawing as unsaved before the user has
 *  touched it, and then prompt to discard changes that do not exist. */
function baseline() {
  savedContent = currentText();
  setDirty(false);
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

// ── dirty tracking ──────────────────────────────────────────────────────────
/** The text as of the last successful save; dirtiness is measured against it. */
let savedContent = props.content;
const dirty = ref(false);

function setDirty(v: boolean) {
  if (dirty.value === v) return;
  dirty.value = v;
  emit("update:dirty", v);
}

function currentText(): string {
  return sketch.value?.toText() ?? savedContent;
}

/** Cheap enough: serializing re-renders our own shapes into the envelope, and a
 *  drawing edit already re-renders the canvas. Watching the doc rather than
 *  every tool press keeps a palette swap from marking the file dirty. */
watch(
  () => [sketch.value?.doc.value, sketch.value?.backgroundImage.value] as const,
  () => setDirty(currentText() !== savedContent),
  { deep: true },
);

const tool = ref<Tool>("draw");
const textSize = ref(24);

// ── background image + PNG export ───────────────────────────────────────────
// These are the two things that reach outside the document: an image is read
// from a File (bytes, not a path — works in the browser too), and a PNG is
// written to a path the user picks. Both are explicit presses.
const imageInput = ref<HTMLInputElement | null>(null);
const exportBusy = ref(false);
const notice = ref("");

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
  // Clear immediately so re-picking the SAME file still fires a change event.
  input.value = "";
  if (!file || !sketch.value) return;
  localError.value = "";
  try {
    sketch.value.setBackgroundImage(await backgroundImageFromFile(file));
  } catch (err) {
    const code = (err as Error)?.message ?? "";
    localError.value = t(IMAGE_ERROR_KEYS[code] ?? "sketch.imageFailed");
  }
}

/** Rasterize and save a copy. The drawing itself is unaffected — this is the one
 *  path in the editor that writes UNSEALED bytes, and only ever to a path the
 *  user picked in the native dialog. */
async function runExportPng() {
  const s = sketch.value;
  if (!s || exportBusy.value) return;
  exportBusy.value = true;
  localError.value = "";
  notice.value = "";
  try {
    const stem = props.name.replace(/\.svg$/i, "") || "drawing";
    const ok = await exportPng(
      s.doc.value,
      `${stem}.png`,
      s.backgroundImage.value,
      s.boardW.value,
      s.boardH.value,
    );
    if (ok) notice.value = t("sketch.exportDone");
  } catch (err) {
    localError.value = (err as Error)?.message ?? String(err);
  } finally {
    exportBusy.value = false;
  }
}

/** Editor-local problems (image import, export). The `error` PROP stays the
 *  parent's channel for save/crypto failures — mixing them would let a stale
 *  export message survive a failed save. */
const localError = ref("");

function isDark(): boolean {
  return props.darkMode ?? document.documentElement.classList.contains("dark");
}

function save() {
  if (props.busy) return;
  emit("save", currentText());
}

/** A never-saved drawing is always savable; an existing one only when changed. */
const canSave = () => !props.busy && (dirty.value || props.path === null);

// ── text tool ───────────────────────────────────────────────────────────────
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
  if (!s || textModal.value) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
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
  open(props.content);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

// Save-As renames the file; the buffer is unchanged, so do NOT re-open it.
watch(() => props.path, () => undefined);

defineExpose({
  /** Re-baseline the dirty flag after the parent saves this buffer. */
  markSaved() {
    savedContent = currentText();
    setDirty(false);
  },
  getContent(): string {
    return currentText();
  },
  isDirty(): boolean {
    return dirty.value;
  },
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Same header shape as NoteEditor, so the two editors feel like one tab. -->
    <div class="flex items-center gap-2 border-b border-current/10 px-3 py-2">
      <OyaIconButton size="sm" icon="arrow-left" :label="$t('local.back')" @click="emit('back')" />
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-1.5">
          <span class="truncate text-sm font-semibold">{{ name }}</span>
          <span v-if="dirty" class="shrink-0 opacity-60" :title="$t('local.unsavedTitle')">•</span>
        </p>
        <p class="truncate text-xs opacity-50">
          <font-awesome-icon :icon="locked ? 'lock' : 'file-image'" class="mr-1" />
          {{ locked ? $t('local.editorEncrypted') : $t('local.editorPlain') }}
        </p>
      </div>
      <OyaIconButton
        v-if="!locked && sketch"
        size="sm"
        icon="lock"
        :label="$t('local.encryptAction')"
        :disabled="busy"
        @click="emit('encrypt')"
      />
      <button
        v-if="sketch"
        class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
        :class="{ 'pointer-events-none opacity-50': !canSave() }"
        data-testid="svg-save"
        @click="save"
      >
        <font-awesome-icon :icon="busy ? 'spinner' : 'floppy-disk'" :spin="busy" />
        {{ $t('local.save') }}
      </button>
    </div>

    <p v-if="error" class="border-b border-current/10 px-3 py-2 text-xs text-warn-dark">
      {{ error }}
    </p>

    <!-- Refused: say what and why, and offer the editor that CAN open it. -->
    <div v-if="refusal" class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <font-awesome-icon icon="triangle-exclamation" class="text-3xl text-warn-dark" />
      <p class="text-sm font-semibold">{{ $t('sketch.refusedTitle') }}</p>
      <p class="max-w-md text-sm opacity-70" data-testid="svg-refusal">{{ refusalMessage }}</p>
      <OyaButton variant="secondary" data-testid="svg-open-xml" @click="emit('open-as-xml')">
        <font-awesome-icon icon="file" /> {{ $t('sketch.openAsXml') }}
      </OyaButton>
    </div>

    <template v-else-if="sketch">
      <SketchToolbar
        :sketch="sketch"
        :tool="tool"
        :text-size="textSize"
        :busy="busy"
        :dark-mode="isDark()"
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
          {{ $t('sketch.exportPng') }}
        </button>
        <p v-if="notice" class="text-xs opacity-60">{{ notice }}</p>
        <p v-if="localError" class="min-w-0 flex-1 truncate text-xs text-warn-dark">{{ localError }}</p>
      </div>

      <input ref="imageInput" type="file" accept="image/*" class="hidden" @change="onImagePicked" />

      <!-- Parts of the file this editor cannot represent are still drawn, just
           not selectable — say so rather than letting them look like a bug. -->
      <p
        v-if="opaqueCount > 0"
        class="border-b border-current/10 px-3 py-1.5 text-xs opacity-60"
        data-testid="svg-opaque-notice"
      >
        <font-awesome-icon icon="circle-info" class="mr-1" />
        {{ $t('sketch.opaqueNotice', { n: opaqueCount }) }}
      </p>

      <SketchCanvas :sketch="sketch" :tool="tool" class="min-h-0 flex-1" @request-text="requestText" />
    </template>

    <OyaModal :open="textModal !== null" @close="textModal = null">
      <div class="w-full max-w-sm space-y-3">
        <p class="text-sm font-semibold">{{ $t('sketch.addText') }}</p>
        <OyaTextField v-model="textInput" :placeholder="$t('sketch.textPlaceholder')" @enter="confirmText" />
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="textModal = null">{{ $t('common.cancel') }}</OyaButton>
          <OyaButton @click="confirmText">{{ $t('common.save') }}</OyaButton>
        </div>
      </div>
    </OyaModal>
  </div>
</template>
