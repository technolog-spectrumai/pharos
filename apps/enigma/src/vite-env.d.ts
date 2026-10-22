/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// ace-builds ships JS-only core/mode/theme bundles under src-noconflict without
// per-file type declarations; treat those subpath imports as untyped modules.
declare module "ace-builds/src-noconflict/*";

// Build features, substituted by Vite at build time (buildFeatures.ts). One per
// id in src-tauri/Cargo.toml `[features]` — tests/unit/buildFeatures.test.ts
// fails if the two lists drift. Use them where code is IMPORTED or
// instantiated, so a build without the feature drops that code; for anything
// else ask rakotis' `getBuildConfig()`, which says the same thing at run time.
declare const __FEATURE_HOSTED_RELAYS__: boolean;
declare const __FEATURE_DHT__: boolean;
declare const __FEATURE_CALLS__: boolean;
declare const __FEATURE_CONTACTS__: boolean;
declare const __FEATURE_CALENDAR__: boolean;
declare const __FEATURE_KEYRING__: boolean;
declare const __FEATURE_PIN_UNLOCK__: boolean;
