import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type Profile, type Community } from "../services/api";

export const useSocialhubStore = defineStore("socialhub", () => {
  const profiles = ref<Profile[]>([]);
  const communities = ref<Community[]>([]);
  const selectedProfile = ref<Profile | null>(null);
  const selectedCommunity = ref<Community | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchProfiles() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.getProfiles();
      profiles.value = res.profiles;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load profiles";
    } finally {
      loading.value = false;
    }
  }

  async function openProfile(slug: string) {
    loading.value = true;
    try {
      selectedProfile.value = await api.getProfile(slug);
      selectedCommunity.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function fetchCommunities() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.getCommunities();
      communities.value = res.communities;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load communities";
    } finally {
      loading.value = false;
    }
  }

  async function openCommunity(slug: string) {
    loading.value = true;
    try {
      selectedCommunity.value = await api.getCommunity(slug);
      selectedProfile.value = null;
    } finally {
      loading.value = false;
    }
  }

  function clearSelection() {
    selectedProfile.value = null;
    selectedCommunity.value = null;
  }

  return { profiles, communities, selectedProfile, selectedCommunity, loading, error, fetchProfiles, openProfile, fetchCommunities, openCommunity, clearSelection };
});
