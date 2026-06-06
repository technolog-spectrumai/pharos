// Agnostic chat transport.
//
// The chat store talks to this and never learns how messages travel. In the
// Tauri app, Rust owns the transport via the realtime gateway (`realtime_*`
// commands + `realtime://*` events) — currently a WebSocket backend to the toto
// server, with a P2P backend swappable later behind the same commands. In a
// plain browser there is no Rust, so we fall back to the JS WebSocket client.
//
// It mirrors the surface of the old `wsService` (connect/disconnect/send/
// onMessage/onStatus/isConnected) so the store is unchanged.

import { wsService, type WsStatus, type WsMessage } from "./ws";

export type { WsStatus, WsMessage } from "./ws";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

type MessageHandler = (data: WsMessage) => void;
type StatusHandler = (status: WsStatus) => void;

export interface CreatedRoom { room: string; name: string; ticket: string }
export interface JoinedRoom { room: string; name: string }

export interface ChatTransport {
  connect(room: string): void;
  disconnect(): void;
  send(payload: Record<string, unknown>): void;
  onMessage(handler: MessageHandler): () => void;
  onStatus(handler: StatusHandler): () => void;
  readonly isConnected: boolean;
  // P2P room provisioning (desktop only; the WS/browser backend rejects these).
  createRoom(name: string): Promise<CreatedRoom>;
  joinRoom(ticket: string): Promise<JoinedRoom>;
  nodeInfo(): Promise<{ node_id: string } | null>;
}

// ── Tauri backend: the Rust realtime gateway ──────────────────────────────────
class GatewayChatTransport implements ChatTransport {
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private status: WsStatus = "disconnected";
  private currentRoom: string | null = null;
  private listening = false;

  private async ensureListeners(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ room: string; payload: string }>("realtime://message", (e) => {
      if (this.currentRoom && e.payload.room !== this.currentRoom) return;
      let data: WsMessage;
      try {
        data = JSON.parse(e.payload.payload) as WsMessage;
      } catch {
        return; // ignore malformed frames
      }
      this.messageHandlers.forEach((h) => h(data));
    });
    await listen<{ room: string; state: WsStatus }>("realtime://status", (e) => {
      if (this.currentRoom && e.payload.room !== this.currentRoom) return;
      this.setStatus(e.payload.state);
    });
  }

  private setStatus(status: WsStatus): void {
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  connect(room: string): void {
    this.currentRoom = room;
    void (async () => {
      await this.ensureListeners();
      try {
        await _invoke("realtime_connect", { room });
      } catch {
        this.setStatus("error");
      }
    })();
  }

  disconnect(): void {
    const room = this.currentRoom;
    this.currentRoom = null;
    if (room) void _invoke("realtime_leave_room", { room }).catch(() => {}); // no-op for WS rooms
    void _invoke("realtime_disconnect").catch(() => {});
    this.setStatus("disconnected");
  }

  send(payload: Record<string, unknown>): void {
    void _invoke("realtime_send", {
      room: this.currentRoom,
      payload: JSON.stringify(payload),
    }).catch(() => {});
  }

  async createRoom(name: string): Promise<CreatedRoom> {
    await this.ensureListeners();
    const res = await _invoke<CreatedRoom>("realtime_create_room", { name });
    this.currentRoom = res.room;
    return res;
  }

  async joinRoom(ticket: string): Promise<JoinedRoom> {
    await this.ensureListeners();
    const res = await _invoke<JoinedRoom>("realtime_join_room", { ticket });
    this.currentRoom = res.room;
    return res;
  }

  nodeInfo(): Promise<{ node_id: string } | null> {
    return _invoke<{ node_id: string }>("realtime_node_info");
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    void this.ensureListeners();
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    void this.ensureListeners();
    return () => this.statusHandlers.delete(handler);
  }

  get isConnected(): boolean {
    return this.status === "connected";
  }
}

// Browser fallback: delegate realtime to the JS WebSocket client; P2P rooms are
// desktop-only, so room provisioning rejects.
const browserBackend: ChatTransport = {
  connect: (room) => wsService.connect(room),
  disconnect: () => wsService.disconnect(),
  send: (payload) => wsService.send(payload),
  onMessage: (handler) => wsService.onMessage(handler),
  onStatus: (handler) => wsService.onStatus(handler),
  get isConnected() {
    return wsService.isConnected;
  },
  createRoom: () => Promise.reject(new Error("P2P rooms require the desktop app.")),
  joinRoom: () => Promise.reject(new Error("P2P rooms require the desktop app.")),
  nodeInfo: () => Promise.resolve(null),
};

export const chatTransport: ChatTransport = _isTauri()
  ? new GatewayChatTransport()
  : browserBackend;
