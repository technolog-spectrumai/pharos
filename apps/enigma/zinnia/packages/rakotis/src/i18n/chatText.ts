// User-visible text emitted from inside rakotis, translated by the app.
//
// ── why this exists ─────────────────────────────────────────────────────────
//
// `i18n/index.ts` states the rule: the message catalogs live in the app, "so
// rakotis carries no app strings". `useChatChannel` is nevertheless the source
// of about twenty notices a user reads — "Disconnected.", "🔒 End-to-end
// encryption active.", "The room host went offline…" — and until now they were
// English literals, so a Polish user met them in English at exactly the moments
// that matter.
//
// The seam is the one `setHpTranslator` already established for Privacy HP
// labels, and for the same reason: emitting a notice should not drag the whole
// message catalog into the module that emits it. One precedent, applied twice,
// rather than two mechanisms doing the same job differently.
//
// ── the fallback, and the rule it softens ───────────────────────────────────
//
// Each call site passes its English text beside the key. That is a deliberate,
// documented softening of "no app strings in rakotis" — and the distinction is
// the one that matters: a *catalog* here would be a second source of truth that
// drifts from the app's, which is precisely what the rule prevents. A single
// fallback beside its own key cannot drift from anything, and it means an
// unregistered translator — a headless devlink channel, a unit test, a boot that
// failed before `main.ts` ran — degrades to the English that shipped yesterday
// rather than rendering `chat.sys.encrypted` at somebody mid-call.

/** Translate `key`, interpolating `{name}`-style params. */
export type ChatTranslator = (key: string, params?: Record<string, unknown>) => string;

let translator: ChatTranslator | null = null;

/** Wire the app's catalog in. Called once from `main.ts`. */
export function setChatTranslator(next: ChatTranslator | null): void {
  translator = next;
}

/** Test seam: forget the registered translator. */
export function clearChatTranslator(): void {
  translator = null;
}

/**
 * `key`'s translation, or `fallback` when no translator is registered.
 *
 * `fallback` is also what a *missing* key resolves to: vue-i18n returns the key
 * itself for one it does not know, and showing a key to a user is worse than
 * showing them last release's English.
 */
export function t(key: string, fallback: string, params?: Record<string, unknown>): string {
  if (!translator) return interpolate(fallback, params);
  try {
    const out = translator(key, params);
    // vue-i18n echoes the key back when it has no entry for it.
    return !out || out === key ? interpolate(fallback, params) : out;
  } catch {
    return interpolate(fallback, params);
  }
}

/** `{name}` substitution for the fallback path, matching vue-i18n's syntax. */
function interpolate(text: string, params?: Record<string, unknown>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    name in params ? String(params[name]) : whole,
  );
}
