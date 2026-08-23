import { logoDir } from "../../package.json";

// One mark, two renders. The globs are single-level on purpose:
// `./**/` would also sweep in retired brands under `bkp/`.
//
// One mark, two renders. `logoDir` keeps the brand swappable in one place:
// every asset below lives in `assets/<logoDir>/`, so changing the directory
// changes the whole app's face without touching a component.
//
// Both are rendered well above their display size (128 and 512 px for a 36 px
// bar and a large welcome mark), so they stay sharp on a 2x/3x screen instead
// of being upscaled by the browser.
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
