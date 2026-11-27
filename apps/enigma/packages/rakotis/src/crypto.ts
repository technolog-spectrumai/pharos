// ── Tauri availability guard ───────────────────────────────────────────────────
const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ── Encoding helpers (still needed to base64-encode WS payloads) ──────────────

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

// ── Crypto service backed by Tauri/Rust ───────────────────────────────────────
// All MLS operations run in the Rust process.  Plaintext is zeroized on the
// Rust heap after encryption.  Session state is persisted in the app data dir.

class CryptoService {
  /** Init or restore session. Returns true if restored from a previous run. */
  async initSession(room: string, identity: string): Promise<boolean> {
    if (!_isTauri()) return false;
    return _invoke<boolean>("mls_init_session", { room, identity });
  }

  async keyPackage(room: string, identity: string): Promise<Uint8Array | null> {
    if (!_isTauri()) return null;
    try {
      const bytes = await _invoke<number[]>("mls_key_package", { room, identity });
      return new Uint8Array(bytes);
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
    if (!_isTauri()) return null;
    try {
      const [welcome, commit] = await _invoke<[number[], number[]]>("mls_add_member", {
        room,
        identity,
        keyPackage: Array.from(keyPackage),
      });
      return { welcome: new Uint8Array(welcome), commit: new Uint8Array(commit) };
    } catch (e) {
      console.error("[crypto] addMember failed:", e);
      return null;
    }
  }

  /** Re-file a session under a different room (see `mls_adopt_session`): a
   *  redeemer builds its KeyPackage before it knows which room the invitation
   *  is for, so the session has to move once the grant names one. */
  async adoptSession(fromRoom: string, toRoom: string, identity: string): Promise<boolean> {
    try {
      await _invoke("mls_adopt_session", { fromRoom, toRoom, identity });
      return true;
    } catch (e) {
      console.error("[crypto] adoptSession failed:", e);
      return false;
    }
  }

  async joinFromWelcome(
    room: string,
    identity: string,
    welcome: Uint8Array,
  ): Promise<boolean> {
    if (!_isTauri()) return false;
    try {
      await _invoke("mls_join_from_welcome", {
        room,
        identity,
        welcome: Array.from(welcome),
      });
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
    if (!_isTauri()) return null;
    const result = await _invoke<number[] | null>("mls_process_message", {
      room,
      identity,
      bytes: Array.from(bytes),
    });
    return result ? new Uint8Array(result) : null;
  }

  async encrypt(
    room: string,
    identity: string,
    plaintext: string,
  ): Promise<Uint8Array | null> {
    if (!_isTauri()) return null;
    try {
      const ct = await _invoke<number[]>("mls_encrypt", {
        room,
        identity,
        plaintext: Array.from(new TextEncoder().encode(plaintext)),
      });
      return new Uint8Array(ct);
    } catch (e) {
      console.error("[crypto] encrypt failed:", e);
      return null;
    }
  }

  async clearState(room: string, identity: string): Promise<void> {
    if (!_isTauri()) return;
    await _invoke("mls_clear_state", { room, identity });
  }

  /** Authenticated roster: device identities of all current MLS group members. */
  async members(room: string, identity: string): Promise<string[]> {
    if (!_isTauri()) return [];
    try {
      return await _invoke<string[]>("mls_members", { room, identity });
    } catch (e) {
      console.error("[crypto] members failed:", e);
      return [];
    }
  }

  /** Remove a member (admin); returns the remove-commit bytes to broadcast. */
  async removeMember(room: string, identity: string, target: string): Promise<Uint8Array | null> {
    if (!_isTauri()) return null;
    try {
      const bytes = await _invoke<number[]>("mls_remove_member", { room, identity, target });
      return new Uint8Array(bytes);
    } catch (e) {
      console.error("[crypto] removeMember failed:", e);
      return null;
    }
  }
}

export const cryptoService = new CryptoService();
