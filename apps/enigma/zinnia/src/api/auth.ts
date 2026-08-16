// Session-key auth — the platform's current Bearer story (`POST /api/login/`
// hands back the Django session key; every JSON view accepts it as a Bearer
// token). A revocable personal-access-token flow replaces this when the server
// grows one; the call sites won't change.
import type { ApiClient } from "./client";

export interface Me {
  username: string;
  email?: string;
}

export async function login(
  client: ApiClient, username: string, password: string,
): Promise<string> {
  const res = await client.post<{ ok: boolean; token: string }>(
    "/api/login/", { username, password });
  return res.token;
}

export async function logout(client: ApiClient): Promise<void> {
  await client.post("/api/logout/");
}

export async function me(client: ApiClient): Promise<Me> {
  return client.get<Me>("/api/me/");
}
