import { invoke } from "@tauri-apps/api/core";

export interface OfflineProfile {
  display_name: string;
  email: string;
  phone: string;
  bio: string;
  date_of_birth: string;
}

export interface AppProfileState {
  server_url: string;
  auth_token: string | null;
  offline_profile: OfflineProfile;
}

export async function getProfileState(): Promise<AppProfileState> {
  return await invoke<AppProfileState>("app_get_profile_state");
}

export async function getServerUrl(): Promise<string> {
  return await invoke<string>("app_get_server_url");
}

export async function setServerUrl(serverUrl: string): Promise<void> {
  await invoke("app_set_server_url", { serverUrl });
}

export async function getAuthToken(): Promise<string | null> {
  return await invoke<string | null>("app_get_auth_token");
}

export async function setAuthToken(authToken: string): Promise<void> {
  await invoke("app_set_auth_token", { authToken });
}

export async function clearAuthToken(): Promise<void> {
  await invoke("app_clear_auth_token");
}

export async function getOfflineProfile(): Promise<OfflineProfile> {
  return await invoke<OfflineProfile>("app_get_offline_profile");
}

export async function setOfflineProfile(
  offlineProfile: OfflineProfile,
): Promise<void> {
  await invoke("app_set_offline_profile", { offlineProfile });
}
