// The rakotis primitives, re-exported.
//
// `packages/rakotis` is a git SUBTREE: it is pulled from its own remote and
// never edited here. Apps import these four from Petalite rather than reaching
// into the subtree by path, so there is exactly one place that knows where
// rakotis lives — which is what makes the alias a per-app build detail instead
// of a string repeated across every editor.
//
// FOUR components, not the barrel. `rakotis/src/index.ts` re-exports the whole
// P2P/MLS/chat surface plus OyaQrCode, which needs `qrcode` — a dependency that
// lives in enigma's app, not in the package. Taking pieces keeps the graph to
// what is actually used.
//
// Re-exported as `.vue` default exports, so a consumer writes
// `import { OyaButton } from "petalite/primitives"` and the Vue plugin still
// compiles the SFC exactly as it would a direct import.
export { default as OyaButton } from "rakotis/components/primitives/OyaButton.vue";
export { default as OyaIconButton } from "rakotis/components/primitives/OyaIconButton.vue";
export { default as OyaModal } from "rakotis/components/primitives/OyaModal.vue";
export { default as OyaTextField } from "rakotis/components/primitives/OyaTextField.vue";
