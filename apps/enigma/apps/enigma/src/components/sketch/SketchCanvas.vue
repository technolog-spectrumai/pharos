<script setup lang="ts">
// The drawing surface: a plain SVG whose children are the document's shapes.
//
// SVG DOM rather than canvas because Vue's keyed diff already gives us minimal
// updates when one shape changes, and because the export format IS SVG — display
// and export therefore share one representation.
//
// Everything is in fixed board units (BOARD_W x BOARD_H) so peers on different
// window sizes agree on coordinates; the viewBox letterboxes to fit, and
// `toBoard` undoes that mapping for pointer events.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  arrowHead,
  BOARD_H,
  BOARD_W,
  canFill,
  MIN_POINT_DIST,
  pathD,
  quant,
  SVG_FONT_STACK,
  trianglePoints,
  type Shape,
} from "./sketchModel";
import type { Sketch } from "./useSketch";

export type Tool = "select" | "draw" | "rect" | "ellipse" | "triangle" | "arrow" | "text" | "eraser";

const props = defineProps<{ sketch: Sketch; tool: Tool; textSize: number; darkMode?: boolean }>();
const emit = defineEmits<{ requestText: [x: number, y: number] }>();

const svgEl = ref<SVGSVGElement | null>(null);
const sketch = computed(() => props.sketch);

/** Eraser radius in board units — generous enough to catch thin strokes. */
const ERASER_RADIUS = 10;
/** Click tolerance for selecting. */
const SELECT_RADIUS = 8;
/** Side of a resize handle, board units. */
const HANDLE = 14;

// ── coordinate mapping ──────────────────────────────────────────────────────
// The rect is cached per gesture: reading getBoundingClientRect on every
// pointermove forces a layout flush.
let rectCache: DOMRect | null = null;

function refreshRect() {
  rectCache = svgEl.value?.getBoundingClientRect() ?? null;
}

function toBoard(e: PointerEvent): { x: number; y: number } {
  if (!rectCache) refreshRect();
  const r = rectCache;
  if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
  // preserveAspectRatio="xMidYMid meet" letterboxes, so undo the offset too.
  const scale = Math.min(r.width / BOARD_W, r.height / BOARD_H);
  const offX = (r.width - BOARD_W * scale) / 2;
  const offY = (r.height - BOARD_H * scale) / 2;
  return {
    x: quant((e.clientX - r.left - offX) / scale),
    y: quant((e.clientY - r.top - offY) / scale),
  };
}

window.addEventListener("resize", refreshRect);
onBeforeUnmount(() => window.removeEventListener("resize", refreshRect));

// ── gesture state ───────────────────────────────────────────────────────────

type Drag =
  | { mode: "none" }
  | { mode: "draw"; last: { x: number; y: number } }
  | { mode: "shape"; start: { x: number; y: number }; cur: { x: number; y: number } }
  | { mode: "erase"; last: { x: number; y: number } }
  | { mode: "move"; last: { x: number; y: number } }
  | { mode: "resize"; origin: { x: number; y: number }; base: { w: number; h: number } };

const drag = ref<Drag>({ mode: "none" });
/** Eraser ring follows the pointer even when not dragging. */
const cursor = ref<{ x: number; y: number } | null>(null);

function onDown(e: PointerEvent) {
  if (e.button !== 0) return;
  refreshRect();
  const p = toBoard(e);
  svgEl.value?.setPointerCapture(e.pointerId);

  switch (props.tool) {
    case "draw":
      sketch.value.beginStroke(p.x, p.y);
      drag.value = { mode: "draw", last: p };
      return;
    case "rect":
    case "ellipse":
    case "triangle":
    case "arrow":
      drag.value = { mode: "shape", start: p, cur: p };
      return;
    case "eraser":
      sketch.value.eraseAlong(p.x, p.y, p.x, p.y, ERASER_RADIUS);
      drag.value = { mode: "erase", last: p };
      return;
    case "text":
      emit("requestText", p.x, p.y);
      return;
    case "select": {
      // A press inside the resize handle scales; anywhere else selects and moves.
      const b = sketch.value.selectionBounds.value;
      if (b && withinHandle(p, b)) {
        sketch.value.beginTransform();
        drag.value = {
          mode: "resize",
          origin: { x: b.x, y: b.y },
          base: { w: Math.max(b.w, 1), h: Math.max(b.h, 1) },
        };
        return;
      }
      const hit = sketch.value.selectAt(p.x, p.y, SELECT_RADIUS);
      if (hit) {
        sketch.value.beginTransform();
        drag.value = { mode: "move", last: p };
      } else {
        drag.value = { mode: "none" };
      }
      return;
    }
  }
}

