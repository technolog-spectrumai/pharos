<script setup lang="ts">
// Tool palette and board settings. Purely presentational — every mutation goes
// through the sketch orchestrator the parent owns.
//
// The settings are grouped behind five titled pickers — zoom, brush, pen
// colour, fill colour, board — rather than laid out as rows of chips. Rows of
// chips do not say what they are for: pen colour, fill colour and board colour
// were three visually identical strips of swatches, told apart only by a
// `title` on a container nobody hovers. A picker names itself.
//
// Colours are offered in BOTH shade sets, always. A drawing stores a concrete
// hex — a theme-relative colour inside an .svg would mean something different
// in every viewer — so the shade that reads on the other paper has to be
// reachable, not inferred from whichever theme happens to be on now.
import { computed, ref, watch } from "vue";
import OyaIconButton from "rakotis/components/primitives/OyaIconButton.vue";
import SketchPickerModal from "./SketchPickerModal.vue";
import SketchPickerTrigger from "./SketchPickerTrigger.vue";
import {
  BACKGROUND_COLORS,
  canFill,
  OPACITY_STEPS,
  STROKE_SIZES,
  TEXT_SIZES,
  ZOOM_STEPS,
} from "./sketchModel";
import { useSketchColors } from "./sketchPalette";
import type { Sketch } from "./useSketch";
import type { Tool } from "./SketchCanvas.vue";

const props = defineProps<{
  sketch: Sketch;
  tool: Tool;
  textSize: number;
  zoom: number;
  busy?: boolean;
  darkMode?: boolean;
}>();
const emit = defineEmits<{
  "update:tool": [Tool];
  "update:textSize": [number];
  "update:zoom": [number];
  /** So the editor can hold its document shortcuts while a picker is up. */
  "picker-open": [boolean];
  clear: [];
  chooseImage: [];
}>();

