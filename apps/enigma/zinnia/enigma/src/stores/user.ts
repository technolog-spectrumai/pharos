import { ref } from "vue";
import { defineStore } from "pinia";
import { api, type Me } from "../services/api";

export interface FetchLogEntry {
  timestamp: Date;
  url: string;
  ok: boolean;
  message: string;
  detail?: string;
}

export interface OfflineProfile {
  display_name: string;
  email: string;
  phone: string;
  bio: string;
  date_of_birth: string; // ISO date "YYYY-MM-DD" or ""
}

const OFFLINE_PROFILE_KEY = "enigma_offline_profile";

const EMPTY_PROFILE: OfflineProfile = {
  display_name: "",
  email: "",
  phone: "",
  bio: "",
  date_of_birth: "",
};

function loadStoredProfile(): OfflineProfile {
  try {
    const raw = localStorage.getItem(OFFLINE_PROFILE_KEY);
    if (raw) return { ...EMPTY_PROFILE, ...JSON.parse(raw) };
  } catch {}
  return { ...EMPTY_PROFILE };
}

export const useUserStore = defineStore("user", () => {
  const me = ref<Me | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const fetchLog = ref<FetchLogEntry[]>([]);

  const offlineProfile = ref<OfflineProfile>(loadStoredProfile());

  function serverBase(): string {
    return (localStorage.getItem("enigma_server_url") ?? "").replace(/\/$/, "");
  }

  async function fetchMe() {
    loading.value = true;
    error.value = null;
    const url = `${serverBase()}/enigma/api/me/`;
    const ts = new Date();

    try {
      me.value = await api.getMe();
      fetchLog.value.push({ timestamp: ts, url, ok: true, message: `OK — ${me.value.full_name}` });
    } catch (e) {
      const msg = (e as Error).message;
      error.value = msg;
      fetchLog.value.push({
        timestamp: ts,
        url,
        ok: false,
        message: msg,
        detail: (e as Error).stack,
      });
    } finally {
      loading.value = false;
    }
  }

  function saveOfflineProfile() {
    localStorage.setItem(OFFLINE_PROFILE_KEY, JSON.stringify(offlineProfile.value));
  }

  return { me, loading, error, fetchLog, offlineProfile, fetchMe, saveOfflineProfile };
});
