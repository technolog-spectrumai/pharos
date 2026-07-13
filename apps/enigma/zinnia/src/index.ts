// Rakotis — reusable app primitives for Enigma: the non-crypto foundation
// (services, i18n, Oya UI components) plus the P2P chat orchestration
// (Rotor-backed crypto bridge, iroh transport bridge, chat channel composable +
// MLS envelope state machine). Crypto is delegated to the Rotor-backed `mls_*`
// Tauri commands — never reimplemented here.

// ── Services ──────────────────────────────────────────────────────────────────
export { isTauri, invoke } from "./services/tauri";
export * from "./services/appStorage";
export * from "./services/localDb";
export type { Participant, Room } from "./services/types";

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

// ── UI components ─────────────────────────────────────────────────────────────
export { default as OyaButton } from "./components/OyaButton.vue";
export { default as OyaCard } from "./components/OyaCard.vue";
export { default as OyaHelloWorld } from "./components/OyaHelloWorld.vue";

// ── Crypto bridge (Rotor-backed MLS) ──────────────────────────────────────────
export { cryptoService, bytesToBase64, base64ToBytes } from "./crypto";

// ── P2P chat transport ────────────────────────────────────────────────────────
export { chatTransport } from "./chatTransport";
export type { ChatTransport, CreatedRoom, JoinedRoom, WsStatus, WsMessage } from "./chatTransport";

// ── Chat channel composable + MLS envelope state machine ──────────────────────
export { useChatChannel } from "./useChatChannel";
export type {
  ChatChannel,
  Message,
  MlsStatus,
  P2pRoomEntry,
} from "./useChatChannel";
