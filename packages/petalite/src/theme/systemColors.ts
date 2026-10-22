// The five system colours.
//
// ONE value per role, not one per theme. A role is a meaning — "the emphasised
// thing", "the thing that went wrong" — and the colours below are chosen to
// carry that meaning on white paper and on black alike, so nothing has to be
// swapped, converted or re-resolved when the theme changes.
//
// That is deliberate, and it is what makes the file formats honest: a drawing
// stores a concrete hex and a slide stores a concrete hex, so any colour that
// meant one thing in the editor and another in a viewer would be a lie in the
// file. With a universal palette there is no per-theme value to disagree about.
// Free choice lives in Settings: pick anything you like, and that one value is
// what every document, drawing and slide will use and store.
//
// Primary text is the one exception, and it is NOT a stored colour — a document
// stores a class, and the class resolves to black on light paper and white on
// dark through CSS. That is a rendering rule, not a conversion of anything that
// was saved, and it is fixed: Settings never offers it, because it is the one
// colour the legibility of every document depends on.

export const SYSTEM_ROLES = ["accent", "warning", "success", "highlight", "mute"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export type Mode = "light" | "dark";
export type SystemPalette = Record<SystemRole, string>;

/** The defaults.
 *
 *  These are the sketch's original drawing colours, which is not a coincidence:
 *  that palette was already picked to be legible on any board, which is exactly
 *  the property a single-value system role needs. Mid-tone and saturated — dark
 *  enough to read on white, bright enough to read on black. */
export const DEFAULT_PALETTE: SystemPalette = {
  accent: "#3b82f6",
  warning: "#ef4444",
  success: "#10b981",
  highlight: "#f59e0b",
  mute: "#6b7280",
};

/** Body text. A CSS rule, not a stored value — see the note at the top. */
export const PRIMARY_TEXT: Record<Mode, string> = { light: "#000000", dark: "#ffffff" };

const STORAGE_KEY = "zinnia:systemColors";

/** `#rgb` and `#rrggbb`, the two forms a colour input can produce. Anything
 *  else is refused rather than coerced: a malformed custom property does not
 *  throw, it silently resolves to nothing, and a role that renders as
 *  transparent text is much harder to diagnose than a rejected value. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** Merge stored values over the defaults, one role at a time.
 *
 *  Per ROLE, not all-or-nothing: a stored blob from an older build is missing
 *  whichever roles were added since, and discarding the whole thing to repair
 *  one absent field would throw away colours the user had deliberately set.
 *
 *  Also reads the earlier `{light, dark}` shape, taking the light value. That
 *  build shipped, so somebody's browser holds one; silently resetting their
 *  palette because the shape changed would be the wrong way to find out. */
export function normalizePalette(raw: unknown): SystemPalette {
  const stored = (raw ?? {}) as Partial<Record<SystemRole, unknown>>;
  const out = {} as SystemPalette;
  for (const role of SYSTEM_ROLES) {
    const value = stored[role];
    const flat = isHexColor(value)
      ? value
      : isHexColor((value as { light?: unknown } | undefined)?.light)
        ? ((value as { light: string }).light)
        : DEFAULT_PALETTE[role];
    out[role] = flat;
  }
  return out;
}

export function loadPalette(): SystemPalette {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizePalette(raw ? JSON.parse(raw) : null);
  } catch {
    // Unreadable or unparseable storage is not worth failing a launch over —
    // the defaults are a complete, working palette.
    return normalizePalette(null);
  }
}

export function savePalette(palette: SystemPalette): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(palette));
  } catch {
    /* a full or blocked store must not break the editor */
  }
}

/** Publish the palette as custom properties — one per role, no theme swap. */
export function applyPalette(palette: SystemPalette, root: HTMLElement = document.documentElement): void {
  for (const role of SYSTEM_ROLES) {
    root.style.setProperty(`--sys-${role}`, palette[role]);
  }
}

/** The concrete hex for a role — for consumers that STORE a colour rather than
 *  reference it, such as the sketch, which writes literal values into its svg. */
export function colorFor(palette: SystemPalette, role: SystemRole): string {
  return palette[role];
}
