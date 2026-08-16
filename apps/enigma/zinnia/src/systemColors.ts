// The five system colours, one set per theme, chosen by the user in Settings.
//
// These are ROLES, not shades: `accent` means "the emphasised thing", and what
// hex that is depends both on the user's choice and on which paper it lands on.
// A single colour cannot serve both — #facc15 is a readable gold on a dark page
// and nearly invisible on a white one — so every role carries a light value and
// a dark value, and the file always stores whichever one was actually used.
//
// The transport is two CSS custom properties per role rather than one, with the
// swap done in CSS:
//
//     :root  { --sys-accent: var(--sys-accent-light); }
//     .dark  { --sys-accent: var(--sys-accent-dark);  }
//
// so this module writes the pairs once and never has to re-run on a theme
// change. Doing it the other way — writing a single `--sys-accent` and
// rewriting it whenever `.dark` flips — means every consumer is correct only
// as long as this module is listening, and anything that reads a colour during
// the flip gets the outgoing theme's value.
//
// Primary text is deliberately NOT here. Body text is black on light and white
// on dark, full stop: it is the one colour whose contrast the whole document
// depends on, and a user who sets it to something else has broken reading
// rather than customised it. It ships as a fixed pair below and Settings never
// offers it.

export const SYSTEM_ROLES = ["accent", "warning", "success", "highlight", "mute"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export type Mode = "light" | "dark";
export type SystemPalette = Record<SystemRole, Record<Mode, string>>;

/** The Oya defaults.
 *
 *  accent/warning/success are the platform's own values, carried across from
 *  enigma's `@theme` and the seeded "Amazing Moon" theme, so a zinnia document
 *  and a zenobia page mean the same thing by the same word.
 *
 *  The other two needed a decision, recorded here because neither was simply
 *  sitting somewhere to be copied:
 *
 *  - highlight: enigma defines one mode-independent gold (#facc15) and toto's
 *    theme fixtures carry a `caution` PAIR (#a07800 / #f0a820) that never
 *    reaches the database — `caution` is not a field on ColorMix, so the
 *    loader's field filter drops it silently. Since a role here needs a value
 *    per mode, each mode gets the oya yellow that reads on it: the darker
 *    caution on light paper, enigma's gold on dark.
 *
 *  - mute: no semantic mute token exists in any of the three trees. The nearest
 *    intents are alpha-based (`--cy-muted`, `--memo-muted-color`), which tint
 *    against whatever surface they sit on and so cannot be a hex. These are new
 *    values, picked to sit at roughly that same weight against each paper. */
export const DEFAULT_PALETTE: SystemPalette = {
  accent:    { light: "#2a6df4", dark: "#7aa2ff" },
  warning:   { light: "#d94a4a", dark: "#ff6b6b" },
  success:   { light: "#1f8a4c", dark: "#4ade80" },
  highlight: { light: "#a07800", dark: "#facc15" },
  mute:      { light: "#6b7280", dark: "#9aa3b2" },
};

/** Body text: fixed, and not offered in Settings. See the note at the top. */
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

/** Merge stored values over the defaults, one role-and-mode at a time.
 *
 *  Per FIELD, not per palette: a stored blob from an older build is missing
 *  whichever roles were added since, and an all-or-nothing check would throw
 *  away the user's other four colours to fix the one that was absent. */
export function normalizePalette(raw: unknown): SystemPalette {
  const stored = (raw ?? {}) as Partial<Record<SystemRole, Partial<Record<Mode, unknown>>>>;
  const out = {} as SystemPalette;
  for (const role of SYSTEM_ROLES) {
    out[role] = {
      light: isHexColor(stored[role]?.light) ? (stored[role]!.light as string) : DEFAULT_PALETTE[role].light,
      dark: isHexColor(stored[role]?.dark) ? (stored[role]!.dark as string) : DEFAULT_PALETTE[role].dark,
    };
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

/** Publish the palette as custom properties. Both modes' values are written;
 *  the `.dark` rule in style.css decides which one each role resolves to. */
export function applyPalette(palette: SystemPalette, root: HTMLElement = document.documentElement): void {
  for (const role of SYSTEM_ROLES) {
    root.style.setProperty(`--sys-${role}-light`, palette[role].light);
    root.style.setProperty(`--sys-${role}-dark`, palette[role].dark);
  }
}

/** The value a role resolves to for a given mode — for consumers that need a
 *  concrete hex rather than a `var()`, such as the sketch palette, which writes
 *  literal colours into the .svg it saves. */
export function colorFor(palette: SystemPalette, role: SystemRole, mode: Mode): string {
  return palette[role][mode];
}
