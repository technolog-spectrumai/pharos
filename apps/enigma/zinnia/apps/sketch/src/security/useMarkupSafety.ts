// How markup a file brought with it gets rendered.
//
// A deck's `svg` and `html` blocks are the only places this app puts markup it
// did not author into the page. Three switches decide what happens to it, all
// off by default, all remembered.
//
//   isolate      — render it in a shadow root, where a `<style>` it carries
//                  reaches nothing outside its own box. This is the one that
//                  closes the hole the Content-Security-Policy cannot: ACE,
//                  FontAwesome, TipTap, reveal.js and Univer all inject
//                  `<style>` elements with text content, so locking
//                  `style-src-elem` to the app's own files would break every
//                  editor. Costs a shadow root per block.
//   blockStyles  — take stylesheets out of it before it is rendered at all.
//   blockScripts — take `<script>`, `on*` handlers and `javascript:` targets
//                  out of it. Already unable to RUN, thanks to
//                  `script-src 'self'`; this stops it reaching the DOM.
//
// Off by default, every one of them, for different reasons. Isolation costs a
// little to draw and nobody has measured it on a long deck yet. The two
// blockers change what a slide LOOKS like — a deck that styles itself would
// come out plain — so they are a choice about someone else's document, not a
// default this app gets to make for them.
//
// The stripping the two blockers do never touches the file: a block is rendered
// from the payload on every paint and written back untouched.
import { ref, computed } from "vue";
import type { ScrubOptions } from "./scrub";

const KEYS = {
  isolate: "zinnia:sandbox",
  blockStyles: "zinnia:blockStyles",
  blockScripts: "zinnia:blockScripts",
} as const;

export type MarkupSwitch = keyof typeof KEYS;

/** Absent means off. Only the exact string "1" is on, so a half-written value
 *  fails safe rather than silently enabling something. */
function load(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

const state = {
  isolate: ref(load(KEYS.isolate)),
  blockStyles: ref(load(KEYS.blockStyles)),
  blockScripts: ref(load(KEYS.blockScripts)),
};

export function useMarkupSafety() {
  /** What `scrub()` needs, in one object, so a caller cannot read one switch
   *  and forget the other. */
  const scrubbing = computed<ScrubOptions>(() => ({
    styles: state.blockStyles.value,
    scripts: state.blockScripts.value,
  }));

  function set(which: MarkupSwitch, on: boolean): void {
    state[which].value = on;
    try {
      localStorage.setItem(KEYS[which], on ? "1" : "0");
    } catch {
      /* a full or blocked store must not break the setting */
    }
  }

  return { ...state, scrubbing, set };
}
