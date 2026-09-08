<script setup lang="ts">
// The drawing editor as a CONTRACT editor (see ./types.ts): the host owns the
// file and the save path; this component owns the drawing session. A faithful
// port of enigma's SvgEditor.vue — the parse refusal, the baseline rule, the
// dirty watch, the keyboard map — with the vault half (locked/encrypt) removed.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import ModalPanel from "petalite/ModalPanel.vue";
import { useI18n } from "vue-i18n";
import SketchCanvas, { type Tool } from "wisteria/SketchCanvas.vue";
import SketchToolbar from "wisteria/SketchToolbar.vue";
import { createSketch, type Sketch } from "wisteria/useSketch";
import {
  emptySvgDocument,
  parseSvgDocument,
  type MeasureText,
  type ParseRefusal,
} from "wisteria/svgDocument";
import { SVG_FONT_STACK } from "wisteria/sketchModel";
import { backgroundImageFromFile, exportPng } from "wisteria/sketchExport";
import { OyaButton, OyaModal, OyaTextField } from "petalite/primitives";
// The collaboration session follows the drawing on screen: it is attached to
// each new orchestrator and detached when this editor goes, and a change of
// drawing ends a running session (see useCollabSession.attach).
import { collab } from "../collab";

const props = defineProps<{
  path: string | null;
  name: string;
  content: string;
  busy?: boolean;
  error?: string;
  /** Whether this editor's tab is the one on screen. */
  active?: boolean;
}>();

const emit = defineEmits<{
  save: [content: string];
  "update:dirty": [boolean];
  "open-as-text": [];
}>();

const { t } = useI18n({ useScope: "global" });

// ── text metrics ────────────────────────────────────────────────────────────
let ctx: CanvasRenderingContext2D | null = null;
const measure: MeasureText = (text, size) => {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return { w: text.length * size * 0.6, h: size * 1.2 };
  ctx.font = `${size}px ${SVG_FONT_STACK}`;
  return { w: ctx.measureText(text).width, h: size * 1.2 };
};

// ── session ─────────────────────────────────────────────────────────────────
const refusal = ref<{ reason: ParseRefusal; detail: string } | null>(null);
// shallowRef: the orchestrator holds its own refs, and Vue must not walk into it.
const sketch = shallowRef<Sketch | null>(null);
const opaqueCount = computed(() => sketch.value?.opaqueCount.value ?? 0);

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

/** Baseline against what we WOULD write, not the bytes we read: serialising
 *  normalises whitespace and attribute order, so a foreign file almost never
 *  round-trips byte-identically, and measuring against the raw text would mark
 *  every freshly opened drawing unsaved before the user touched it. */
function baseline() {
  savedContent = currentText();
  setDirty(false);
}

function open(text: string) {
  refusal.value = null;
  if (!text.trim()) {
    sketch.value = createSketch(emptySvgDocument());
    collab.attach(sketch.value);
    baseline();
    return;
  }
  const res = parseSvgDocument(text, measure);
  if (!res.ok) {
    refusal.value = { reason: res.reason, detail: res.detail };
    sketch.value = null;
    collab.attach(null);
    return;
  }
  sketch.value = createSketch(res.doc);
  collab.attach(sketch.value);
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

/** Watching the doc rather than every tool press keeps a palette swap from
 *  marking the file dirty. */
watch(
  () => [sketch.value?.doc.value, sketch.value?.backgroundImage.value] as const,
  () => setDirty(currentText() !== savedContent),
  { deep: true },
);

// ── background image + PNG export ───────────────────────────────────────────
const imageInput = ref<HTMLInputElement | null>(null);
const exportBusy = ref(false);
const notice = ref("");
/** Editor-local problems (image import, export). The `error` PROP stays the
 *  host's channel for save failures — mixing them would let a stale export
 *  message survive a failed save. */
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
    const stem = props.name.replace(/\.svg$/i, "") || "drawing";
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
/** Display only — never persisted, never in the document, never an undo entry.
 *  If it ever needs to survive a reopen it is a device preference like the
 *  palette, not a property of the drawing. */
const zoom = ref(1);
/** A modal's buttons are not INPUT/TEXTAREA, so the window shortcut guard below
 *  does not cover them: without this, Delete inside a picker deletes a shape. */
const pickerOpen = ref(false);
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
  // Every visited tab stays mounted, so every editor has a live window
  // listener. Without this gate one Ctrl+S saves all of them at once.
  if (props.active === false) return;
  const s = sketch.value;
  if (!s || textModal.value || pickerOpen.value) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!props.busy) emit("save", currentText());
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
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  // By identity: on New/Open a fresh editor has already attached ITS drawing
  // by the time this runs, and an unconditional detach would undo it.
  collab.detach(sketch.value);
});

