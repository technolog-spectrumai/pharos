// Euclid — shared non-crypto UI + app foundation for Enigma and Aurora.
// No crypto, MLS, P2P, voice calls, or app/domain logic lives here.

// ── Services ──────────────────────────────────────────────────────────────────
export { isTauri, invoke } from "./services/tauri";
export * from "./services/appStorage";
export * from "./services/localDb";
export { WsService, wsService } from "./services/ws";
export type { WsStatus, WsMessage } from "./services/ws";
export * from "./services/apiBase";
export type { Participant } from "./services/types";

// ── i18n ──────────────────────────────────────────────────────────────────────
export {
  SUPPORTED_LOCALES,
  LOCALE_NAMES,
  normalizeLocale,
  getStoredLocale,
  hasExplicitLocale,
  createAppI18n,
} from "./i18n";
export type { Locale, AppI18n } from "./i18n";

// ── UI components ───────────────────────────────────────────────────────────────
export { default as OyaButton } from "./components/OyaButton.vue";
export { default as OyaCard } from "./components/OyaCard.vue";
export { default as OyaHelloWorld } from "./components/OyaHelloWorld.vue";
