// The colours the sketch offers.
//
// Exactly the five system roles from Settings, plus black and white. Nothing
// else, and no per-theme variants: a drawing stores the literal hex it was
// drawn with, so a colour that resolved differently depending on the theme
// would mean one thing in the editor and another in any viewer — the drawing
// would change colour depending on who opened it.
//
// Black and white are here as fixed neutrals rather than roles because a board
// can be either paper, and "the plain one" has to be reachable for both without
// being a mode-dependent value. They are not configurable and never change.
import { computed } from "vue";
import { DEFAULT_PALETTE, SYSTEM_ROLES, type SystemPalette, type SystemRole } from "petalite/theme";
import { useSystemColors } from "petalite/theme";

export type ColorRole = SystemRole | "black" | "white";

export const NEUTRALS = { black: "#000000", white: "#ffffff" } as const;

/** Offer order: the neutrals first — the plain drawing colour is the common
 *  case — then the roles in their Settings order, so the two lists agree. */
export const COLOR_ROLES: readonly ColorRole[] = ["black", "white", ...SYSTEM_ROLES];

export interface OfferedColor {
  role: ColorRole;
  hex: string;
  /** i18n path for the swatch's name. */
  nameKey: string;
}

/** Pure, so it can be tested without a component. */
export function offeredColors(palette: SystemPalette): OfferedColor[] {
  return COLOR_ROLES.map((role) => ({
    role,
    hex: role === "black" || role === "white"
      ? NEUTRALS[role]
      : (palette[role as SystemRole] ?? DEFAULT_PALETTE[role as SystemRole]),
    nameKey: `sketch.roleNames.${role}`,
  }));
}

/** The default pen: plain black. Not theme-dependent — see the note above. */
export const DEFAULT_INK = NEUTRALS.black;

/** The live list, following a Settings edit. */
export function useSketchColors() {
  const { palette } = useSystemColors();
  return { colors: computed(() => offeredColors(palette.value)) };
}