function onMove(e: PointerEvent) {
  cursor.value = toBoard(e);
  const d = drag.value;
  if (d.mode === "none") return;

  // Recover the samples the browser batched — smoother strokes at no network cost
  // (they are thinned below anyway).
  const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];

  for (const ev of events.length ? events : [e]) {
    const p = toBoard(ev);
    switch (d.mode) {
      case "draw":
        if (Math.hypot(p.x - d.last.x, p.y - d.last.y) < MIN_POINT_DIST) break;
        sketch.value.extendStroke(p.x, p.y);
        d.last = p;
        break;
      case "erase":
        sketch.value.eraseAlong(d.last.x, d.last.y, p.x, p.y, ERASER_RADIUS);
        d.last = p;
        break;
      case "shape":
        d.cur = p;
        break;
      case "move":
        sketch.value.moveSelected(p.x - d.last.x, p.y - d.last.y);
        d.last = p;
        break;
      case "resize": {
        const w = Math.max(1, p.x - d.origin.x);
        const h = Math.max(1, p.y - d.origin.y);
        // Scale relative to the size at gesture start, so the drag tracks the pointer.
        sketch.value.resizeSelected(w / d.base.w, h / d.base.h, d.origin.x, d.origin.y);
        d.base = { w, h };
        break;
      }
    }
  }
}

function onUp(e: PointerEvent) {
  const d = drag.value;
  if (d.mode === "none") return;
  svgEl.value?.releasePointerCapture?.(e.pointerId);

  if (d.mode === "draw") {
    void sketch.value.commitStroke();
  } else if (d.mode === "shape") {
    const { start, cur } = d;
    const w = cur.x - start.x;
    const h = cur.y - start.y;
    if (props.tool === "rect") sketch.value.addRect(start.x, start.y, w, h);
    else if (props.tool === "triangle") sketch.value.addTriangle(start.x, start.y, w, h);
    else if (props.tool === "arrow") sketch.value.addArrow(start.x, start.y, cur.x, cur.y);
    else if (props.tool === "ellipse") {
      sketch.value.addEllipse((start.x + cur.x) / 2, (start.y + cur.y) / 2, Math.abs(w) / 2, Math.abs(h) / 2);
    }
  } else if (d.mode === "move" || d.mode === "resize") {
    sketch.value.endTransform();
  }
  drag.value = { mode: "none" };
}

// Switching tools mid-gesture would commit a shape with the wrong kind.
watch(
  () => props.tool,
  () => {
    if (drag.value.mode === "draw") sketch.value.cancelStroke();
    drag.value = { mode: "none" };
    if (props.tool !== "select") sketch.value.clearSelection();
  },
);

// ── preview geometry for the shape being dragged out ────────────────────────

const previewShape = computed(() => {
  const d = drag.value;
  if (d.mode !== "shape") return null;
  const { start, cur } = d;
  return {
    x: Math.min(start.x, cur.x),
    y: Math.min(start.y, cur.y),
    w: Math.abs(cur.x - start.x),
    h: Math.abs(cur.y - start.y),
    x1: start.x,
    y1: start.y,
    x2: cur.x,
    y2: cur.y,
  };
});

const previewArrowHead = computed(() => {
  const p = previewShape.value;
  if (!p || props.tool !== "arrow") return "";
  return arrowHead({
    kind: "arrow",
    x1: p.x1,
    y1: p.y1,
    x2: p.x2,
    y2: p.y2,
    sw: sketch.value.currentWidth.value,
  } as never)
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
});

function triPoints(s: Shape): string {
  return trianglePoints(s as never)
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
}
function headPoints(s: Shape): string {
  return arrowHead(s as never)
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
}
function fillOf(s: Shape): string {
  return canFill(s.kind) && s.fill ? s.fill : "none";
}

// ── selection handle ────────────────────────────────────────────────────────

function withinHandle(p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  const hx = b.x + b.w;
  const hy = b.y + b.h;
  return Math.abs(p.x - hx) <= HANDLE && Math.abs(p.y - hy) <= HANDLE;
}

const selfLiveD = computed(() => {
  const l = sketch.value.selfLive.value;
  return l ? pathD(l.pts) : "";
});

const cursorClass = computed(() => {
  if (props.tool === "select") return "cursor-move";
  if (props.tool === "text") return "cursor-text";
  if (props.tool === "eraser") return "cursor-none";
  return "cursor-crosshair";
});
</script>

