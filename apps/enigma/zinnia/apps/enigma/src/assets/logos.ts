import { logoDir } from "../../package.json";

const darkLogos = import.meta.glob("./**/logo2_dark.png", {
  eager: true,
  import: "default",
});
const lightLogos = import.meta.glob("./**/logo2_light.png", {
  eager: true,
  import: "default",
});
const appIcons = import.meta.glob("./**/app_icon.png", {
  eager: true,
  import: "default",
});
const barIcons = import.meta.glob("./**/bar_icon.png", {
  eager: true,
  import: "default",
});

export const logo2Dark = darkLogos[`./${logoDir}/logo2_dark.png`] as string;
export const logo2Light = lightLogos[`./${logoDir}/logo2_light.png`] as string;
// The application icon (OS/window style) and the in-app top-bar icon are distinct assets.
export const appIcon = appIcons[`./${logoDir}/app_icon.png`] as string;
export const barIcon = barIcons[`./${logoDir}/bar_icon.png`] as string;
