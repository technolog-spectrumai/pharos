// Agnostic chat transport.
//
// The chat store talks to this and never learns how messages travel. In the
// Tauri app, Rust owns the transport via the realtime gateway (`realtime_*`
// commands + `realtime://*` events): a WebSocket backend to the toto server and
// a P2P (iroh) backend, side by side. In a plain browser there is no Rust, so we
// fall back to the JS WebSocket client.
//
// Multiple rooms can be subscribed at once (needed when upgrading a relay room to
// P2P in place): only the *primary* room's messages/status are surfaced to the
// store, and `switchPrimary()` flips which one is active.

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
  // `makePrimary=false` subscribes without surfacing the room yet (used during a
  // relay→P2P upgrade, where the relay room stays primary until the switch).
  createRoom(name: string, makePrimary?: boolean): Promise<CreatedRoom>;
  joinRoom(ticket: string, makePrimary?: boolean): Promise<JoinedRoom>;
  nodeInfo(): Promise<{ node_id: string } | null>;
  // Make a subscribed room the active one (re-emits its last known status so the
  // store can (re)start its MLS handshake even if NeighborUp already fired).
  switchPrimary(room: string): void;
  // Drop only the relay (WebSocket) leg, keeping any P2P subscriptions.
  disconnectRelay(): void;
}

// ── Tauri backend: the Rust realtime gateway ──────────────────────────────────
class GatewayChatTransport implements ChatTransport {
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private status: WsStatus = "disconnected";
  private primaryRoom: string | null = null;
  private activeRooms = new Set<string>();
  private roomStatus = new Map<string, WsStatus>();
  private listening = false;

  private async ensureListeners(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ room: string; payload: string }>("realtime://message", (e) => {
      if (e.payload.room !== this.primaryRoom) return;
      let data: WsMessage;
      try {
        data = JSON.parse(e.payload.payload) as WsMessage;
      } catch {
        return; // ignore malformed frames
      }
      this.messageHandlers.forEach((h) => h(data));
    });
    await listen<{ room: string; state: WsStatus }>("realtime://status", (e) => {
      this.roomStatus.set(e.payload.room, e.payload.state);
      if (e.payload.room === this.primaryRoom) this.setStatus(e.payload.state);
    });
  }

  private setStatus(status: WsStatus): void {
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  connect(room: string): void {
    this.primaryRoom = room;
    this.activeRooms.add(room);
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
    const room = this.primaryRoom;
    this.primaryRoom = null;
    this.activeRooms.clear();
    this.roomStatus.clear();
    if (room) void _invoke("realtime_leave_room", { room }).catch(() => {}); // no-op for WS rooms
    void _invoke("realtime_disconnect").catch(() => {});
    this.setStatus("disconnected");
  }

  disconnectRelay(): void {
    void _invoke("realtime_disconnect").catch(() => {}); // drops the WS leg only
  }

  send(payload: Record<string, unknown>): void {
    void _invoke("realtime_send", {
      room: this.primaryRoom,
      payload: JSON.stringify(payload),
    }).catch(() => {});
  }

  async createRoom(name: string, makePrimary = true): Promise<CreatedRoom> {
    await this.ensureListeners();
    const res = await _invoke<CreatedRoom>("realtime_create_room", { name });
    this.activeRooms.add(res.room);
    if (makePrimary) this.primaryRoom = res.room;
    return res;
  }

  async joinRoom(ticket: string, makePrimary = true): Promise<JoinedRoom> {
    await this.ensureListeners();
    const res = await _invoke<JoinedRoom>("realtime_join_room", { ticket });
    this.activeRooms.add(res.room);
    if (makePrimary) this.primaryRoom = res.room;
    return res;
  }

  switchPrimary(room: string): void {
    this.primaryRoom = room;
    this.activeRooms.add(room);
    // Re-emit the room's last known status so the store reacts even if its
    // NeighborUp/connected event arrived while it wasn't primary.
    this.setStatus(this.roomStatus.get(room) ?? "connecting");
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

// Browser fallback: delegate realtime to the JS WebSocket client; P2P rooms and
// the relay→P2P upgrade are desktop-only.
const browserBackend: ChatTransport = {
  connect: (room) => wsService.connect(room),
  disconnect: () => wsService.disconnect(),
  disconnectRelay: () => wsService.disconnect(),
  send: (payload) => wsService.send(payload),
  onMessage: (handler) => wsService.onMessage(handler),
  onStatus: (handler) => wsService.onStatus(handler),
  get isConnected() {
    return wsService.isConnected;
  },
  createRoom: () => Promise.reject(new Error("P2P rooms require the desktop app.")),
  joinRoom: () => Promise.reject(new Error("P2P rooms require the desktop app.")),
  nodeInfo: () => Promise.resolve(null),
  switchPrimary: () => {},
};

export const chatTransport: ChatTransport = _isTauri()
  ? new GatewayChatTransport()
  : browserBackend;
