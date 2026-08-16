/// <reference types="vite/client" />
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

// ace-builds ships JS-only mode/theme/worker bundles under src-noconflict
// without per-file type declarations; treat those subpath imports as untyped.
declare module "ace-builds/src-noconflict/*";