const TOOLS: { id: Tool; icon: string; labelKey: string }[] = [
  { id: "select", icon: "arrow-pointer", labelKey: "sketch.tools.select" },
  { id: "draw", icon: "pencil", labelKey: "sketch.tools.draw" },
  { id: "rect", icon: "square", labelKey: "sketch.tools.rect" },
  { id: "ellipse", icon: "circle", labelKey: "sketch.tools.circle" },
  { id: "triangle", icon: "play", labelKey: "sketch.tools.triangle" },
  { id: "line", icon: "minus", labelKey: "sketch.tools.line" },
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

// ── the palette ─────────────────────────────────────────────────────────────
// Exactly what Settings holds, plus black and white. One list, no theme
// variants: see sketchPalette.ts for why a drawing cannot afford them.
const { colors } = useSketchColors();

/** Chip label. A colour from a loaded file is not in the offered list — its
 *  hex is the only honest name for it. */
function labelOf(c: string): string {
  return colors.value.find((o) => o.hex === c)?.nameKey ?? "";
}

// ── pickers ─────────────────────────────────────────────────────────────────
type PickerId = "zoom" | "brush" | "pen" | "fill" | "board";

const openPicker = ref<PickerId | null>(null);

function togglePicker(id: PickerId) {
  openPicker.value = openPicker.value === id ? null : id;
}
function closePicker() {
  openPicker.value = null;
}

// The editor holds shortcuts while a picker is up: a modal's buttons are not
// INPUT/TEXTAREA, so the window-level guard does not cover them.
watch(openPicker, (id) => emit("picker-open", id !== null));

function onCatalogueClick(c: string) {
  pickColor(c);
  closePicker();
}

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

// The fill picker's trigger disappears when fill stops applying; close it too,
// or the modal outlives the control that opened it.
watch(fillApplies, (ok) => {
  if (!ok && openPicker.value === "fill") closePicker();
});

/** Degrees field. `.lazy` matters: without it every keystroke of "180" would commit
 *  1, then 18, then 180 as three separate undo entries (and clear redo three times).
 *  Committing on change/blur makes a typed angle one undoable step. */
const rotation = computed({
  get: () => props.sketch.selected.value?.rot ?? 0,
  set: (deg: number) => props.sketch.setSelectedRotation(deg),
});

function setBackgroundColor(c: string) {
  props.sketch.setBackground(c);
  closePicker();
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-accent-2 px-3 py-2 dark:border-accent-1"
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

    <!-- ── zoom ─────────────────────────────────────────────────────────── -->
    <SketchPickerTrigger
      :label="$t('sketch.zoom')"
      :open="openPicker === 'zoom'"
      data-testid="trigger-zoom"
      @click="togglePicker('zoom')"
    >
      <font-awesome-icon icon="magnifying-glass" class="opacity-70" />
      <span>{{ Math.round(zoom * 100) }}%</span>
    </SketchPickerTrigger>

    <SketchPickerModal
      :open="openPicker === 'zoom'"
      :title="$t('sketch.zoomTitle')"
      @close="closePicker()"
    >
      <div class="grid grid-cols-4 gap-1.5" data-testid="modal-zoom">
        <button
          v-for="s in ZOOM_STEPS"
          :key="s"
          type="button"
          class="rounded-lg border px-2 py-1.5 text-xs font-semibold transition"
          :class="
            zoom === s
              ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
              : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
          "
          :data-testid="`zoom-${s}`"
          @click="emit('update:zoom', s); closePicker()"
        >
          {{ Math.round(s * 100) }}%
        </button>
      </div>
    </SketchPickerModal>

    <!-- ── brush ────────────────────────────────────────────────────────── -->
    <SketchPickerTrigger
      :label="$t('sketch.brush')"
      :open="openPicker === 'brush'"
      data-testid="trigger-brush"
      @click="togglePicker('brush')"
    >
      <!-- The dot IS the brush: size, colour and opacity as they will draw. -->
      <span
        class="inline-block rounded-full"
        :style="{
          width: `${Math.min(sketch.currentWidth.value, 12)}px`,
          height: `${Math.min(sketch.currentWidth.value, 12)}px`,
          backgroundColor: sketch.currentColor.value,
          opacity: sketch.currentOpacity.value,
        }"
      />
      <span>{{ sketch.currentWidth.value }}</span>
    </SketchPickerTrigger>

    <SketchPickerModal
      :open="openPicker === 'brush'"
      :title="$t('sketch.brushTitle')"
      @close="closePicker()"
    >
      <!-- Stays open across picks: three settings, one visit. -->
      <div class="space-y-3" data-testid="modal-brush">
        <div>
          <p class="mb-1 text-xs font-semibold opacity-70">{{ $t("sketch.size") }}</p>
          <div class="flex items-center gap-1">
            <button
              v-for="w in STROKE_SIZES"
              :key="w"
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-lg border transition"
              :class="
                sketch.currentWidth.value === w
                  ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
                  : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
              "
              :aria-label="`${w}`"
              :data-testid="`width-${w}`"
              @click="pickWidth(w)"
            >
              <span class="rounded-full bg-current" :style="{ width: `${w}px`, height: `${w}px` }" />
            </button>
          </div>
        </div>

        <div>
          <p class="mb-1 text-xs font-semibold opacity-70">{{ $t("sketch.opacity") }}</p>
          <div class="flex items-center gap-1">
            <button
              v-for="o in OPACITY_STEPS"
              :key="o"
              type="button"
              class="h-8 rounded-lg border px-2 text-[11px] font-bold transition"
              :class="
                sketch.currentOpacity.value === o
                  ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
                  : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
              "
              :data-testid="`opacity-${o}`"
              @click="pickOpacity(o)"
            >
              {{ Math.round(o * 100) }}%
            </button>
          </div>
        </div>

        <div>
          <p class="mb-1 text-xs font-semibold opacity-70">{{ $t("sketch.textSize") }}</p>
          <div class="flex items-center gap-1">
            <button
              v-for="s in TEXT_SIZES"
              :key="s"
              type="button"
              class="h-8 rounded-lg border px-2 text-xs font-bold transition"
              :class="
                textSize === s
                  ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
                  : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
              "
              :data-testid="`textsize-${s}`"
              @click="emit('update:textSize', s)"
            >
              {{ s }}
            </button>
          </div>
        </div>

        <div class="border-t pt-3 border-accent-2/50 dark:border-accent-1/50">
          <label class="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              class="mt-0.5 h-4 w-4 cursor-pointer accent-current"
              data-testid="brush-sticky"
              :checked="sketch.sticky.value"
              @change="sketch.sticky.value = ($event.target as HTMLInputElement).checked"
            />
            <span class="min-w-0">
              <span class="block text-xs font-semibold">{{ $t("sketch.sticky") }}</span>
              <span class="block text-[11px] leading-snug opacity-60">
                {{ $t("sketch.stickyHint") }}
              </span>
            </span>
          </label>
        </div>
      </div>
    </SketchPickerModal>

    <!-- ── pen colour ───────────────────────────────────────────────────── -->
    <SketchPickerTrigger
      :label="$t('sketch.color')"
      :open="openPicker === 'pen'"
      data-testid="trigger-pen"
      @click="togglePicker('pen')"
    >
      <span
        class="h-4 w-4 rounded-full border border-current/30"
        :style="{ backgroundColor: sketch.currentColor.value }"
      />
    </SketchPickerTrigger>

    <SketchPickerModal
      :open="openPicker === 'pen'"
      :title="$t('sketch.penColorTitle')"
      @close="closePicker()"
    >
      <div class="space-y-3" data-testid="modal-pen">
        <div>
          <p class="mb-1 text-xs font-semibold opacity-70">{{ $t("sketch.palette") }}</p>
          <div class="grid grid-cols-7 gap-1.5">
            <button
              v-for="o in colors"
              :key="o.role"
              type="button"
              class="h-7 w-7 rounded-full border-2 transition hover:scale-110"
              :class="sketch.currentColor.value === o.hex ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
              :style="{ backgroundColor: o.hex }"
              :data-testid="`swatch-${o.role}`"
              :aria-label="$t(o.nameKey)"
              :title="$t(o.nameKey)"
              @click="onCatalogueClick(o.hex)"
            />
          </div>
        </div>
      </div>
    </SketchPickerModal>

    <!-- ── fill ─────────────────────────────────────────────────────────── -->
    <SketchPickerTrigger
      v-if="fillApplies"
      :label="$t('sketch.fill')"
      :open="openPicker === 'fill'"
      data-testid="trigger-fill"
      @click="togglePicker('fill')"
    >
      <span
        v-if="sketch.currentFill.value"
        class="h-4 w-4 rounded border border-current/30"
        :style="{ backgroundColor: sketch.currentFill.value }"
      />
      <font-awesome-icon v-else icon="ban" class="opacity-70" />
    </SketchPickerTrigger>

    <SketchPickerModal
      :open="openPicker === 'fill'"
      :title="$t('sketch.fillTitle')"
      @close="closePicker()"
    >
      <div class="space-y-3" data-testid="modal-fill">
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition"
          :class="
            sketch.currentFill.value === null
              ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
              : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
          "
          data-testid="fill-none"
          @click="pickFill(null); closePicker()"
        >
          <font-awesome-icon icon="ban" /> {{ $t("sketch.noFill") }}
        </button>

        <div>
          <p class="mb-1 text-xs font-semibold opacity-70">{{ $t("sketch.palette") }}</p>
          <div class="grid grid-cols-7 gap-1.5">
            <button
              v-for="o in colors"
              :key="o.role"
              type="button"
              class="h-7 w-7 rounded border-2 transition hover:scale-110"
              :class="sketch.currentFill.value === o.hex ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
              :style="{ backgroundColor: o.hex }"
              :data-testid="`fill-swatch-${o.role}`"
              :aria-label="$t(o.nameKey)"
              :title="$t(o.nameKey)"
              @click="pickFill(o.hex); closePicker()"
            />
          </div>
        </div>
      </div>
    </SketchPickerModal>

    <!-- ── board ────────────────────────────────────────────────────────── -->
    <SketchPickerTrigger
      :label="$t('sketch.background')"
      :open="openPicker === 'board'"
      data-testid="trigger-board"
      @click="togglePicker('board')"
    >
      <span
        v-if="background"
        class="h-4 w-4 rounded border border-current/30"
        :style="{ backgroundColor: background }"
      />
      <font-awesome-icon v-else icon="ban" class="opacity-70" />
    </SketchPickerTrigger>

    <SketchPickerModal
      :open="openPicker === 'board'"
      :title="$t('sketch.backgroundTitle')"
      @close="closePicker()"
    >
      <div class="space-y-3" data-testid="modal-board">
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition"
          :class="
            background === null
              ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark'
              : 'border-accent-2 dark:border-accent-1 hover:opacity-80'
          "
          data-testid="board-none"
          @click="sketch.setBackground(null); closePicker()"
        >
          <font-awesome-icon icon="ban" /> {{ $t("sketch.noBackground") }}
        </button>

        <div>
          <p class="mb-1 text-xs font-semibold opacity-70">{{ $t("sketch.paperGroup") }}</p>
          <!-- White and black. IDLE_SWATCH matters more here than anywhere else:
               the two swatches ARE white and near-black, so a ring that vanishes
               in one theme loses one of the only two chips in the row. -->
          <div class="flex items-center gap-1.5">
            <button
              v-for="c in BACKGROUND_COLORS"
              :key="`bg-${c}`"
              type="button"
              class="h-7 w-7 rounded border-2 transition hover:scale-110"
              :class="background === c ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
              :style="{ backgroundColor: c }"
              :data-testid="`board-${c.slice(1)}`"
              :aria-label="labelOf(c) ? $t(labelOf(c)) : c"
              :title="labelOf(c) ? $t(labelOf(c)) : c"
              @click="setBackgroundColor(c)"
            />
          </div>
        </div>

        <div>
          <p class="mb-1 text-xs font-semibold opacity-70">{{ $t("sketch.palette") }}</p>
          <div class="grid grid-cols-7 gap-1.5">
            <button
              v-for="o in colors"
              :key="o.role"
              type="button"
              class="h-7 w-7 rounded border-2 transition hover:scale-110"
              :class="background === o.hex ? 'border-accent-light dark:border-accent-dark' : IDLE_SWATCH"
              :style="{ backgroundColor: o.hex }"
              :data-testid="`board-swatch-${o.role}`"
              :aria-label="$t(o.nameKey)"
              :title="$t(o.nameKey)"
              @click="setBackgroundColor(o.hex)"
            />
          </div>
        </div>

        <!-- `busy` still gates this: a save in progress must not be raced by a
             background-image import. -->
        <div class="flex items-center gap-2 border-t border-current/10 pt-3">
          <OyaIconButton
            size="sm"
            icon="file-image"
            :label="$t('sketch.chooseImage')"
            :disabled="busy"
            data-testid="board-image"
            @click="emit('chooseImage')"
          />
          <OyaIconButton
            v-if="sketch.backgroundImage.value"
            size="sm"
            icon="xmark"
            :label="$t('sketch.removeImage')"
            data-testid="board-image-remove"
            @click="sketch.setBackgroundImage(null)"
          />
        </div>
      </div>
    </SketchPickerModal>

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
