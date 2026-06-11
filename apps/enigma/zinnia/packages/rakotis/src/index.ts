// Rakotis — shared MLS-over-WebSocket relay chat orchestration for Enigma and
// Aurora. Rotor-backed crypto bridge + relay transport + chat channel composable
// + MLS envelope state machine. No P2P/WebRTC, no voice calls, no product UI.
//
// Runtime layering: Rakotis depends on Euclid for non-crypto primitives (the
// generic WebSocket client, Tauri invoke, kv, runtime config, shared DTO types).
// The app's `api` instance is injected into `useChatChannel`. Crypto is delegated
// to the Rotor-backed `mls_*` Tauri commands via the crypto bridge — never reimplemented here.

// ── Crypto bridge (Rotor-backed MLS) ──────────────────────────────────────────
export { cryptoService, bytesToBase64, base64ToBytes } from "./crypto";

// ── Relay chat transport ──────────────────────────────────────────────────────
export { chatTransport } from "./chatTransport";
export type { ChatTransport, CreatedRoom, JoinedRoom } from "./chatTransport";
export type { WsStatus, WsMessage } from "./chatTransport";

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
