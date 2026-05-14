export interface Room {
  id: number;
  name: string;
  slug: string;
  participant_count: number;
  created_at: string;
  participants?: Participant[];
}

export interface Participant {
  name: string;
  avatar_url: string;
  type: "human" | "ai_agent";
}

export interface Me {
  id: number;
  username: string;
  full_name: string;
  avatar_url: string | null;
  profile_url: string | null;
}

const TOKEN_KEY = "enigma_auth_token";

class ApiService {
  private get baseUrl(): string {
    return (localStorage.getItem("enigma_server_url") ?? "").replace(/\/$/, "");
  }

  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  private setToken(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    };
    const token = this.token;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, {
      credentials: "include",
      headers,
      ...init,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async login(username: string, password: string): Promise<void> {
    const result = await this.request<{ ok: boolean; token: string }>("/enigma/api/login/", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    this.setToken(result.token);
  }

  async logout(): Promise<void> {
    await this.request<{ ok: boolean }>("/enigma/api/logout/", { method: "POST" }).catch(() => {});
    this.clearToken();
  }

  getMe(): Promise<Me> {
    return this.request<Me>("/enigma/api/me/");
  }

  getRooms(): Promise<{ rooms: Room[] }> {
    return this.request<{ rooms: Room[] }>("/enigma/api/rooms/");
  }

  getRoom(slug: string): Promise<Room> {
    return this.request<Room>(`/enigma/api/rooms/${slug}/`);
  }
}

export const api = new ApiService();
