import { logoDir } from "../../package.json";

// Two marks, deliberately not identical: `app_icon` is the sun-key v2 mark on
// the unlock/welcome gate, `bar_icon` the v1 mark in the top bar. They read as
// the same brand at a glance, which is the point — the bar sits beside the
// product name all day, the gate is a single large first impression. `logoDir` keeps the brand swappable in one place:
// every asset below lives in `assets/<logoDir>/`, so changing the directory
// changes the whole app's face without touching a component.
//
// Both are rendered well above their display size (128 and 512 px for a 36 px
// bar and a large welcome mark), so they stay sharp on a 2x/3x screen instead
// of being upscaled by the browser.
// Single-level on purpose: `./**/` would eagerly bundle every brand directory
// nested anywhere under assets/, including retired ones kept for reference.
const appIcons = import.meta.glob("./*/app_icon.png", {
  eager: true,
  import: "default",
});
const barIcons = import.meta.glob("./*/bar_icon.png", {
  eager: true,
  import: "default",
});

/** The large mark — the unlock/welcome gate. */
export const appIcon = appIcons[`./${logoDir}/app_icon.png`] as string;
/** The small mark — the top bar, beside the product name. */
export const barIcon = barIcons[`./${logoDir}/bar_icon.png`] as string;