defineExpose({
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
  // Extra file commands the app menu shows beside New/Open/Save. A list, so a
  // tab can offer more than one and a tab with none adds nothing.
  exports: [{ labelKey: "sketch.exportPng", icon: "file-image", run: runExportPng }],
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <p v-if="error" class="border-b border-current/10 px-3 py-2 text-xs text-warn-dark">
      {{ error }}
    </p>

    <!-- Refused: say what and why, and offer the editor that CAN open it. -->
    <div v-if="refusal" class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <font-awesome-icon icon="triangle-exclamation" class="text-3xl text-warn-dark" />
      <p class="text-sm font-semibold">{{ t("sketch.refusedTitle") }}</p>
      <p class="max-w-md text-sm opacity-70" data-testid="svg-refusal">{{ refusalMessage }}</p>
      <OyaButton variant="secondary" data-testid="svg-open-text" @click="emit('open-as-text')">
        {{ t("file.openAsText") }}
      </OyaButton>
    </div>

    <template v-else-if="sketch">
      <SketchToolbar
        :sketch="sketch"
        :tool="tool"
        :text-size="textSize"
        :zoom="zoom"
        :busy="busy"
        @update:tool="tool = $event"
        @update:text-size="textSize = $event"
        @update:zoom="zoom = $event"
        @picker-open="pickerOpen = $event"
        @clear="sketch.clearBoard()"
        @choose-image="chooseImage"
      />

      <div v-if="notice || localError" class="flex items-center gap-2 border-b border-current/10 px-3 py-1.5">
        <p v-if="notice" class="text-xs opacity-60">{{ notice }}</p>
        <p v-if="localError" class="min-w-0 flex-1 truncate text-xs text-warn-dark">{{ localError }}</p>
      </div>

      <input ref="imageInput" type="file" accept="image/*" class="hidden" @change="onImagePicked" />

      <!-- Parts of the file this editor cannot represent are still drawn, just
           not selectable — say so rather than letting them look like a bug. -->
      <p v-if="opaqueCount > 0" class="border-b border-current/10 px-3 py-1.5 text-xs opacity-60" data-testid="svg-opaque-notice">
        <font-awesome-icon icon="circle-info" class="mr-1" />
        {{ t("sketch.opaqueNotice", { n: opaqueCount }) }}
      </p>

      <SketchCanvas :sketch="sketch" :tool="tool" :zoom="zoom" class="min-h-0 flex-1" @request-text="requestText" />
    </template>

    <OyaModal :open="textModal !== null" @close="textModal = null">
      <ModalPanel>
        <p class="text-sm font-semibold">{{ t("sketch.addText") }}</p>
        <OyaTextField v-model="textInput" :placeholder="t('sketch.textPlaceholder')" @enter="confirmText" />
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="textModal = null">{{ t("common.cancel") }}</OyaButton>
          <OyaButton @click="confirmText">{{ t("common.save") }}</OyaButton>
        </div>
      </ModalPanel>
    </OyaModal>
  </div>
</template>
