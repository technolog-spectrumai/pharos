// Petalite — the shared front end.
//
// What lives here is what more than one app needs and none of them should own:
// the theme and the system palette, the i18n mechanism, file-display helpers,
// the two shared components, and the five Oya primitives.
//
// What deliberately does NOT live here: anything that identifies one app.
// `tabs.ts`, `openWith.ts`, `main.ts`, `icons.ts` registration and the i18n
// CATALOGUES stay per app — they are what makes an app that app.
//
// Subpath imports (`petalite/theme`, `petalite/primitives`) are the normal way
// in; this barrel exists for the cases that want several at once.
export * from "./theme";
export * from "./files";
export * from "./primitives";
export { createAppI18n, type SupportedLocale } from "./i18n";
export { installVueErrorHandler } from "./errorOverlay";
export { default as ModalPanel } from "./components/ModalPanel.vue";
export { default as SelectMenu } from "./components/SelectMenu.vue";
export { default as FileTree } from "./components/FileTree.vue";
export type { TreeRow } from "./components/FileTree.vue";
