<script setup lang="ts">
// Raw markup from a file, rendered where its styling cannot reach the app.
//
// The alternative — `v-html` — puts the markup in the document, and a `<style>`
// element inside an inline `<svg>` is scoped to the DOCUMENT rather than to the
// SVG. One deck block could restyle everything around it. Inside a shadow root
// that same `<style>` reaches nothing outside this box.
//
// Not an iframe, deliberately. A sandboxed iframe isolates more (it would stop
// script too), but it does not size itself to its content, so every slide would
// need an explicit height, and `frame-src 'none'` would have to be relaxed. A
// shadow root costs neither and closes the styling hole, which is the half the
// Content-Security-Policy cannot reach — script is already blocked by
// `script-src 'self'`, in here as much as anywhere else.
//
// `mode: "open"` because nothing here is hiding from the app; the app is hiding
// from the CONTENT. A closed root would only make this harder to test.
import { onMounted, ref, watch } from "vue";

const props = defineProps<{ html: string }>();

const host = ref<HTMLElement | null>(null);
let root: ShadowRoot | null = null;

/** Selector-based rules do not cross the boundary, so the two the deck's own
 *  stylesheet would have applied are restated here. Inherited properties —
 *  font, colour, the block scale — DO cross, so typography needs nothing. */
const RESET = `<style>
  :host { display: contents; }
  img, svg { max-width: 100%; max-height: 100%; height: auto; }
</style>`;

function paint() {
  const el = host.value;
  if (!el) return;
  // attachShadow throws if called twice on the same element, and `host` keeps
  // its identity across a payload change — so the root is made once and its
  // contents replaced.
  if (!root) {
    try {
      root = el.attachShadow({ mode: "open" });
    } catch {
      // No shadow DOM here. Falling back to the document would silently undo
      // the isolation the user asked for, so the block renders as nothing and
      // the setting is simply not honoured rather than faked.
      return;
    }
  }
  root.innerHTML = RESET + props.html;
}

onMounted(paint);
watch(() => props.html, paint);
</script>

<template>
  <div ref="host" data-testid="shadow-host" />
</template>
