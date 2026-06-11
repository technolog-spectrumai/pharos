import { logoDir } from "../../package.json";

const darkLogos = import.meta.glob("./**/logo2_dark.png", {
  eager: true,
  import: "default",
});
const lightLogos = import.meta.glob("./**/logo2_light.png", {
  eager: true,
  import: "default",
});
const icons = import.meta.glob("./**/icon.png", {
  eager: true,
  import: "default",
});

export const logo2Dark = darkLogos[`./${logoDir}/logo2_dark.png`] as string;
export const logo2Light = lightLogos[`./${logoDir}/logo2_light.png`] as string;
export const appIcon = icons[`./${logoDir}/icon.png`] as string;
