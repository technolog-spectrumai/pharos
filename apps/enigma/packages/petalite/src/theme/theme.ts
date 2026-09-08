import { readonly, ref } from "vue";

// The current theme, and a way to be told when it changes.
//
// The `.dark` class on <html> is the single source of truth (App.vue owns it,
// every `dark:` utility reads it). That works for CSS, but a third-party widget
// that paints its own chrome — Univer — has to be TOLD, and told again on every
// change. Sampling the class once at mount is what left the spreadsheet dark
// after the user switched to light.
//
// A MutationObserver rather than a shared ref because the class is the truth: a
// ref would be a second copy to keep in step, and anything that sets the class
// directly would not update it.

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Call `onChange` whenever the theme changes. Returns an unsubscribe. */
export function watchDark(onChange: (dark: boolean) => void): () => void {
  let last = isDark();
  const observer = new MutationObserver(() => {
    const now = isDark();
    if (now !== last) {
      last = now;
      onChange(now);
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

/** The theme as a reactive value.
 *
 *  `isDark()` reads a DOM class, which a computed cannot depend on — a computed
 *  calling it caches its first answer forever and never recomputes on a theme
 *  change. One observer for the whole app, mirrored into a ref, so anything
 *  that must FOLLOW the theme (rather than sample it once) has something to
 *  track. The class stays the source of truth; this only reflects it. */
const dark = ref(isDark());
watchDark((on) => {
  dark.value = on;
});
export const isDarkRef = readonly(dark);
