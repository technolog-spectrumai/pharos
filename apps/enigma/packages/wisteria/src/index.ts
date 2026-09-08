// The drawing engine's public surface.
//
// Deep imports work too (`wisteria/sketchModel`, `wisteria/SketchCanvas.vue`)
// and are what the apps actually use, mirroring how petalite and padova are
// consumed. This barrel exists for the handful of symbols a consumer wants
// without knowing which module they live in.
export * from "./sketchModel";
export * from "./svgDocument";
export * from "./sketchCrdt";
export * from "./sketchPalette";
export { createSketch, useSketch, rotatePoint } from "./useSketch";
export type { Sketch, LiveStroke, CommitReason, CommitObserver } from "./useSketch";
export { SKETCH_TOOLS } from "./tools";
export type { Tool } from "./tools";
export { exportPng, backgroundImageFromFile, setWriteFile } from "./sketchExport";
export type { WriteFile } from "./sketchExport";