<template>
  <div class="relative min-h-0 w-full flex-1">
    <svg
      ref="svgEl"
      :viewBox="`0 0 ${BOARD_W} ${BOARD_H}`"
      preserveAspectRatio="xMidYMid meet"
      class="block h-full w-full touch-none select-none rounded-xl bg-white shadow-inner"
      :class="cursorClass"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="cursor = null"
    >
      <!-- Committed document, in paint order -->
      <g>
        <template v-for="s in sketch.shapes.value" :key="s.id">
          <path
            v-if="s.kind === 'path'"
            :d="pathD(s.pts)"
            fill="none"
            :stroke="s.color"
            :stroke-width="s.sw"
            :opacity="s.opacity"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <rect
            v-else-if="s.kind === 'rect'"
            :x="s.x"
            :y="s.y"
            :width="s.w"
            :height="s.h"
            :fill="fillOf(s)"
            :stroke="s.color"
            :stroke-width="s.sw"
            :opacity="s.opacity"
          />
          <ellipse
            v-else-if="s.kind === 'ellipse'"
            :cx="s.cx"
            :cy="s.cy"
            :rx="s.rx"
            :ry="s.ry"
            :fill="fillOf(s)"
            :stroke="s.color"
            :stroke-width="s.sw"
            :opacity="s.opacity"
          />
          <polygon
            v-else-if="s.kind === 'triangle'"
            :points="triPoints(s)"
            :fill="fillOf(s)"
            :stroke="s.color"
            :stroke-width="s.sw"
            :opacity="s.opacity"
            stroke-linejoin="round"
          />
          <g v-else-if="s.kind === 'arrow'" :opacity="s.opacity">
            <line
              :x1="s.x1"
              :y1="s.y1"
              :x2="s.x2"
              :y2="s.y2"
              :stroke="s.color"
              :stroke-width="s.sw"
              stroke-linecap="round"
            />
            <polygon :points="headPoints(s)" :fill="s.color" />
          </g>
          <text
            v-else-if="s.kind === 'text'"
            :x="s.x"
            :y="s.y"
            :fill="s.color"
            :opacity="s.opacity"
            :font-size="s.size"
            :font-family="SVG_FONT_STACK"
          >
            {{ s.text }}
          </text>
        </template>
      </g>

      <!-- Live overlay: my stroke (input latency) + every peer's (network latency) -->
      <g>
        <path
          v-if="selfLiveD"
          :d="selfLiveD"
          fill="none"
          :stroke="sketch.currentColor.value"
          :stroke-width="sketch.currentWidth.value"
          :opacity="sketch.currentOpacity.value"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <g v-for="l in sketch.remoteLive.value" :key="l.strokeId">
          <path
            :d="pathD(l.pts)"
            fill="none"
            :stroke="l.color"
            :stroke-width="l.sw"
            :opacity="l.opacity * 0.85"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <!-- Who is drawing it, so concurrent strokes stay legible -->
          <text
            v-if="l.pts.length >= 2 && l.authorName"
            :x="l.pts[l.pts.length - 2] + 12"
            :y="l.pts[l.pts.length - 1] - 8"
            :fill="l.color"
            font-size="20"
            opacity="0.75"
            :font-family="SVG_FONT_STACK"
          >
            {{ l.authorName }}
          </text>
        </g>
      </g>

      <!-- Shape being dragged out -->
      <g v-if="previewShape" opacity="0.8">
        <rect
          v-if="tool === 'rect'"
          :x="previewShape.x"
          :y="previewShape.y"
          :width="previewShape.w"
          :height="previewShape.h"
          :fill="sketch.currentFill.value ?? 'none'"
          :stroke="sketch.currentColor.value"
          :stroke-width="sketch.currentWidth.value"
        />
        <ellipse
          v-else-if="tool === 'ellipse'"
          :cx="previewShape.x + previewShape.w / 2"
          :cy="previewShape.y + previewShape.h / 2"
          :rx="previewShape.w / 2"
          :ry="previewShape.h / 2"
          :fill="sketch.currentFill.value ?? 'none'"
          :stroke="sketch.currentColor.value"
          :stroke-width="sketch.currentWidth.value"
        />
        <polygon
          v-else-if="tool === 'triangle'"
          :points="`${previewShape.x + previewShape.w / 2},${previewShape.y} ${previewShape.x + previewShape.w},${previewShape.y + previewShape.h} ${previewShape.x},${previewShape.y + previewShape.h}`"
          :fill="sketch.currentFill.value ?? 'none'"
          :stroke="sketch.currentColor.value"
          :stroke-width="sketch.currentWidth.value"
        />
        <g v-else-if="tool === 'arrow'">
          <line
            :x1="previewShape.x1"
            :y1="previewShape.y1"
            :x2="previewShape.x2"
            :y2="previewShape.y2"
            :stroke="sketch.currentColor.value"
            :stroke-width="sketch.currentWidth.value"
            stroke-linecap="round"
          />
          <polygon :points="previewArrowHead" :fill="sketch.currentColor.value" />
        </g>
      </g>

      <!-- Selection box + resize handle -->
      <g v-if="tool === 'select' && sketch.selectionBounds.value" pointer-events="none">
        <rect
          :x="sketch.selectionBounds.value.x - 4"
          :y="sketch.selectionBounds.value.y - 4"
          :width="sketch.selectionBounds.value.w + 8"
          :height="sketch.selectionBounds.value.h + 8"
          fill="none"
          stroke="#3b82f6"
          stroke-width="2"
          stroke-dasharray="8 6"
        />
        <rect
          :x="sketch.selectionBounds.value.x + sketch.selectionBounds.value.w - HANDLE / 2"
          :y="sketch.selectionBounds.value.y + sketch.selectionBounds.value.h - HANDLE / 2"
          :width="HANDLE"
          :height="HANDLE"
          fill="#3b82f6"
          stroke="#ffffff"
          stroke-width="2"
        />
      </g>

      <!-- Eraser ring -->
      <circle
        v-if="tool === 'eraser' && cursor"
        :cx="cursor.x"
        :cy="cursor.y"
        :r="ERASER_RADIUS"
        fill="none"
        stroke="#ef4444"
        stroke-width="2"
        pointer-events="none"
      />
    </svg>
  </div>
</template>
