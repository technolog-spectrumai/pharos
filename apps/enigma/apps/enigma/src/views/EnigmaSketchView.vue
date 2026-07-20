<script setup lang="ts">
// Sketch tab: a standalone local drawing board. Not tied to a chat room and not
// shared — it saves itself locally and exports to SVG or PNG.
//
// The board lives in the module singleton from useSketch, not in this view: the
// router unmounts views on navigation, so view-local state would drop the drawing
// and its undo history every time the user looks at another tab.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { OyaButton, OyaModal, OyaTextField } from "rakotis";
import SketchCanvas, { type Tool } from "../components/sketch/SketchCanvas.vue";
import SketchToolbar from "../components/sketch/SketchToolbar.vue";
import { exportPng, exportSvg } from "../components/sketch/sketchExport";
import { SVG_FONT_STACK } from "../components/sketch/sketchModel";
import { getSketch } from "../components/sketch/useSketch";

defineProps<{ darkMode?: boolean }>();

const sketch = getSketch();

const tool = ref<Tool>("draw");
const textSize = ref(24);
const busy = ref(false);
const notice = ref("");

// ── text entry ──────────────────────────────────────────────────────────────
// A modal rather than an inline caret: one code path for desktop and touch, no
// soft-keyboard overlap, and nothing to fight the letterboxed SVG transform.
const textOpen = ref(false);
const textValue = ref("");
const textAt = ref({ x: 0, y: 0 });

function onRequestText(x: number, y: number) {
  textAt.value = { x, y };
  textValue.value = "";
  textOpen.value = true;
}

/** Measure the string so the eraser and selection box match what's painted. */
function measure(text: string, size: number): { tw: number; th: number } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { tw: text.length * size * 0.5, th: size * 1.2 };
  ctx.font = `${size}px ${SVG_FONT_STACK}`;
  return { tw: ctx.measureText(text).width, th: size * 1.2 };
}

function commitText() {
  const value = textValue.value.trim();
  if (value) {
    const { tw, th } = measure(value, textSize.value);
    sketch.addText(textAt.value.x, textAt.value.y, value, textSize.value, tw, th);
  }
  textOpen.value = false;
}

// ── clear confirm ───────────────────────────────────────────────────────────
const clearOpen = ref(false);
function confirmClear() {
  sketch.clearBoard();
  clearOpen.value = false;
}

// ── export ──────────────────────────────────────────────────────────────────
const stamp = () => new Date().toISOString().slice(0, 10);

async function runExport(kind: "svg" | "png") {
  busy.value = true;
  notice.value = "";
  try {
    // Persist first: what lands on disk should match what's saved.
    await sketch.flushPersist();
    const name = `sketch-${stamp()}.${kind}`;
    const ok =
      kind === "svg"
        ? await exportSvg(sketch.doc.value, name)
        : await exportPng(sketch.doc.value, name);
    if (ok) notice.value = "exported";
  } catch (e) {
    notice.value = (e as Error)?.message ?? String(e);
  } finally {
    busy.value = false;
  }
}

// ── keyboard shortcuts ──────────────────────────────────────────────────────
function onKey(e: KeyboardEvent) {
  if (textOpen.value || clearOpen.value) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) sketch.redo();
    else sketch.undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    sketch.redo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && sketch.selected.value) {
    e.preventDefault();
    sketch.deleteSelected();
  } else if (e.key === "Escape") {
    sketch.clearSelection();
  }
}

const shapeCount = computed(() => sketch.shapes.value.length);

onMounted(() => {
  void sketch.load();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  // Don't leave the board unsaved behind a debounce when navigating away.
  void sketch.flushPersist();
});
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-xl font-bold">{{ $t('sketch.title') }}</h1>
        <p class="text-sm opacity-60">{{ $t('sketch.subtitle') }}</p>
      </div>
      <p class="text-xs opacity-50">{{ $t('sketch.shapeCount', { n: shapeCount }) }}</p>
    </div>

    <SketchToolbar
      :sketch="sketch"
      :tool="tool"
      :text-size="textSize"
      :busy="busy"
      :dark-mode="darkMode"
      @update:tool="tool = $event"
      @update:text-size="textSize = $event"
      @clear="clearOpen = true"
      @export-svg="runExport('svg')"
      @export-png="runExport('png')"
    />

    <p v-if="sketch.boardFull.value" class="text-xs text-warn-dark">
      {{ $t('sketch.boardFull', { n: sketch.maxShapes }) }}
    </p>
    <p v-else-if="notice === 'exported'" class="text-xs opacity-60">{{ $t('sketch.exportDone') }}</p>
    <p v-else-if="notice" class="text-xs text-warn-dark">{{ notice }}</p>

    <SketchCanvas :sketch="sketch" :tool="tool" @request-text="onRequestText" />

    <!-- Text entry -->
    <OyaModal :open="textOpen" @close="textOpen = false">
      <form
        class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
        @submit.prevent="commitText"
      >
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="font" />
          {{ $t('sketch.addText') }}
        </p>
        <OyaTextField
          v-model="textValue"
          :placeholder="$t('sketch.textPlaceholder')"
          :maxlength="sketch.maxTextLen"
          @enter="commitText"
        />
        <div class="flex justify-end gap-2 pt-1">
          <OyaButton variant="secondary" type="button" @click="textOpen = false">
            {{ $t('sketch.cancel') }}
          </OyaButton>
          <OyaButton type="submit">
            <font-awesome-icon icon="check" />
            {{ $t('sketch.save') }}
          </OyaButton>
        </div>
      </form>
    </OyaModal>

    <!-- Clear confirm -->
    <OyaModal :open="clearOpen" @close="clearOpen = false">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('sketch.clear') }}
        </p>
        <p class="text-sm opacity-80">{{ $t('sketch.clearConfirm') }}</p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="clearOpen = false">{{ $t('sketch.cancel') }}</OyaButton>
          <OyaButton @click="confirmClear">
            <font-awesome-icon icon="broom" />
            {{ $t('sketch.clear') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>
  </div>
</template>
