// The toolbar's tools, in one place OUTSIDE the component.
//
// Not for tidiness: `<script setup>` cannot export a binding, so a list living
// inside the component is invisible to tests — and the icon scanner only reads
// `icon="…"` attributes out of templates, never a TS object literal. The line
// tool shipped with an unregistered `minus` and rendered as NOTHING, which is
// precisely the silent failure src/icons.ts exists to prevent. Exported here,
// the names are asserted like every tab's.
/** Which tool the pointer is currently driving.
 *
 *  Defined HERE and not in the canvas for the same reason the list is: a type
 *  exported from `<script setup>` is reachable from a component import but not
 *  from a plain module, and `vue-tsc` resolves `"./SketchCanvas.vue"` through
 *  the shim rather than the SFC when a `.ts` file asks for it. The canvas
 *  re-exports it so existing `import { type Tool } from ".../SketchCanvas.vue"`
 *  call sites keep working. */
export type Tool =
  | "select"
  | "draw"
  | "rect"
  | "ellipse"
  | "triangle"
  | "line"
  | "arrow"
  | "text"
  | "eraser";

export const SKETCH_TOOLS: { id: Tool; icon: string; labelKey: string }[] = [
  { id: "select", icon: "arrow-pointer", labelKey: "sketch.tools.select" },
  { id: "draw", icon: "pencil", labelKey: "sketch.tools.draw" },
  { id: "rect", icon: "square", labelKey: "sketch.tools.rect" },
  { id: "ellipse", icon: "circle", labelKey: "sketch.tools.circle" },
  { id: "triangle", icon: "play", labelKey: "sketch.tools.triangle" },
  { id: "line", icon: "slash", labelKey: "sketch.tools.line" },
  { id: "arrow", icon: "arrow-right", labelKey: "sketch.tools.arrow" },
  { id: "text", icon: "font", labelKey: "sketch.tools.text" },
  { id: "eraser", icon: "eraser", labelKey: "sketch.tools.eraser" },
];
