// Agnostic, room-multiplexing chat transport.
//
// Two chat channels (Forum/relay over WebSocket, and P2P over iroh) run at the same
// time, so the transport is addressed by ROOM rather than a single "primary" room.
// In the Tauri app, Rust owns both backends via the realtime gateway (`realtime_*`
// commands + `realtime://*` events, each tagged with a `room`); a single set of
// listeners dispatches every event to handlers by its room, and each channel filters
// to the room(s) it owns. In a plain browser there is no Rust, so we fall back to the
// JS WebSocket client (relay only; P2P is desktop-only).

import { wsService, type WsStatus, type WsMessage } from "./services/ws";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

type MessageHandler = (room: string, data: WsMessage) => void;
type StatusHandler = (room: string, state: WsStatus) => void;

export interface CreatedRoom { room: string; name: string; ticket: string }
export interface JoinedRoom { room: string; name: string }

export interface ChatTransport {
  // Relay (WebSocket) — a single server connection, owned by the Forum channel.
  connectWs(room: string): void;
  disconnectWs(): void;
  // P2P (iroh) rooms — desktop only.
  createRoom(name: string): Promise<CreatedRoom>;
  joinRoom(ticket: string): Promise<JoinedRoom>;
  // Ticketless join: bootstrap from peer NodeId(s), addresses resolved via aster/Tor.
  joinRoomByNode(name: string, peerNodeIds: string[]): Promise<JoinedRoom>;
  // Resolve a user's iroh NodeId(s) for a service `kind` ("gossip"/"vox") from the
  // aster directory (over Tor). Empty when the user is offline or aster is absent.
  resolveNodes(username: string, kind: string): Promise<string[]>;
  leaveRoom(room: string): void;
  nodeInfo(): Promise<{ node_id: string } | null>;
  // Send a payload to a specific room (Rust routes p2p-vs-WS by the room id).
  send(room: string, payload: Record<string, unknown>): void;
  // Room-tagged streams; channels filter to the rooms they own.
  onMessage(handler: MessageHandler): () => void;
  onStatus(handler: StatusHandler): () => void;
  // Last known status for a room (so a channel can initialise when it sets a room).
  lastStatus(room: string): WsStatus | undefined;
}

// ── Tauri backend: the Rust realtime gateway ──────────────────────────────────
class GatewayChatTransport implements ChatTransport {
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private roomStatus = new Map<string, WsStatus>();
  private listening = false;

  private async ensureListeners(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ room: string; payload: string }>("realtime://message", (e) => {
      let data: WsMessage;
      try {
        data = JSON.parse(e.payload.payload) as WsMessage;
      } catch {
        return; // ignore malformed frames
      }
      this.messageHandlers.forEach((h) => h(e.payload.room, data));
    });
    await listen<{ room: string; state: WsStatus }>("realtime://status", (e) => {
      this.roomStatus.set(e.payload.room, e.payload.state);
      this.statusHandlers.forEach((h) => h(e.payload.room, e.payload.state));
    });
  }

  connectWs(room: string): void {
    void (async () => {
      await this.ensureListeners();
      try {
        await _invoke("realtime_connect", { room });
      } catch {
        this.roomStatus.set(room, "error");
        this.statusHandlers.forEach((h) => h(room, "error"));
      }
    })();
  }

  disconnectWs(): void {
    void _invoke("realtime_disconnect").catch(() => {});
  }

  async createRoom(name: string): Promise<CreatedRoom> {
    await this.ensureListeners();
    return _invoke<CreatedRoom>("realtime_create_room", { name });
  }

  async joinRoom(ticket: string): Promise<JoinedRoom> {
    await this.ensureListeners();
    return _invoke<JoinedRoom>("realtime_join_room", { ticket });
  }

  async joinRoomByNode(name: string, peerNodeIds: string[]): Promise<JoinedRoom> {
    await this.ensureListeners();
    return _invoke<JoinedRoom>("realtime_join_room_by_node", { name, peerNodeIds });
  }

  async resolveNodes(username: string, kind: string): Promise<string[]> {
    try {
      return await _invoke<string[]>("aster_resolve", { username, kind });
    } catch {
      return []; // no aster / not logged in — caller falls back to manual tickets
    }
  }

  leaveRoom(room: string): void {
    this.roomStatus.delete(room);
    void _invoke("realtime_leave_room", { room }).catch(() => {});
  }

  send(room: string, payload: Record<string, unknown>): void {
    void _invoke("realtime_send", { room, payload: JSON.stringify(payload) }).catch(() => {});
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

  lastStatus(room: string): WsStatus | undefined {
    return this.roomStatus.get(room);
  }
}

// ── Browser fallback: JS WebSocket client (relay only) ────────────────────────
// The single socket is the Forum/relay room; P2P is desktop-only.
class BrowserChatTransport implements ChatTransport {
  private relayRoom: string | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private relayStatus: WsStatus = "disconnected";
  private wired = false;

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    wsService.onMessage((data) => {
      if (this.relayRoom) this.messageHandlers.forEach((h) => h(this.relayRoom!, data));
    });
    wsService.onStatus((state) => {
      this.relayStatus = state;
      if (this.relayRoom) this.statusHandlers.forEach((h) => h(this.relayRoom!, state));
    });
  }

  connectWs(room: string): void {
    this.wire();
    this.relayRoom = room;
    wsService.connect(room);
  }

  disconnectWs(): void {
    wsService.disconnect();
  }

  createRoom(): Promise<CreatedRoom> {
    return Promise.reject(new Error("P2P rooms require the desktop app."));
  }

  joinRoom(): Promise<JoinedRoom> {
    return Promise.reject(new Error("P2P rooms require the desktop app."));
  }

  joinRoomByNode(): Promise<JoinedRoom> {
    return Promise.reject(new Error("P2P rooms require the desktop app."));
  }

  resolveNodes(): Promise<string[]> {
    return Promise.resolve([]); // P2P/aster is desktop-only
  }

  leaveRoom(): void {}

  nodeInfo(): Promise<{ node_id: string } | null> {
    return Promise.resolve(null);
  }

  send(_room: string, payload: Record<string, unknown>): void {
    wsService.send(payload);
  }

  onMessage(handler: MessageHandler): () => void {
    this.wire();
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.wire();
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  lastStatus(room: string): WsStatus | undefined {
    return room === this.relayRoom ? this.relayStatus : undefined;
  }
}

export const chatTransport: ChatTransport = _isTauri()
  ? new GatewayChatTransport()
  : new BrowserChatTransport();
