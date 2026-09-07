// The theme and the system palette.
//
// Both are shared because every app draws the same chrome in the same two
// themes, and because the palette is data an app SAVES: the sketch writes these
// literal hex values into the `.svg` files it produces (see the note in
// systemColors.ts), so a second copy that drifted would change what a drawing
// looks like when reopened elsewhere.
export { isDark, watchDark, isDarkRef } from "./theme";
export {
  SYSTEM_ROLES,
  DEFAULT_PALETTE,
  PRIMARY_TEXT,
  isHexColor,
  normalizePalette,
  loadPalette,
  savePalette,
  applyPalette,
  colorFor,
  type SystemRole,
  type SystemPalette,
  type Mode,
} from "./systemColors";
export { useSystemColors } from "./useSystemColors";
