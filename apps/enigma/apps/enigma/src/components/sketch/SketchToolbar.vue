<script setup lang="ts">
// Tool palette, brush settings and board actions. Purely presentational — every
// mutation goes through the sketch orchestrator the parent owns.
import { computed } from "vue";
import { OyaIconButton } from "rakotis";
import { canFill, OPACITY_STEPS, SKETCH_COLORS, STROKE_SIZES, TEXT_SIZES } from "./sketchModel";
import type { Sketch } from "./useSketch";
import type { Tool } from "./SketchCanvas.vue";

const props = defineProps<{ sketch: Sketch; tool: Tool; textSize: number; busy?: boolean; darkMode?: boolean }>();
const emit = defineEmits<{
  "update:tool": [Tool];
  "update:textSize": [number];
  clear: [];
  exportSvg: [];
  exportPng: [];
}>();

const TOOLS: { id: Tool; icon: string; labelKey: string }[] = [
  { id: "select", icon: "arrow-pointer", labelKey: "sketch.tools.select" },
  { id: "draw", icon: "pencil", labelKey: "sketch.tools.draw" },
  { id: "rect", icon: "square", labelKey: "sketch.tools.rect" },
  { id: "ellipse", icon: "circle", labelKey: "sketch.tools.circle" },
  { id: "triangle", icon: "play", labelKey: "sketch.tools.triangle" },
  { id: "arrow", icon: "arrow-right", labelKey: "sketch.tools.arrow" },
  { id: "text", icon: "font", labelKey: "sketch.tools.text" },
  { id: "eraser", icon: "eraser", labelKey: "sketch.tools.eraser" },
];

/** Style changes apply to the current selection too, so the select tool doubles as
 *  a restyle tool rather than needing a separate inspector. */
function pickColor(c: string) {
  props.sketch.currentColor.value = c;
  props.sketch.restyleSelected();
}
function pickWidth(w: number) {
  props.sketch.currentWidth.value = w;
  props.sketch.restyleSelected();
}
function pickOpacity(o: number) {
  props.sketch.currentOpacity.value = o;
  props.sketch.restyleSelected();
}
function pickFill(c: string | null) {
  props.sketch.currentFill.value = c;
  props.sketch.restyleSelected();
}

const fillApplies = computed(() => {
  const sel = props.sketch.selected.value;
  return sel ? canFill(sel.kind) : ["rect", "ellipse", "triangle"].includes(props.tool);
});

/** Degrees field. `.lazy` matters: without it every keystroke of "180" would commit
 *  1, then 18, then 180 as three separate undo entries (and clear redo three times).
 *  Committing on change/blur makes a typed angle one undoable step. */
