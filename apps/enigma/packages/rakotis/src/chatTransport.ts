// P2P chat transport — iroh rooms via the Rust realtime gateway.
//
// The app is serverless: every room is an iroh-gossip room owned by Rust
// (`realtime_*` commands + room-tagged `realtime://*` events). A single set of
// listeners dispatches every event to handlers by its room. In a plain browser
// (Vite dev / vitest jsdom) there is no Rust, so a stub transport rejects P2P
// operations — the chat requires the Tauri desktop/mobile runtime.

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Room connection state (kept the historical name — it is transport-agnostic). */
export type WsStatus = "connecting" | "connected" | "disconnected" | "error";
/** A parsed JSON frame from the transport. */
export type WsMessage = Record<string, unknown> & { type?: string };

/** `peerId` is set on neighbor-up status events: the NodeId of the peer that just
 *  connected. Channels persist it per room so reconnects work without a fresh QR. */
type MessageHandler = (room: string, data: WsMessage) => void;
/** `reason` distinguishes transport-specific status causes — currently
 *  `"captain_unreachable"` (Tor), signalling the elected onion host went down so
 *  the channel should re-elect. Absent/undefined for ordinary status changes. */
type StatusHandler = (room: string, state: WsStatus, peerId?: string, reason?: string) => void;

export interface CreatedRoom { room: string; name: string; ticket: string; onion: string }
export interface JoinedRoom { room: string; name: string; onion: string }

export interface ChatTransport {
  // P2P (iroh) rooms — Tauri only.
  createRoom(name: string): Promise<CreatedRoom>;
  /** Join by ticket (the QR payload). `peerNodeIds` seeds the bootstrap with
   *  previously persisted peers whose addresses resolve via n0 discovery. */
  joinRoom(ticket: string, peerNodeIds?: string[]): Promise<JoinedRoom>;
  /** Ticketless reconnect: re-subscribe to a named room from persisted peer NodeIds. */
  joinRoomByNode(name: string, peerNodeIds: string[]): Promise<JoinedRoom>;
  leaveRoom(room: string): void;
  /** Re-point our outbound onion dial to the elected captain (Tor rooms only). */
  setCaptain(room: string, captainOnion: string): void;
  nodeInfo(): Promise<{ node_id: string } | null>;
  // Send a payload to a specific room.
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
    await listen<{ room: string; state: WsStatus; peer_id?: string | null; reason?: string | null }>(
      "realtime://status",
      (e) => {
        this.roomStatus.set(e.payload.room, e.payload.state);
        const peerId = e.payload.peer_id ?? undefined;
        const reason = e.payload.reason ?? undefined;
        this.statusHandlers.forEach((h) => h(e.payload.room, e.payload.state, peerId, reason));
      },
    );
  }

  async createRoom(name: string): Promise<CreatedRoom> {
    await this.ensureListeners();
    return _invoke<CreatedRoom>("realtime_create_room", { name });
  }

  async joinRoom(ticket: string, peerNodeIds?: string[]): Promise<JoinedRoom> {
    await this.ensureListeners();
    return _invoke<JoinedRoom>("realtime_join_room", {
      ticket,
      peerNodeIds: peerNodeIds ?? null,
    });
  }

  async joinRoomByNode(name: string, peerNodeIds: string[]): Promise<JoinedRoom> {
    await this.ensureListeners();
    return _invoke<JoinedRoom>("realtime_join_room_by_node", { name, peerNodeIds });
  }

  leaveRoom(room: string): void {
    this.roomStatus.delete(room);
    void _invoke("realtime_leave_room", { room }).catch(() => {});
  }

  setCaptain(room: string, captainOnion: string): void {
    void _invoke("realtime_tor_set_captain", { room, captainOnion }).catch(() => {});
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

// ── Browser stub: P2P requires the Tauri runtime ──────────────────────────────
const P2P_REQUIRES_APP = "P2P rooms require the desktop/mobile app.";

class StubChatTransport implements ChatTransport {
  createRoom(): Promise<CreatedRoom> {
    return Promise.reject(new Error(P2P_REQUIRES_APP));
  }
  joinRoom(): Promise<JoinedRoom> {
    return Promise.reject(new Error(P2P_REQUIRES_APP));
  }
  joinRoomByNode(): Promise<JoinedRoom> {
    return Promise.reject(new Error(P2P_REQUIRES_APP));
  }
  leaveRoom(): void {}
  setCaptain(): void {}
  nodeInfo(): Promise<{ node_id: string } | null> {
    return Promise.resolve(null);
  }
  send(): void {}
  onMessage(): () => void {
    return () => {};
  }
  onStatus(): () => void {
    return () => {};
  }
  lastStatus(): WsStatus | undefined {
    return undefined;
  }
}

export const chatTransport: ChatTransport = _isTauri()
  ? new GatewayChatTransport()
  : new StubChatTransport();
