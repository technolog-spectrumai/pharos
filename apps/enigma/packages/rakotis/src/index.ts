// Rakotis — reusable app primitives for the Enigma family: the non-crypto
// foundation (services, i18n, Oya UI components) plus the MLS-over-WebSocket
// relay chat orchestration (Rotor-backed crypto bridge, relay transport, chat
// channel composable + MLS envelope state machine). Crypto is delegated to the
// Rotor-backed `mls_*` Tauri commands — never reimplemented here.

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

// ── UI components ─────────────────────────────────────────────────────────────
export { default as OyaButton } from "./components/OyaButton.vue";
export { default as OyaCard } from "./components/OyaCard.vue";
export { default as OyaHelloWorld } from "./components/OyaHelloWorld.vue";

// ── Crypto bridge (Rotor-backed MLS) ──────────────────────────────────────────
export { cryptoService, bytesToBase64, base64ToBytes } from "./crypto";

// ── Relay chat transport ──────────────────────────────────────────────────────
export { chatTransport } from "./chatTransport";
export type { ChatTransport, CreatedRoom, JoinedRoom } from "./chatTransport";

// ── Relay command seam ────────────────────────────────────────────────────────
export { relayCommandHandlers, runChatCommand } from "./chatCommands";
export type { ChatCommandContext, ChatCommandHandler } from "./chatCommands";

// ── Chat channel composable + MLS envelope state machine ──────────────────────
export { useChatChannel } from "./useChatChannel";
export type {
  ChatChannel,
  ChannelKind,
  Message,
  MlsStatus,
  P2pRoomEntry,
  RelayChatApi,
} from "./useChatChannel";
