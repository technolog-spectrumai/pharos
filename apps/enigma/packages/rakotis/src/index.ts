// Rakotis — reusable app primitives for Enigma27: the non-crypto foundation
// (services, i18n) plus the P2P chat orchestration
// (Rotor-backed crypto bridge, iroh transport bridge, chat channel composable +
// MLS envelope state machine). Crypto is delegated to the Rotor-backed `mls_*`
// Tauri commands — never reimplemented here.

// ── Services ──────────────────────────────────────────────────────────────────
export { isTauri, invoke } from "./services/tauri";
export * from "./services/appStorage";
export * from "./services/localDb";
export * from "./chatHistoryModel";
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

// ── Crypto bridge (Rotor-backed MLS) ──────────────────────────────────────────
export { cryptoService, bytesToBase64, base64ToBytes } from "./crypto";

// ── P2P chat transport ────────────────────────────────────────────────────────
export { chatTransport } from "./chatTransport";
export type { ChatTransport, OpenedRoom, WsStatus, WsMessage } from "./chatTransport";

// ── Chat channel composable + MLS envelope state machine ──────────────────────
export { useChatChannel, isInviteTicket, downscaleImageToDataUrl } from "./useChatChannel";
// The shared engine's options (technology.md §"Shared room engine"): a server mailbox, threads.
export {
  MAILBOX_KIND, NODE_KIND, INLINE_MAX, MemMailbox, frameId, envelope, catchUp, freshPlace, note, tagsOf, mentionsName,
} from "./mailbox";
export type { ChatMailbox, MailboxPlace } from "./mailbox";
// Fakes of the engine's outside (in-memory gossip, an MLS stand-in, kv) for tests and demos.
export { MemHub, MlsWorld, fakeMls, fakeSlug, memKv } from "./fakes";
export type {
  ChatCrypto,
  ChatChannel,
  ChatChannelOptions,
  Message,
  MlsStatus,
  P2pRoomEntry,
} from "./useChatChannel";
