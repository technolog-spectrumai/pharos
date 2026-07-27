<script setup lang="ts">
// The drawing surface: a plain SVG whose children are the document's shapes.
//
// SVG DOM rather than canvas because Vue's keyed diff already gives minimal updates
// when one shape changes, and because the export format IS SVG — display and export
// therefore share one representation.
//
// Everything is in board units. The board's size is the OPEN FILE's viewBox — it
// used to be a fixed-height elastic sheet sized to the window, but a document has
// intrinsic dimensions that have to survive a round trip. The
// viewBox aspect is kept equal to the element's so the board fills its container
// edge to edge rather than letterboxing a fixed 16:9 sheet inside it, and `toBoard`
// undoes that mapping for pointer events. Rotation is applied as an
// SVG transform about each shape's pivot, and hit-testing inverts the same transform
// (see distToShapeRotated), so what you can click always matches what you can see.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  arrowHead,
  canFill,
  pathD,
  quant,
  ROTATE_SNAP_DEG,
  rotatePoint,
  shapePivot,
  SVG_FONT_STACK,
  trianglePoints,
  type Shape,
} from "./sketchModel";
import type { Sketch } from "./useSketch";

export type Tool = "select" | "draw" | "rect" | "ellipse" | "triangle" | "arrow" | "text" | "eraser";

const props = defineProps<{ sketch: Sketch; tool: Tool }>();
const emit = defineEmits<{ requestText: [x: number, y: number] }>();

const svgEl = ref<SVGSVGElement | null>(null);
const sketch = computed(() => props.sketch);

/** Eraser radius in board units — generous enough to catch thin strokes. */
const ERASER_RADIUS = 10;
/** Click tolerance for selecting. */
const SELECT_RADIUS = 8;
/** Side of the resize handle, board units. */
const HANDLE = 14;
/** Half-extent used to hit-test a handle: its drawn half-size plus a little slack
 *  for touch. Must stay well under HANDLE, or a small selected shape is grabbed by
 *  its resize handle everywhere and can never be dragged. */
const HANDLE_HIT = HANDLE / 2 + 3;
/** How far above the selection box the rotate handle sits. */
const ROTATE_OFFSET = 34;

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
  // The viewBox aspect is kept equal to the element's, so there is normally no
  // letterbox at all — but the general `meet` maths is retained rather than assuming
  // scale = height/BOARD_H, because the two can disagree for a frame after a resize
  // (boardW updates on the observer callback, the rect is read on the next pointer
  // event) and by a sub-pixel rounding of the width.
  const scale = Math.min(r.width / boardW.value, r.height / boardH.value);
  const offX = (r.width - boardW.value * scale) / 2;
  const offY = (r.height - boardH.value * scale) / 2;
  return {
    x: quant((e.clientX - r.left - offX) / scale),
    y: quant((e.clientY - r.top - offY) / scale),
  };
}

// ── elastic board width ─────────────────────────────────────────────────────
// The board fills its container instead of letterboxing a fixed 16:9 sheet inside
// it. Held in the orchestrator because the export buttons live in the parent view
// and an export must match what is on screen.

const boardW = computed(() => sketch.value.boardW.value);
const boardH = computed(() => sketch.value.boardH.value);

/** Re-measure the element rect that maps pointer coordinates into board space.
 *  A ResizeObserver rather than a window `resize` listener: the container also
 *  changes height when the toolbar wraps to a second row, which fires no window
 *  event, and it must fire once on attach so the first pointer event is right.
 *
 *  It no longer republishes a board WIDTH — the board is the file's viewBox now,
 *  so a resize changes only how the drawing is scaled into the viewport. */
function remeasure() {
  refreshRect();
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  if (svgEl.value && typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(remeasure);
    ro.observe(svgEl.value);
  }
  remeasure();
});

window.addEventListener("resize", remeasure);
onBeforeUnmount(() => {
  window.removeEventListener("resize", remeasure);
  ro?.disconnect();
  ro = null;
});

// ── gesture state ───────────────────────────────────────────────────────────

type Drag =
  | { mode: "none" }
  | { mode: "draw" }
  | { mode: "shape"; start: { x: number; y: number }; cur: { x: number; y: number } }
  | { mode: "erase"; last: { x: number; y: number } }
  | { mode: "move"; last: { x: number; y: number } }
  | {
      mode: "resize";
      origin: { x: number; y: number };
      base: { w: number; h: number };
      /** Frame captured at grab time so every step inverts the SAME rotation. */
      pivot: { cx: number; cy: number };
      rot: number;
    }
  | { mode: "rotate"; pivot: { cx: number; cy: number }; grabOffset: number };

