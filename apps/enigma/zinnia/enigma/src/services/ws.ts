export type WsStatus = "connecting" | "connected" | "disconnected" | "error";

export interface WsMessage {
  type: string;
  message?: string;
  user?: string;
  avatar_url?: string;
  participant_type?: "human" | "ai_agent";
  sender_channel?: string;
  [key: string]: unknown;
}

type MessageHandler = (data: WsMessage) => void;
type StatusHandler = (status: WsStatus) => void;

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export class WsService {
  private socket: WebSocket | null = null;
  private roomSlug: string | null = null;
  private intentionalClose = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();

  private get wsBaseUrl(): string {
    const http = (localStorage.getItem("enigma_server_url") ?? "").replace(/\/$/, "");
    return http.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws"));
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emit(data: WsMessage) {
    this.messageHandlers.forEach((h) => h(data));
  }

  private setStatus(status: WsStatus) {
    this.statusHandlers.forEach((h) => h(status));
  }

  connect(roomSlug: string) {
    this.disconnect();
    this.intentionalClose = false;
    this.retryCount = 0;
    this.roomSlug = roomSlug;
    this._open();
  }

  private _open() {
    if (!this.roomSlug) return;
    const token = localStorage.getItem("enigma_auth_token");
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `${this.wsBaseUrl}/ws/chat/${this.roomSlug}/${query}`;
    this.setStatus("connecting");

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.retryCount = 0;
      this.setStatus("connected");
    };

    socket.onmessage = (event) => {
      try {
        const data: WsMessage = JSON.parse(event.data as string);
        this.emit(data);
      } catch {
        // ignore malformed frames
      }
    };

    socket.onclose = (event) => {
      this.socket = null;
      if (this.intentionalClose) {
        this.setStatus("disconnected");
        return;
      }
      // Unexpected close — retry with backoff
      this.setStatus(event.wasClean ? "disconnected" : "error");
      const delay = BACKOFF_DELAYS[Math.min(this.retryCount, BACKOFF_DELAYS.length - 1)];
      this.retryCount++;
      this.retryTimer = setTimeout(() => this._open(), delay);
    };

    socket.onerror = () => {
      this.setStatus("error");
    };
  }

  send(payload: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.roomSlug = null;
    this.setStatus("disconnected");
  }

  get isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}

export const wsService = new WsService();
