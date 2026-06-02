import { defineStore, acceptHMRUpdate } from "pinia";
import { ref } from "vue";
import { api, type Profile, type Community, type OrgNode } from "../services/api";

export const useSocialhubStore = defineStore("socialhub", () => {
  const profiles = ref<Profile[]>([]);
  const communities = ref<Community[]>([]);
  const selectedProfile = ref<Profile | null>(null);
  const selectedCommunity = ref<Community | null>(null);
  const orgChart = ref<OrgNode[] | null>(null);

  const profilesLoading = ref(false);
  const communitiesLoading = ref(false);
  const orgChartLoading = ref(false);
  const profilesError = ref<string | null>(null);
  const communitiesError = ref<string | null>(null);

  // Combined loading/error for components that want a single flag
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchProfiles() {
    profilesLoading.value = true;
    loading.value = true;
    profilesError.value = null;
    error.value = null;
    try {
      const res = await api.getProfiles();
      profiles.value = res.profiles ?? [];
    } catch (e: any) {
      const msg = e.message ?? "Failed to load profiles";
      profilesError.value = msg;
      error.value = msg;
    } finally {
      profilesLoading.value = false;
      loading.value = communitiesLoading.value; // stay true if communities still loading
    }
  }

  async function fetchCommunities() {
    communitiesLoading.value = true;
    communitiesError.value = null;
    try {
      const res = await api.getCommunities();
      communities.value = res.communities ?? [];
    } catch (e: any) {
      communitiesError.value = e.message ?? "Failed to load communities";
      if (!error.value) error.value = communitiesError.value;
    } finally {
      communitiesLoading.value = false;
    }
  }

  async function openProfile(slug: string) {
    loading.value = true;
    try {
      selectedProfile.value = await api.getProfile(slug);
      selectedCommunity.value = null;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load profile";
    } finally {
      loading.value = false;
    }
  }

  async function openCommunity(slug: string) {
    loading.value = true;
    orgChart.value = null;
    try {
      selectedCommunity.value = await api.getCommunity(slug);
      selectedProfile.value = null;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load community";
    } finally {
      loading.value = false;
    }
  }

  async function fetchOrgChart(slug: string) {
    orgChartLoading.value = true;
    try {
      const res = await api.getOrgChart(slug);
      orgChart.value = res.nodes;
    } catch (e: any) {
      orgChart.value = [];
    } finally {
      orgChartLoading.value = false;
    }
  }

  function clearSelection() {
    selectedProfile.value = null;
    selectedCommunity.value = null;
    orgChart.value = null;
  }

  return {
    profiles, communities, selectedProfile, selectedCommunity, orgChart,
    profilesLoading, communitiesLoading, orgChartLoading,
    profilesError, communitiesError,
    loading, error,
    fetchProfiles, openProfile, fetchCommunities, openCommunity, fetchOrgChart, clearSelection,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSocialhubStore, import.meta.hot));
}
