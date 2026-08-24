// Rakotis — reusable app primitives for Enigma26: the non-crypto foundation
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
export * from "./services/mapData";
export * from "./mapModel";
export * from "./chatHistoryModel";
// Privacy MANA: the pure policy model (types, prices, meter derivation, copy) and
// the bridge to the Rust ledger. technology.md §17.
export * from "./privacyMana";
export * from "./services/mana";
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

// ── UI components (Oya primitives) ────────────────────────────────────────────
// Explicit single-level re-exports (NOT `export *` through a sub-barrel): WebKit's
// JavaScriptCore fails to resolve a two-level `export * → export { default as … }`
// chain in unbundled dev ESM ("Importing binding name 'X' is not found"), even
// though bundlers flatten it fine. Keep these direct.
export { default as OyaButton } from "./components/primitives/OyaButton.vue";
export { default as OyaCard } from "./components/primitives/OyaCard.vue";
export { default as OyaIconButton } from "./components/primitives/OyaIconButton.vue";
export { default as OyaTextField } from "./components/primitives/OyaTextField.vue";
export { default as OyaTextArea } from "./components/primitives/OyaTextArea.vue";
export { default as OyaBadge } from "./components/primitives/OyaBadge.vue";
export { default as OyaCopyField } from "./components/primitives/OyaCopyField.vue";
export { default as OyaQrCode } from "./components/primitives/OyaQrCode.vue";
export { default as OyaAvatar } from "./components/primitives/OyaAvatar.vue";
export { default as OyaEmptyState } from "./components/primitives/OyaEmptyState.vue";
export { default as OyaSectionHeader } from "./components/primitives/OyaSectionHeader.vue";
export { default as OyaModal } from "./components/primitives/OyaModal.vue";
export { default as OyaManaPrice } from "./components/primitives/OyaManaPrice.vue";
export { default as OyaManaMeter } from "./components/primitives/OyaManaMeter.vue";

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
  MapShare,
  MlsStatus,
  P2pRoomEntry,
} from "./useChatChannel";
