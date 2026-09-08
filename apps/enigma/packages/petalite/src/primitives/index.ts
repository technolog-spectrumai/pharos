// The rakotis primitives, re-exported.
//
// `packages/rakotis` is an ordinary package in this repo. It WAS a git subtree
// pulled from its own remote, and that stopped being true once its code could
// only be tested here: twelve of its own assertions read enigma's price table
// and skipped themselves everywhere else. Apps still import these five through
// Petalite rather than by path, so there is exactly one place that knows where
// rakotis lives — a build detail, not a string repeated across every editor.
//
// FIVE components, not the barrel. `rakotis/src/index.ts` re-exports the whole
// P2P/MLS/chat surface; taking pieces keeps the graph to what is actually used.
// OyaQrCode lazy-imports `qrcode`, which rakotis declares but nothing
// installs — an app that shows a QR must declare `qrcode` ITSELF (Sketch does,
// for pairing), or the import fails at the moment a code is first shown.
//
// Re-exported as `.vue` default exports, so a consumer writes
// `import { OyaButton } from "petalite/primitives"` and the Vue plugin still
// compiles the SFC exactly as it would a direct import.
export { default as OyaButton } from "rakotis/components/primitives/OyaButton.vue";
export { default as OyaIconButton } from "rakotis/components/primitives/OyaIconButton.vue";
export { default as OyaModal } from "rakotis/components/primitives/OyaModal.vue";
export { default as OyaTextField } from "rakotis/components/primitives/OyaTextField.vue";
export { default as OyaQrCode } from "rakotis/components/primitives/OyaQrCode.vue";
