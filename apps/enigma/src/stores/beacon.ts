// Your Beacon (8.C2): the optional helper new rooms use. Kept in the vault (kv
// "beacon"). Without one, rooms are pure mesh. A room's own Beacon is stored with
// the room and shared inside its encryption, so changing yours only affects new rooms.
import { ref } from "vue";
import { kvGet, kvPut } from "rakotis";

export interface MyBeacon { onion: string; name: string }
export const myBeacon = ref<MyBeacon | null>(null);
const NS = "beacon";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function loadBeacon(): Promise<void> {
  try {
    const raw = await kvGet(NS, "default", "mine");
    myBeacon.value = raw ? (JSON.parse(raw) as MyBeacon) : null;
  } catch {
    myBeacon.value = null;
  }
}

/** Take a Beacon's code (`pharos-beacon:…`); throws with a readable reason. */
export async function setBeacon(code: string): Promise<MyBeacon> {
  const b = await invoke<MyBeacon>("beacon_parse_code", { code });
  myBeacon.value = b;
  await kvPut(NS, "default", "mine", JSON.stringify(b));
  return b;
}

export async function clearBeacon(): Promise<void> {
  myBeacon.value = null;
  await kvPut(NS, "default", "mine", "");
}

/** This phone's key for a Beacon in "only my phones" mode (`beacon allow NAME KEY`). */
export function discoveryKey(onion: string): Promise<string> {
  return invoke<string>("beacon_discovery_key", { onion });
}
