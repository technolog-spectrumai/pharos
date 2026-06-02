import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type Profile, type Community, type OrgNode } from "../services/api";

export const useSocialhubStore = defineStore("socialhub", () => {
  const profiles = ref<Profile[]>([]);
  const communities = ref<Community[]>([]);
  const selectedProfile = ref<Profile | null>(null);
  const selectedCommunity = ref<Community | null>(null);
  const orgChart = ref<OrgNode[] | null>(null);
  const orgChartLoading = ref(false);
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
    orgChart.value = null;
    try {
      selectedCommunity.value = await api.getCommunity(slug);
      selectedProfile.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function fetchOrgChart(slug: string) {
    orgChartLoading.value = true;
    try {
      const res = await api.getOrgChart(slug);
      orgChart.value = res.nodes;
    } finally {
      orgChartLoading.value = false;
    }
  }

  function clearSelection() {
    selectedProfile.value = null;
    selectedCommunity.value = null;
    orgChart.value = null;
  }

  return { profiles, communities, selectedProfile, selectedCommunity, orgChart, orgChartLoading, loading, error, fetchProfiles, openProfile, fetchCommunities, openCommunity, fetchOrgChart, clearSelection };
});
