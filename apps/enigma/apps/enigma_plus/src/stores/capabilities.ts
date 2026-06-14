import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../services/api";

// Which server-backed apps the connected server has installed. Enigma+ talks to either
// portal (full) or faros (minimal Tor server — e.g. no knowledge graph), so the dashboard
// and nav only offer apps the backend can actually serve.
//
// Default-open: an unknown feature (not yet fetched, or an older server without the
// /telegraph/api/apps/ descriptor) is treated as available, so nothing is hidden unless
// the server explicitly reports it absent.
export const useCapabilitiesStore = defineStore("capabilities", () => {
  const available = ref<Record<string, boolean>>({});
  const loaded = ref(false);

  async function fetchApps() {
    try {
      const res = await api.getApps();
      available.value = res?.apps ?? {};
      loaded.value = true;
    } catch {
      /* old server / offline — keep defaults (everything shown) */
    }
  }

  /** True unless the server explicitly reported the feature as not installed. */
  function has(key: string): boolean {
    const v = available.value[key];
    return v === undefined ? true : v;
  }

  return { available, loaded, fetchApps, has };
});
