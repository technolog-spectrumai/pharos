<script setup lang="ts">
// Tool palette, brush settings and board actions. Purely presentational — every
// mutation goes through the sketch orchestrator the parent owns.
import { computed, ref, watch } from "vue";
import { OyaIconButton } from "rakotis";
import {
  BACKGROUND_COLORS,
  canFill,
  COLOR_NAME_KEYS,
  OPACITY_STEPS,
  PICKER_COLORS,
  STROKE_SIZES,
  TEXT_SIZES,
} from "./sketchModel";
import type { Sketch } from "./useSketch";
import type { Tool } from "./SketchCanvas.vue";

const props = defineProps<{ sketch: Sketch; tool: Tool; textSize: number; busy?: boolean; darkMode?: boolean }>();
const emit = defineEmits<{
  "update:tool": [Tool];
  "update:textSize": [number];
  clear: [];
  chooseImage: [];
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

// ── palette editing ─────────────────────────────────────────────────────────
// The colour row is seven assignable slots. Normally a slot click picks a drawing
// colour; with the pencil on, it opens a picker that reassigns the slot instead.
// Invariant: openSlot !== null implies paletteEditing.

const paletteEditing = ref(false);
const openSlot = ref<number | null>(null);

function toggleEditing() {
  paletteEditing.value = !paletteEditing.value;
  // Closed in BOTH directions — leaving edit mode with a panel up would strand it.
  openSlot.value = null;
}

/** Deliberately does not funnel through pickColor: that also calls
 *  restyleSelected(), so reusing it here would let a palette edit restyle the
 *  selected shape. */
function onSlotClick(i: number) {
  if (!paletteEditing.value) {
    pickColor(props.sketch.slots.value[i]);
    return;
  }
  openSlot.value = openSlot.value === i ? null : i;
}

function assignSlot(c: string) {
  const i = openSlot.value;
  if (i === null) return;
  props.sketch.setSlot(i, c);
  // Edit mode stays on so several slots can be reassigned in one visit.
  openSlot.value = null;
}

// The fill row unmounts on a tool change (v-if="fillApplies"); the stroke row does
// not, but closing on a tool switch keeps the panel from lingering over a toolbar
// the user has visibly moved on from.
watch(
  () => props.tool,
  () => {
    openSlot.value = null;
  },
);

const colorLabel = (c: string) => `sketch.colorNames.${COLOR_NAME_KEYS[c]}`;

/** Unselected swatch ring. `border-black/20` alone vanishes against the dark
 *  toolbar, which turns the white and silver chips into unbordered blobs. */
const IDLE_SWATCH = "border-black/20 dark:border-white/30";

/** Board background — a document property, so it is read straight off the doc
 *  rather than from a tool ref. null = transparent (the default). */
const background = computed(() => props.sketch.doc.value.background);

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

    <!-- Colour slots. Escape is stopped here on purpose: the view's window handler
         only ignores INPUT/TEXTAREA, so an Escape on a focused slot button would
         otherwise fall through and clear the shape selection. -->
    <div class="relative" @keydown.esc.stop="openSlot = null">
      <!-- z-50 lifts the triggers above the backdrop below. Without it the backdrop
           swallows the first click on any other slot (and on the pencil), so
           switching slots or leaving edit mode would silently cost two clicks. -->
      <div class="relative z-50 flex items-center gap-1" :title="$t('sketch.color')">
        <OyaIconButton
          size="sm"
          icon="pencil"
          :label="$t('sketch.editPalette')"
          :active="paletteEditing"
          :aria-pressed="paletteEditing"
          @click="toggleEditing()"
        />
        <!-- Keyed by INDEX, not colour: two slots may hold the same colour, and a
             colour key would then misorder these nodes. -->
        <button
          v-for="(c, i) in sketch.slots.value"
          :key="i"
          type="button"
          class="h-6 w-6 rounded-full border-2 transition hover:scale-110"
          :class="[
            paletteEditing
              ? openSlot === i
                ? 'border-dashed border-accent-light dark:border-accent-dark'
                : `border-dashed ${IDLE_SWATCH}`
              : sketch.currentColor.value === c
                ? 'border-accent-light dark:border-accent-dark'
                : IDLE_SWATCH,
          ]"
          :style="{ backgroundColor: c }"
          :aria-label="`${$t(paletteEditing ? 'sketch.editSlot' : 'sketch.slot', { n: i + 1 })} — ${$t(colorLabel(c))}`"
          :aria-haspopup="paletteEditing ? 'dialog' : undefined"
          :aria-expanded="paletteEditing ? openSlot === i : undefined"
          @click="onSlotClick(i)"
        />
      </div>

      <!-- Outside-click via a full-screen backdrop rather than a document listener,
           so there is no listener to leak. Same approach as EmojiPicker. -->
      <div v-if="openSlot !== null" class="fixed inset-0 z-40" @click="openSlot = null" />
      <div
        v-if="openSlot !== null"
        class="absolute left-0 top-full z-50 mt-2 w-56 rounded-xl border p-2 shadow-xl border-accent-2 bg-bubble-bg-light dark:border-accent-1 dark:bg-bubble-bg-dark"
        role="dialog"
        :aria-label="$t('sketch.editSlot', { n: openSlot + 1 })"
      >
        <div class="grid grid-cols-6 gap-1.5">
          <button
            v-for="c in PICKER_COLORS"
            :key="c"
            type="button"
            class="h-7 w-7 rounded-full border-2 transition hover:scale-110"
            :class="sketch.slots.value[openSlot] === c ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
            :style="{ backgroundColor: c }"
            :aria-label="$t(colorLabel(c))"
            :title="$t(colorLabel(c))"
            @click="assignSlot(c)"
          />
        </div>
      </div>
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

    <!-- Fill (shapes only). Mirrors the same seven slots — reassigning one updates
         both rows, which is what shows they are one palette. Goes inert during edit
         mode so two identical-looking rows never do different things at once. -->
    <div
      v-if="fillApplies"
      class="flex items-center gap-1"
      :class="paletteEditing && 'pointer-events-none opacity-40'"
      :title="$t('sketch.fill')"
    >
      <!-- `disabled`, not just pointer-events-none: the row has to be inert to the
           keyboard too, or it stays tabbable and Enter still fills while it reads as
           switched off. -->
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] transition hover:scale-110"
        :class="sketch.currentFill.value === null ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
        :disabled="paletteEditing"
        :aria-label="$t('sketch.noFill')"
        @click="pickFill(null)"
      >
        <font-awesome-icon icon="ban" />
      </button>
      <button
        v-for="(c, i) in sketch.slots.value"
        :key="i"
        type="button"
        class="h-6 w-6 rounded border-2 transition hover:scale-110"
        :class="sketch.currentFill.value === c ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
        :style="{ backgroundColor: c }"
        :disabled="paletteEditing"
        :aria-label="$t(colorLabel(c))"
        @click="pickFill(c)"
      />
    </div>

    <!-- Board background -->
    <div class="flex items-center gap-1" :title="$t('sketch.background')">
      <font-awesome-icon icon="image" class="text-xs opacity-60" />
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded border-2 text-[10px] transition hover:scale-110"
        :class="background === null ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
        :aria-label="$t('sketch.noBackground')"
        :title="$t('sketch.noBackground')"
        @click="sketch.setBackground(null)"
      >
        <font-awesome-icon icon="ban" />
      </button>
      <!-- White and black only. IDLE_SWATCH matters more here than anywhere else:
           the two swatches ARE white and near-black, so a ring that vanishes in one
           theme loses one of the only two chips in the row. -->
      <button
        v-for="c in BACKGROUND_COLORS"
        :key="`bg-${c}`"
        type="button"
        class="h-6 w-6 rounded border-2 transition hover:scale-110"
        :class="background === c ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
        :style="{ backgroundColor: c }"
        :aria-label="$t(colorLabel(c))"
        :title="$t(colorLabel(c))"
        @click="sketch.setBackground(c)"
      />
      <OyaIconButton
        size="sm"
        icon="file-image"
        :label="$t('sketch.chooseImage')"
        :disabled="busy"
        @click="emit('chooseImage')"
      />
      <OyaIconButton
        v-if="sketch.backgroundImage.value"
        size="sm"
        icon="xmark"
        :label="$t('sketch.removeImage')"
        @click="sketch.setBackgroundImage(null)"
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
    </div>
  </div>
</template>
