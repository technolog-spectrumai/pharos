import { logoDir } from "../../package.json";

// Two sizes of ONE mark: `app_icon` on the unlock/welcome gate, `bar_icon` in
// the top bar. Both are cut from the same master as the OS icon
// (`nautes/app-icon.png`), so the app's face is the same
// everywhere — the bar sits beside the product name all day, the gate is a
// single large first impression. `logoDir` keeps the brand swappable in one place:
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
