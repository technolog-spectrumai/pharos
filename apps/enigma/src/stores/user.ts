// Local identity store. The app is serverless: there is no login and no /me —
// who you are is the locally-stored offline profile (display name, bio, …),
// selected per runtime profile. The chat display name comes from here.

import { ref, computed } from "vue";
import { defineStore } from "pinia";
import {
  getProfileState,
  setOfflineProfile,
  clearOfflineProfile,
  clearProfileState,
  setSelectedOfflineProfile,
  upsertOfflineProfile,
  type OfflineProfile,
  type OfflineProfileOption,
  type AppProfileState,
} from "rakotis";

const EMPTY_PROFILE: OfflineProfile = {
  display_name: "",
  email: "",
  phone: "",
  bio: "",
  date_of_birth: "",
  avatar: "",
};

export const useUserStore = defineStore("user", () => {
  const offlineProfile = ref<OfflineProfile>({ ...EMPTY_PROFILE });
  const offlineProfiles = ref<OfflineProfileOption[]>([]);
  const selectedOfflineProfileId = ref("");
  const offlineProfileLoaded = ref(false);

  /** The name shown in chat: the local profile's display name, if set. */
  const displayName = computed(() => offlineProfile.value.display_name.trim());

  /** The user's picture (small JPEG data URL, "" = none) — shown in chat and
   *  shared to room members over encrypted presence. */
  const avatarDataUrl = computed(() => offlineProfile.value.avatar ?? "");

  function applyProfileState(state: AppProfileState) {
    offlineProfile.value = {
      ...EMPTY_PROFILE,
      ...state.offline_profile,
    };
    offlineProfiles.value = state.offline_profiles;
    selectedOfflineProfileId.value = state.selected_offline_profile_id;
  }

  async function loadOfflineProfile() {
    applyProfileState(await getProfileState());
    offlineProfileLoaded.value = true;
  }

  async function selectOfflineProfile(id: string) {
    applyProfileState(await setSelectedOfflineProfile(id));
    offlineProfileLoaded.value = true;
  }

  async function saveOfflineProfile() {
    await setOfflineProfile(offlineProfile.value);
    await loadOfflineProfile();
  }

  async function saveOfflineProfileAs(id: string, label: string) {
    applyProfileState(await upsertOfflineProfile(id, label, offlineProfile.value));
    offlineProfileLoaded.value = true;
  }

  async function clearSelectedOfflineProfile() {
    applyProfileState(await clearOfflineProfile());
    offlineProfileLoaded.value = true;
  }

  async function clearAllProfileData() {
    applyProfileState(await clearProfileState());
    offlineProfileLoaded.value = true;
  }

  return {
    offlineProfile,
    offlineProfiles,
    selectedOfflineProfileId,
    offlineProfileLoaded,
    displayName,
    avatarDataUrl,
    loadOfflineProfile,
    selectOfflineProfile,
    saveOfflineProfile,
    saveOfflineProfileAs,
    clearSelectedOfflineProfile,
    clearAllProfileData,
  };
});
