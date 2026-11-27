// Chat transport: the Rust mesh over Tor (`realtime_*` commands and the
// room-tagged `realtime://*` events).
//
// Every member of a room hosts an onion for it and keeps a link to every other
// member; `setPeers` tells Rust whose onions those are. A single set of
// listeners dispatches every event to handlers by its room. In a plain browser
// (Vite dev / vitest jsdom) there is no Rust, so a stub transport rejects room
// operations — the chat requires the Tauri desktop/mobile runtime.

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** A room's link state: `connected` while at least one other member is linked,
 *  `waiting` while none is (alone, or the others are offline), `connecting`
 *  before the room's onion is up. (The type keeps its historical name.) */
export type WsStatus = "connecting" | "connected" | "waiting" | "disconnected" | "error";
/** A parsed JSON frame from the transport. */
export type WsMessage = Record<string, unknown> & { type?: string };

type MessageHandler = (room: string, data: WsMessage) => void;
/** `peerId` is the onion of the member whose link just came up or went down;
 *  `linked` the onions of every member linked right now. */
type StatusHandler = (room: string, state: WsStatus, peerId?: string, linked?: string[]) => void;

/** A room opened on this device; `onion` is ours for it. */
export interface OpenedRoom { room: string; name: string; onion: string }

export interface ChatTransport {
  /** Host a new room's onion. */
  createRoom(name: string): Promise<OpenedRoom>;
  /** Open a room and link to the given members' onions (reopen, or after an
   *  invitation was redeemed). */
  joinRoom(name: string, peers: string[]): Promise<OpenedRoom>;
  /** Every other member's onion: Rust keeps a link to each. */
  setPeers(room: string, peers: string[]): void;
  /** Abort an in-flight join. */
  cancelJoin(): void;
  leaveRoom(room: string): void;
  /** Part of deleting a room: a same-named room later gets a fresh onion. */
  forgetOnion(name: string): void;
  /** This device's id, for a personal invitation. */
  deviceId(): Promise<string | null>;
  send(room: string, payload: Record<string, unknown>): void;
  onMessage(handler: MessageHandler): () => void;
  onStatus(handler: StatusHandler): () => void;
  /** Last known status for a room (so a channel can initialise when it sets a room). */
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
    await listen<{ room: string; state: WsStatus; peer_id?: string | null; linked?: string[] }>("realtime://status", (e) => {
      this.roomStatus.set(e.payload.room, e.payload.state);
      const peerId = e.payload.peer_id ?? undefined;
      const linked = e.payload.linked ?? [];
      this.statusHandlers.forEach((h) => h(e.payload.room, e.payload.state, peerId, linked));
    });
  }

  async createRoom(name: string): Promise<OpenedRoom> {
    await this.ensureListeners();
    return _invoke<OpenedRoom>("realtime_create_room", { name });
  }

  async joinRoom(name: string, peers: string[]): Promise<OpenedRoom> {
    await this.ensureListeners();
    return _invoke<OpenedRoom>("realtime_join_room", { name, peers });
  }

  setPeers(room: string, peers: string[]): void {
    void _invoke("realtime_set_peers", { room, peers }).catch(() => {});
  }

  cancelJoin(): void {
    void _invoke("realtime_cancel_join").catch(() => {});
  }

  leaveRoom(room: string): void {
    this.roomStatus.delete(room);
    void _invoke("realtime_leave_room", { room }).catch(() => {});
  }

  forgetOnion(name: string): void {
    void _invoke("realtime_forget_onion", { name }).catch(() => {});
  }

  deviceId(): Promise<string | null> {
    return _invoke<string>("realtime_device_id").catch(() => null);
  }

  send(room: string, payload: Record<string, unknown>): void {
    void _invoke("realtime_send", { room, payload: JSON.stringify(payload) }).catch(() => {});
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
const P2P_REQUIRES_APP = "Rooms require the desktop/mobile app.";

class StubChatTransport implements ChatTransport {
  createRoom(): Promise<OpenedRoom> {
    return Promise.reject(new Error(P2P_REQUIRES_APP));
  }
  joinRoom(): Promise<OpenedRoom> {
    return Promise.reject(new Error(P2P_REQUIRES_APP));
  }
  setPeers(): void {}
  cancelJoin(): void {}
  leaveRoom(): void {}
  forgetOnion(): void {}
  deviceId(): Promise<string | null> {
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
