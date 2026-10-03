// The Oya primitives both apps use.
//
// These five lived in enigma's rakotis and were re-exported from here; now
// they ARE here, and rakotis re-exports them the other way. They are the part
// of rakotis that never knew anything about enigma — a button, an icon button,
// a modal, a text field, a QR code — so they belong with what both apps share,
// and an app that wants a button no longer depends on a chat library to get it.
//
// The rest of the Oya set (cards, badges, the Privacy HP meter and price) stays
// in rakotis: only enigma uses it, and two of them import its price table.
//
// OyaQrCode lazy-imports `qrcode`, which this package does not install — an
// app that shows a QR must declare `qrcode` ITSELF, or the import fails at the
// moment a code is first shown.
//
// Exported as `.vue` default exports, so a consumer writes
// `import { OyaButton } from "petalite/primitives"` and the Vue plugin still
// compiles the SFC exactly as it would a direct import.
export { default as OyaButton } from "./OyaButton.vue";
export { default as OyaIconButton } from "./OyaIconButton.vue";
export { default as OyaModal } from "./OyaModal.vue";
export { default as OyaTextField } from "./OyaTextField.vue";
export { default as OyaQrCode } from "./OyaQrCode.vue";
