// Is Tor running on this device? Rust reports every change as `tor://status`
// (off → starting → on, or error) and answers `tor_status` for the current
// state. Read live by the indicator in the app bar.
import { ref } from "vue";
import { invoke, isTauri } from "rakotis";

export type TorState = "off" | "starting" | "on" | "error";

export const torState = ref<TorState>("off");
let listening = false;

export async function watchTor(): Promise<void> {
  if (!isTauri() || listening) return;
  listening = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ state: TorState }>("tor://status", (e) => {
    torState.value = e.payload.state;
  });
  torState.value = ((await invoke<string>("tor_status").catch(() => "off")) as TorState) || "off";
}
