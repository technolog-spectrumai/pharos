/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// ace-builds ships JS-only core/mode/theme bundles under src-noconflict without
// per-file type declarations; treat those subpath imports as untyped modules.
declare module "ace-builds/src-noconflict/*";

// trix ships no type declarations. Imported for its side effect (registering
// the <trix-editor>/<trix-toolbar> custom elements); the editor is driven
// through DOM events and the element's `editor` property.
declare module "trix";
