// Whether raw markup from a file renders in a scope of its own.
//
// A deck's `svg` and `html` blocks are the only places this app puts markup it
// did not author into the page. Normally they are interpolated straight in,
// which means a `<style>` element inside an inline `<svg>` applies to the whole
// DOCUMENT — SVG does not scope it — so such a block can restyle the app around
// it. The Content-Security-Policy cannot help: ACE, FontAwesome, TipTap,
// reveal.js and Univer all inject `<style>` elements with text content, so
// locking `style-src-elem` to the app's own files would break every editor.
//
// Turning this on renders those two block types inside a SHADOW ROOT, where a
// `<style>` reaches nothing outside it. That is real isolation rather than a
// policy, and it is the answer for the half CSP cannot reach.
//
// OPTIONAL, and off by default, because it is not free: every such block gets
// its own shadow root, and a deck's gallery paints one per block per slide. The
// cost has not been measured on a large deck yet, so this is a switch to
// measure with rather than a default to assume.
//
// Independent of `contain: layout` in slide.css, which stops a positioned
// overlay escaping its slide. That one is always on and costs nothing; this one
// scopes the styling itself.
import { ref } from "vue";

const STORAGE_KEY = "zinnia:sandbox";

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const enabled = ref<boolean>(load());

export function useSandbox() {
  function set(on: boolean): void {
    enabled.value = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* a full or blocked store must not break the setting */
    }
  }

  return { enabled, set };
}
