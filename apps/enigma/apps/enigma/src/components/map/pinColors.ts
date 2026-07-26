// Pin/route colours offered in the map editor.
//
// A fixed categorical list owned by the feature (the kanban convention), NOT
// the sketch model of user-reassignable slots: a colour here travels inside a
// share payload, so it must mean the same thing on the peer's map as on yours —
// a per-device palette would make that meaningless.
//
// White is excluded (invisible against a light basemap), and the first entry is
// the historical default, so "no choice" and "blue" stay the same pin.

export const MAP_PIN_COLORS = [
  "#2563eb", // blue (default)
  "#dc2626", // red
  "#059669", // green
  "#f59e0b", // amber
  "#7c3aed", // violet
  "#111827", // near-black
] as const;

export const MAP_PIN_DEFAULT_COLOR = MAP_PIN_COLORS[0];
