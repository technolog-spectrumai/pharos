// Rakotis — reusable app primitives for Vesper: the non-crypto foundation
// (services, i18n, Oya UI components) plus the P2P chat orchestration
// (Rotor-backed crypto bridge, iroh transport bridge, chat channel composable +
// MLS envelope state machine). Crypto is delegated to the Rotor-backed `mls_*`
// Tauri commands — never reimplemented here.

// ── Services ──────────────────────────────────────────────────────────────────
export { isTauri, invoke } from "./services/tauri";
export * from "./services/appStorage";
export * from "./services/localDb";
export * from "./services/contacts";
export * from "./services/moderation";
export * from "./chatHistoryModel";
// Privacy HP: the pure policy model (types, prices, meter derivation, copy) and
// the bridge to the Rust ledger. technology.md §17.
export * from "./privacyHp";
export * from "./services/hp";
export * from "./services/chatLog";
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
// The seam the app uses to translate notices rakotis emits (see chatText.ts).
export { setChatTranslator, clearChatTranslator } from "./i18n/chatText";
export {
  formatDate,
  formatTime,
  formatNumber,
  formatBytes,
  currentLocale,
  resetDateFormatCache,
} from "./i18n/dateFormat";
export type { DateStyle, DateInput } from "./i18n/dateFormat";
export type { ChatTranslator } from "./i18n/chatText";

// ── UI components ─────────────────────────────────────────────────────────────
// The Oya primitives are petalite's (petalite/primitives); only the two that
// read vesper's Privacy HP price table stay here. Explicit single-level
// re-exports (NOT `export *` through a sub-barrel): WebKit's JavaScriptCore
// fails to resolve a two-level chain in unbundled dev ESM.
export { default as OyaHpPrice } from "./components/primitives/OyaHpPrice.vue";
export { default as OyaHpMeter } from "./components/primitives/OyaHpMeter.vue";

// ── Crypto bridge (Rotor-backed MLS) ──────────────────────────────────────────
export { cryptoService, bytesToBase64, base64ToBytes } from "./crypto";

// ── P2P chat transport ────────────────────────────────────────────────────────
export { chatTransport } from "./chatTransport";
export type { ChatTransport, CreatedRoom, JoinedRoom, WsStatus, WsMessage } from "./chatTransport";

// ── Chat channel composable + MLS envelope state machine ──────────────────────
export { useChatChannel, isInviteTicket, downscaleImageToDataUrl } from "./useChatChannel";
export type {
  ChatChannel,
  ChatChannelOptions,
  Message,
  MlsStatus,
  P2pRoomEntry,
} from "./useChatChannel";
