import init, { WasmEnigmaSession } from "enigma_wasm";

const STATE_KEY = (room: string, identity: string) =>
  `enigma:mls:${room}:${identity}`;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class CryptoService {
  private _ready: Promise<void> | null = null;

  private get ready(): Promise<void> {
    if (!this._ready) this._ready = (init as unknown as () => Promise<void>)();
    return this._ready;
  }

  private loadState(room: string, identity: string): Uint8Array | null {
    const raw = localStorage.getItem(STATE_KEY(room, identity));
    if (!raw) return null;
    try { return base64ToBytes(raw); } catch { return null; }
  }

  private saveState(room: string, identity: string, state: Uint8Array) {
    localStorage.setItem(STATE_KEY(room, identity), bytesToBase64(state));
  }

  clearState(room: string, identity: string) {
    localStorage.removeItem(STATE_KEY(room, identity));
  }

  hasState(room: string, identity: string): boolean {
    return !!localStorage.getItem(STATE_KEY(room, identity));
  }

  /** Init or restore session. Returns true if restored from existing state. */
  async initSession(room: string, identity: string): Promise<boolean> {
    await this.ready;
    const stored = this.loadState(room, identity);
    if (stored) {
      try {
        const s = WasmEnigmaSession.import_state(stored);
        this.saveState(room, identity, s.export_state());
        s.free();
        return true;
      } catch {
        this.clearState(room, identity);
      }
    }
    const s = new WasmEnigmaSession(room, identity);
    s.create_group();
    this.saveState(room, identity, s.export_state());
    s.free();
    return false;
  }

  async keyPackage(room: string, identity: string): Promise<Uint8Array | null> {
    await this.ready;
    const stored = this.loadState(room, identity);
    if (!stored) return null;
    try {
      const s = WasmEnigmaSession.import_state(stored);
      const kp = s.key_package();
      this.saveState(room, identity, s.export_state());
      s.free();
      return kp;
    } catch (e) {
      console.error("[crypto] keyPackage failed:", e);
      return null;
    }
  }

  async addMember(
    room: string,
    identity: string,
    keyPackage: Uint8Array,
  ): Promise<{ welcome: Uint8Array; commit: Uint8Array } | null> {
    await this.ready;
    const stored = this.loadState(room, identity);
    if (!stored) return null;
    try {
      const s = WasmEnigmaSession.import_state(stored);
      const [welcome, commit] = s.add_member(keyPackage) as [Uint8Array, Uint8Array];
      this.saveState(room, identity, s.export_state());
      s.free();
      return { welcome, commit };
    } catch (e) {
      console.error("[crypto] addMember failed:", e);
      return null;
    }
  }

  async joinFromWelcome(
    room: string,
    identity: string,
    welcome: Uint8Array,
  ): Promise<boolean> {
    await this.ready;
    const stored = this.loadState(room, identity);
    if (!stored) return false;
    try {
      const s = WasmEnigmaSession.import_state(stored);
      s.join_from_welcome(welcome);
      this.saveState(room, identity, s.export_state());
      s.free();
      return true;
    } catch (e) {
      console.error("[crypto] joinFromWelcome failed:", e);
      return false;
    }
  }

  async processMessage(
    room: string,
    identity: string,
    bytes: Uint8Array,
  ): Promise<Uint8Array | null> {
    await this.ready;
    const stored = this.loadState(room, identity);
    if (!stored) return null;
    try {
      const s = WasmEnigmaSession.import_state(stored);
      const result = s.process_message(bytes);
      this.saveState(room, identity, s.export_state());
      s.free();
      return result ?? null;
    } catch (e) {
      console.error("[crypto] processMessage failed:", e);
      return null;
    }
  }

  async encrypt(
    room: string,
    identity: string,
    plaintext: string,
  ): Promise<Uint8Array | null> {
    await this.ready;
    const stored = this.loadState(room, identity);
    if (!stored) return null;
    try {
      const s = WasmEnigmaSession.import_state(stored);
      const ct = s.encrypt_app(new TextEncoder().encode(plaintext));
      this.saveState(room, identity, s.export_state());
      s.free();
      return ct;
    } catch (e) {
      console.error("[crypto] encrypt failed:", e);
      return null;
    }
  }
}

export const cryptoService = new CryptoService();
