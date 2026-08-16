// Who we are and which server we talk to. The token is the Django session key
// (see src/api/auth.ts); it lives in localStorage for now — the
// tauri-plugin-store move comes with the PAT flow, and nothing but this file
// will change when it does.
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { createClient, normalizeServerUrl, type ApiClient } from "../api/client";
import { ApiFailure } from "../api/errors";
import * as authApi from "../api/auth";

const URL_KEY = "zinnia:server";
const TOKEN_KEY = "zinnia:token";
const USER_KEY = "zinnia:user";

export const useSessionStore = defineStore("session", () => {
  const serverUrl = ref(localStorage.getItem(URL_KEY) ?? "http://localhost:8000");
  const token = ref<string | null>(localStorage.getItem(TOKEN_KEY));
  const username = ref<string | null>(localStorage.getItem(USER_KEY));
  const error = ref("");
  const busy = ref(false);

  const loggedIn = computed(() => token.value !== null);

  /** A fresh client per read: the base URL and token are refs, and a cached
   *  client would go stale the moment either changes. Construction is cheap. */
  const client = computed<ApiClient>(() =>
    createClient({ baseUrl: serverUrl.value, getToken: () => token.value }));

  async function login(user: string, password: string): Promise<boolean> {
    busy.value = true;
    error.value = "";
    try {
      const normalized = normalizeServerUrl(serverUrl.value);
      serverUrl.value = normalized;
      localStorage.setItem(URL_KEY, normalized);
      const fresh = await authApi.login(client.value, user, password);
      token.value = fresh;
      username.value = user;
      localStorage.setItem(TOKEN_KEY, fresh);
      localStorage.setItem(USER_KEY, user);
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function logout() {
    try {
      await authApi.logout(client.value);
    } catch {
      /* the session may already be dead server-side; local state clears anyway */
    }
    dropSession();
  }

  /** 401 anywhere means the stored session died (cloud.md lesson): flip to
   *  logged-out locally, never auto-retry a credential. */
  function authFailed(e: unknown): boolean {
    if (e instanceof ApiFailure && e.error.kind === "unauthorized") {
      dropSession();
      return true;
    }
    return false;
  }

  function dropSession() {
    token.value = null;
    username.value = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  return { serverUrl, token, username, error, busy, loggedIn, client, login, logout, authFailed };
});
