// The Oya primitives both apps use.
//
// Every Oya primitive that knows nothing about one app: a button, an icon
// button, a modal, a text field, a text area, a QR code, a card, a badge, an
// avatar, a copy field, an empty state and a section header. They began in
// vesper's rakotis; the apps import them from here (Vesper included).
//
// Only the Privacy HP meter and price stay in rakotis: they import vesper's
// price table.
//
// OyaQrCode lazy-imports `qrcode`, which this package declares, so any app
// that lists petalite as a workspace gets it installed.
//
// Exported as `.vue` default exports, so a consumer writes
// `import { OyaButton } from "petalite/primitives"` and the Vue plugin still
// compiles the SFC exactly as it would a direct import.
export { default as OyaButton } from "./OyaButton.vue";
export { default as OyaIconButton } from "./OyaIconButton.vue";
export { default as OyaModal } from "./OyaModal.vue";
export { default as OyaTextField } from "./OyaTextField.vue";
export { default as OyaQrCode } from "./OyaQrCode.vue";
export { default as OyaTextArea } from "./OyaTextArea.vue";
export { default as OyaCard } from "./OyaCard.vue";
export { default as OyaBadge } from "./OyaBadge.vue";
export { default as OyaAvatar } from "./OyaAvatar.vue";
export { default as OyaCopyField } from "./OyaCopyField.vue";
export { default as OyaEmptyState } from "./OyaEmptyState.vue";
export { default as OyaSectionHeader } from "./OyaSectionHeader.vue";