const rotation = computed({
  get: () => props.sketch.selected.value?.rot ?? 0,
  set: (deg: number) => props.sketch.setSelectedRotation(deg),
});
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-accent-2 px-3 py-2 dark:border-accent-1"
  >
    <!-- Tools -->
    <div class="flex items-center gap-1">
      <OyaIconButton
        v-for="t in TOOLS"
        :key="t.id"
        size="sm"
        :icon="t.icon"
        :label="$t(t.labelKey)"
        :active="tool === t.id"
        @click="emit('update:tool', t.id)"
      />
    </div>

    <!-- Colour -->
    <div class="flex items-center gap-1" :title="$t('sketch.color')">
      <button
        v-for="c in SKETCH_COLORS"
        :key="c"
        type="button"
        class="h-6 w-6 rounded-full border-2 transition hover:scale-110"
        :class="sketch.currentColor.value === c ? 'border-accent-light dark:border-accent-dark' : 'border-black/20'"
        :style="{ backgroundColor: c }"
        :aria-label="c"
        @click="pickColor(c)"
      />
    </div>

    <!-- Stroke width -->
    <div class="flex items-center gap-1" :title="$t('sketch.size')">
      <button
        v-for="w in STROKE_SIZES"
        :key="w"
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-lg border transition"
        :class="
          sketch.currentWidth.value === w
            ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
            : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
        "
        :aria-label="`${w}`"
        @click="pickWidth(w)"
      >
        <span class="rounded-full bg-current" :style="{ width: `${w}px`, height: `${w}px` }" />
      </button>
    </div>

    <!-- Opacity -->
    <div class="flex items-center gap-1" :title="$t('sketch.opacity')">
      <button
        v-for="o in OPACITY_STEPS"
        :key="o"
        type="button"
        class="h-7 rounded-lg border px-1.5 text-[10px] font-bold transition"
        :class="
          sketch.currentOpacity.value === o
            ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
            : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
        "
        @click="pickOpacity(o)"
      >
        {{ Math.round(o * 100) }}%
      </button>
    </div>

    <!-- Fill (shapes only) -->
    <div v-if="fillApplies" class="flex items-center gap-1" :title="$t('sketch.fill')">
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] transition hover:scale-110"
        :class="sketch.currentFill.value === null ? 'border-accent-light dark:border-accent-dark' : 'border-black/20'"
        :aria-label="$t('sketch.noFill')"
        @click="pickFill(null)"
      >
        <font-awesome-icon icon="ban" />
      </button>
      <button
        v-for="c in SKETCH_COLORS"
        :key="`fill-${c}`"
        type="button"
        class="h-6 w-6 rounded border-2 transition hover:scale-110"
        :class="sketch.currentFill.value === c ? 'border-accent-light dark:border-accent-dark' : 'border-black/20'"
        :style="{ backgroundColor: c }"
        :aria-label="c"
        @click="pickFill(c)"
      />
    </div>

    <!-- Rotation (selection only) -->
    <div v-if="sketch.selected.value" class="flex items-center gap-1.5" :title="$t('sketch.rotation')">
      <font-awesome-icon icon="rotate" class="text-xs opacity-60" />
      <input
        v-model.lazy.number="rotation"
        type="number"
        min="0"
        max="359"
        step="1"
        class="w-16 rounded-lg border bg-transparent px-2 py-1 text-right text-sm"
        :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
        :aria-label="$t('sketch.rotation')"
      />
      <span class="text-xs opacity-60">{{ $t('sketch.degrees') }}</span>
    </div>

    <!-- Text size (text tool only) -->
    <div v-if="tool === 'text'" class="flex items-center gap-1" :title="$t('sketch.textSize')">
      <button
        v-for="s in TEXT_SIZES"
        :key="s"
        type="button"
        class="h-7 rounded-lg border px-2 text-xs font-bold transition"
        :class="
          textSize === s
            ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
            : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
        "
        @click="emit('update:textSize', s)"
      >
        {{ s }}
      </button>
    </div>

    <!-- History + actions -->
    <div class="ml-auto flex items-center gap-1">
      <OyaIconButton
        size="sm"
        icon="rotate-left"
        :label="$t('sketch.undo')"
        :disabled="!sketch.canUndo.value"
        @click="sketch.undo()"
      />
      <OyaIconButton
        size="sm"
        icon="rotate-right"
        :label="$t('sketch.redo')"
        :disabled="!sketch.canRedo.value"
        @click="sketch.redo()"
      />
      <OyaIconButton
        size="sm"
        icon="trash"
        :label="$t('sketch.deleteSelected')"
        :disabled="!sketch.selected.value"
        @click="sketch.deleteSelected()"
      />
      <OyaIconButton size="sm" icon="broom" :label="$t('sketch.clear')" @click="emit('clear')" />
      <OyaIconButton
        size="sm"
        icon="download"
        :label="$t('sketch.exportSvg')"
        :disabled="busy"
        @click="emit('exportSvg')"
      />
      <OyaIconButton
        size="sm"
        icon="image"
        :label="$t('sketch.exportPng')"
        :disabled="busy"
        @click="emit('exportPng')"
      />
    </div>
  </div>
</template>
