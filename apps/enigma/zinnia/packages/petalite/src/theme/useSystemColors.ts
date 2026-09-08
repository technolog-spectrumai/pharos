// The live system palette — one instance for the whole app.
//
// A module-level ref rather than a Pinia store: there is exactly one palette,
// nothing here needs actions/getters or devtools timeline, and Settings and the
// editors have to see the same object without either owning it. The pure
// functions stay in ./systemColors so they can be tested without a component.
import { computed, ref } from "vue";
import {
  applyPalette,
  DEFAULT_PALETTE,
  loadPalette,
  savePalette,
  type Mode,
  type SystemPalette,
  type SystemRole,
} from "./systemColors";
import { isDarkRef } from "./theme";

const palette = ref<SystemPalette>(loadPalette());

/** Publish immediately, at import time: the custom properties must exist before
 *  the first paint, or the writer's inks resolve to nothing for a frame. */
applyPalette(palette.value);

export function useSystemColors() {
  /** The theme. Still needed — plain text and the paper are mode-dependent —
   *  but no system ROLE is: those are one value each. */
  const mode = computed<Mode>(() => (isDarkRef.value ? "dark" : "light"));

  function set(role: SystemRole, hex: string) {
    palette.value = { ...palette.value, [role]: hex };
    applyPalette(palette.value);
    savePalette(palette.value);
  }

  function reset() {
    palette.value = { ...DEFAULT_PALETTE };
    applyPalette(palette.value);
    savePalette(palette.value);
  }

  return { palette, mode, set, reset };
}
