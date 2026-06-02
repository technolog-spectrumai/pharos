import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type WalletSummary } from "../services/api";

export const useWalletStore = defineStore("wallet", () => {
  const summary = ref<WalletSummary | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastRefreshed = ref<Date | null>(null);

  async function fetchSummary() {
    loading.value = true;
    error.value = null;
    try {
      summary.value = await api.getWalletSummary();
      lastRefreshed.value = new Date();
    } catch (e: any) {
      error.value = e.message ?? "Failed to load wallet";
    } finally {
      loading.value = false;
    }
  }

  return { summary, loading, error, lastRefreshed, fetchSummary };
});