const drag = ref<Drag>({ mode: "none" });
/** Eraser ring follows the pointer even when not dragging. */
const cursor = ref<{ x: number; y: number } | null>(null);

/** Angle from a pivot to a point, in degrees, matching SVG's clockwise positive. */
function angleTo(pivot: { cx: number; cy: number }, p: { x: number; y: number }): number {
  return (Math.atan2(p.y - pivot.cy, p.x - pivot.cx) * 180) / Math.PI;
}

function onDown(e: PointerEvent) {
  if (e.button !== 0) return;
  refreshRect();
  const p = toBoard(e);
  svgEl.value?.setPointerCapture(e.pointerId);

  switch (props.tool) {
    case "draw":
      sketch.value.beginStroke(p.x, p.y);
      drag.value = { mode: "draw" };
      return;
    case "rect":
    case "ellipse":
    case "triangle":
    case "arrow":
      drag.value = { mode: "shape", start: p, cur: p };
      return;
    case "eraser":
      sketch.value.beginErase();
      sketch.value.eraseAlong(p.x, p.y, p.x, p.y, ERASER_RADIUS);
      drag.value = { mode: "erase", last: p };
      return;
    case "text":
      emit("requestText", p.x, p.y);
      return;
    case "select": {
      const sel = sketch.value.selected.value;
      const b = sketch.value.selectionBounds.value;
      const pivot = sketch.value.selectionPivot.value;
      if (sel && b && pivot) {
        // Handles live in the shape's rotated frame, so map the pointer into it
        // before testing them — otherwise they'd only work at rot === 0.
        const local = sel.rot ? rotatePoint(p.x, p.y, pivot.cx, pivot.cy, -sel.rot) : p;
        if (Math.abs(local.x - (b.x + b.w / 2)) <= HANDLE_HIT && Math.abs(local.y - (b.y - ROTATE_OFFSET)) <= HANDLE_HIT) {
          sketch.value.beginTransform();
          // Remember where on the handle the grab started so the shape doesn't jump.
          drag.value = { mode: "rotate", pivot, grabOffset: angleTo(pivot, p) - sel.rot };
          return;
        }
        if (Math.abs(local.x - (b.x + b.w)) <= HANDLE_HIT && Math.abs(local.y - (b.y + b.h)) <= HANDLE_HIT) {
          sketch.value.beginTransform();
          drag.value = {
            mode: "resize",
            origin: { x: b.x, y: b.y },
            base: { w: Math.max(b.w, 1), h: Math.max(b.h, 1) },
            pivot,
            rot: sel.rot,
          };
          return;
        }
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

  // Recover the samples the browser batched — smoother strokes at no cost, since
  // the model thins them anyway.
  const coalesced = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
  const events = coalesced.length ? coalesced : [e];

  for (const ev of events) {
    const p = toBoard(ev);
    switch (d.mode) {
      case "draw":
        sketch.value.extendStroke(p.x, p.y);
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
        // `d.origin` lives in the shape's UNROTATED frame (selectionBounds), so the
        // pointer has to be mapped into that frame too — otherwise a rotated shape
        // is scaled along the wrong axes and collapses on the first move.
        const q = d.rot ? rotatePoint(p.x, p.y, d.pivot.cx, d.pivot.cy, -d.rot) : p;
        const w = Math.max(1, q.x - d.origin.x);
        const h = Math.max(1, q.y - d.origin.y);
        // Relative to the size at gesture start, so the drag tracks the pointer.
        sketch.value.resizeSelected(w / d.base.w, h / d.base.h, d.origin.x, d.origin.y);
        d.base = { w, h };
        break;
      }
      case "rotate": {
        let deg = angleTo(d.pivot, p) - d.grabOffset;
        if (ev.shiftKey) deg = Math.round(deg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
        sketch.value.rotateSelected(deg);
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
    sketch.value.commitStroke();
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
  } else if (d.mode === "move" || d.mode === "resize" || d.mode === "rotate") {
    sketch.value.endTransform();
  }
  drag.value = { mode: "none" };
}

// Switching tools mid-gesture would commit a shape of the wrong kind.
watch(
  () => props.tool,
  () => {
    if (drag.value.mode === "draw") sketch.value.cancelStroke();
    drag.value = { mode: "none" };
    if (props.tool !== "select") sketch.value.clearSelection();
  },
);

// ── render helpers ──────────────────────────────────────────────────────────

/** The rotate transform for a shape, or undefined so the attribute is omitted. */
function rotOf(s: Shape): string | undefined {
  if (!s.rot) return undefined;
  const { cx, cy } = shapePivot(s);
  return `rotate(${s.rot} ${cx} ${cy})`;
}
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

const selfLiveD = computed(() => {
  const l = sketch.value.selfLive.value;
  return l ? pathD(l.pts) : "";
});

/** Selection chrome is drawn inside the shape's own rotate transform, so the box
 *  and handles turn with it. */
const selectionTransform = computed(() => {
  const sel = sketch.value.selected.value;
  return sel ? rotOf(sel) : undefined;
});

const cursorClass = computed(() => {
  if (props.tool === "select") return "cursor-move";
  if (props.tool === "text") return "cursor-text";
  if (props.tool === "eraser") return "cursor-none";
  return "cursor-crosshair";
});

/** A transparent board is transparent all the way through: no sunken tint and no
 *  inner shadow, so the surface drawn on is exactly the panel behind the widget.
 *  A colour or image board is a real sheet, so it keeps the inset treatment in
 *  the letterboxed margins around it. */
const boardSurfaceClass = computed(() =>
  sketch.value.doc.value.background || sketch.value.backgroundImage.value
    ? "bg-sunken-light shadow-inner dark:bg-sunken-dark"
    : "",
);
</script>

<template>
  <div class="relative min-h-0 w-full flex-1">
    <svg
      ref="svgEl"
      :viewBox="`0 0 ${boardW} ${boardH}`"
      preserveAspectRatio="xMidYMid meet"
      class="block h-full w-full touch-none select-none rounded-xl"
      :class="[cursorClass, boardSurfaceClass]"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="cursor = null"
    >
      <!-- A transparent board paints NOTHING here AND carries no surface class,
           so the widget's own background shows through untouched — drawing
           happens over the same colour as the surrounding panel, in both light
           and dark. Matches the exports, which omit the background in exactly
           this case. -->
      <rect
        v-if="sketch.doc.value.background"
        :width="boardW"
        :height="boardH"
        :fill="sketch.doc.value.background"
      />

      <!-- Background image: cropped to the DEFAULT board at import, so on an elastic
           board its aspect no longer matches the rect. `slice` covers and crops
           rather than stretching, and both exporters do the same. -->
      <image
        v-if="sketch.backgroundImage.value"
        :href="sketch.backgroundImage.value"
        x="0"
        y="0"
        :width="boardW"
        :height="boardH"
        preserveAspectRatio="xMidYMid slice"
      />

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
            :transform="rotOf(s)"
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
            :transform="rotOf(s)"
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
            :transform="rotOf(s)"
          />
          <polygon
            v-else-if="s.kind === 'triangle'"
            :points="triPoints(s)"
            :fill="fillOf(s)"
            :stroke="s.color"
            :stroke-width="s.sw"
            :opacity="s.opacity"
            stroke-linejoin="round"
            :transform="rotOf(s)"
          />
          <g v-else-if="s.kind === 'arrow'" :opacity="s.opacity" :transform="rotOf(s)">
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
            :transform="rotOf(s)"
          >
            {{ s.text }}
          </text>
        </template>
      </g>

      <!-- Stroke in progress: local state, so it draws at input latency -->
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

      <!-- Selection box, resize + rotate handles (rotate with the shape) -->
      <g
        v-if="tool === 'select' && sketch.selectionBounds.value"
        :transform="selectionTransform"
        pointer-events="none"
      >
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
        <!-- stalk + knob for rotation -->
        <line
          :x1="sketch.selectionBounds.value.x + sketch.selectionBounds.value.w / 2"
          :y1="sketch.selectionBounds.value.y - 4"
          :x2="sketch.selectionBounds.value.x + sketch.selectionBounds.value.w / 2"
          :y2="sketch.selectionBounds.value.y - ROTATE_OFFSET"
          stroke="#3b82f6"
          stroke-width="2"
        />
        <circle
          :cx="sketch.selectionBounds.value.x + sketch.selectionBounds.value.w / 2"
          :cy="sketch.selectionBounds.value.y - ROTATE_OFFSET"
          :r="HANDLE / 2"
          fill="#3b82f6"
          stroke="#ffffff"
          stroke-width="2"
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
