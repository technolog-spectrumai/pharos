import { ref } from "vue";
import { defineStore } from "pinia";
import { api, type Me } from "../services/api";
import {
  getOfflineProfile,
  setOfflineProfile,
  getServerUrl,
  type OfflineProfile,
} from "../services/appStorage";

export interface FetchLogEntry {
  timestamp: Date;
  url: string;
  ok: boolean;
  message: string;
  detail?: string;
}

const EMPTY_PROFILE: OfflineProfile = {
  display_name: "",
  email: "",
  phone: "",
  bio: "",
  date_of_birth: "",
};

export const useUserStore = defineStore("user", () => {
  const me = ref<Me | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const fetchLog = ref<FetchLogEntry[]>([]);

  const offlineProfile = ref<OfflineProfile>({ ...EMPTY_PROFILE });
  const offlineProfileLoaded = ref(false);

  async function loadOfflineProfile() {
    offlineProfile.value = {
      ...EMPTY_PROFILE,
      ...(await getOfflineProfile()),
    };
    offlineProfileLoaded.value = true;
  }

  async function serverBase(): Promise<string> {
    return (await getServerUrl()).replace(/\/$/, "");
  }

  async function fetchMe() {
    loading.value = true;
    error.value = null;
    const base = await serverBase();
    const url = `${base}/enigma/api/me/`;
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

  async function saveOfflineProfile() {
    await setOfflineProfile(offlineProfile.value);
  }

  return {
    me,
    loading,
    error,
    fetchLog,
    offlineProfile,
    offlineProfileLoaded,
    loadOfflineProfile,
    fetchMe,
    saveOfflineProfile,
  };
});
