/// <reference types="vite/client" />
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

// ace-builds ships JS-only mode/theme/worker bundles under src-noconflict
// without per-file type declarations; treat those subpath imports as untyped.
declare module "ace-builds/src-noconflict/*";

// reveal.js ships no type declarations and has no @types package; the player
// declares the slice of the API it actually calls (see DeckPlayer.vue).
declare module "reveal.js";
declare module "reveal.js/dist/reveal.css";
