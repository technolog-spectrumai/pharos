import {
  getAuthToken,
  getServerUrl,
  setAuthToken,
  clearAuthToken,
} from "./appStorage";

// ── Notes (Bento) ────────────────────────────────────────────────────────────

export interface NoteCategory {
  id: number;
  name: string;
  slug: string;
  description: string;
}

export interface NoteBox {
  id: number;
  title: string;
  body: string;
  is_concept: boolean;
  is_locked: boolean;
  category_id: number | null;
  category_name: string | null;
  source_title: string;
  source_url: string;
  created_at: string;
  updated_at: string;
}

// ── Vault ─────────────────────────────────────────────────────────────────────

export interface VaultFile {
  id: number;
  title: string;
  key: string;
  file_type: string;
  file_size_bytes: number;
  is_public: boolean;
  is_encrypted: boolean;
  uploaded_at: string;
  download_url: string | null;
  bucket_slug: string | null;
}

// ── Kanban (Tasks) ────────────────────────────────────────────────────────────

export interface KanbanProject {
  id: number;
  name: string;
  description: string;
  columns?: KanbanColumn[];
}

export interface KanbanColumn {
  id: number;
  name: string;
  position: number;
  can_add_task: boolean;
}

export interface KanbanTask {
  id: number;
  title: string;
  description: string;
  weight: number;
  weight_label: string;
  column_id: number;
  column_name: string | null;
  mission_id: number;
  assignee: string | null;
  due_date: string | null;
  completed_at: string | null;
  position: number;
}

// ── Locations ─────────────────────────────────────────────────────────────────

export interface Zone {
  id: number;
  name: string;
  territory_name: string | null;
}

export interface Address {
  id: number;
  street: string;
  building: string;
  apartment: string | null;
  locality_name: string;
  state_or_province_name: string;
  country_name: string;
  lat: number | null;
  lng: number | null;
  display: string;
}

// ── Socialhub ─────────────────────────────────────────────────────────────────

export interface Profile {
  id: number;
  slug: string;
  full_name: string;
  display_name: string;
  avatar_url: string | null;
  community_count: number;
  communities?: { id: number; name: string; slug: string; org_type: string }[];
}

export interface Community {
  id: number;
  slug: string;
  name: string;
  org_type: string;
  org_type_label: string;
  established_year: number | null;
  member_count: number;
  head_name: string | null;
  members?: { id: number; slug: string; name: string }[];
  latest_news_title?: string | null;
}

// ── Wallet ────────────────────────────────────────────────────────────────────

export interface WalletHolding {
  asset_name: string;
  asset_unit: string;
  balance_base_units: number;
  balance_display: string;
}

export interface WalletAccount {
  code: string;
  name: string;
  account_type: string;
  holdings: WalletHolding[];
}

export interface PendingCharge {
  metric_code: string;
  quantity: string;
  unit: string;
  tariff_name: string;
  asset_name: string;
  asset_unit: string;
  amount_base_units: number;
  amount_display: string;
  occurred_at: string | null;
}

export interface OpenInvoice {
  id: number;
  title: string;
  amount: string;
  currency: string;
  status: string;
  due_date: string | null;
  issued_by_name: string | null;
}

export interface WalletSummary {
  accounts: WalletAccount[];
  pending_charges: PendingCharge[];
  open_invoices: OpenInvoice[];
  totals: {
    total_pending_by_asset: Record<string, string>;
    total_open_invoice_amount: string;
  };
}

export interface Room {
  id: number;
  name: string;
  slug: string;
  participant_count: number;
  created_at: string;
  is_participant?: boolean;
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

export interface Health {
  ok: boolean;
  service: string;
}

async function serverBase(): Promise<string> {
  return (await getServerUrl()).replace(/\/$/, "");
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

class ApiService {
  private async request<T>(
    path: string,
    init?: RequestInit,
    includeAuth = true,
  ): Promise<T> {
    const url = `${await serverBase()}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(includeAuth ? await authHeaders() : {}),
    };

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
    const result = await this.request<{ ok: boolean; token: string }>("/telegraph/api/login/", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    await setAuthToken(result.token);
  }

  async logout(): Promise<void> {
    await this.request<{ ok: boolean }>("/telegraph/api/logout/", { method: "POST" }).catch(() => {});
    await clearAuthToken();
  }

  getMe(): Promise<Me> {
    return this.request<Me>("/telegraph/api/me/");
  }

  health(): Promise<Health> {
    return this.request<Health>("/telegraph/api/health/", {}, false);
  }

  getRooms(): Promise<{ channels: Room[] }> {
    return this.request<{ channels: Room[] }>("/telegraph/api/channels/");
  }

  getRoom(slug: string): Promise<Room> {
    return this.request<Room>(`/telegraph/api/channels/${slug}/`);
  }

  joinRoom(slug: string): Promise<{ ok: boolean; joined: boolean }> {
    return this.request(`/telegraph/api/channels/${slug}/join/`, { method: "POST" });
  }

  leaveRoom(slug: string): Promise<{ ok: boolean }> {
    return this.request(`/telegraph/api/channels/${slug}/leave/`, { method: "POST" });
  }

  leaveAllRooms(): Promise<{ ok: boolean; left: number }> {
    return this.request("/telegraph/api/channels/leave-all/", { method: "POST" });
  }

  // ── Notes (Bento) ─────────────────────────────────────────────────────────

  getBoxes(query?: string): Promise<{ boxes: NoteBox[] }> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    return this.request(`/bento/api/boxes/${qs}`);
  }

  createBox(data: { title: string; body: string; is_concept?: boolean; category_id?: number | null }): Promise<NoteBox> {
    return this.request("/bento/api/boxes/", { method: "POST", body: JSON.stringify(data) });
  }

  updateBox(id: number, data: Partial<{ title: string; body: string; is_concept: boolean; category_id: number | null }>): Promise<NoteBox> {
    return this.request(`/bento/api/boxes/${id}/`, { method: "PATCH", body: JSON.stringify(data) });
  }

  deleteBox(id: number): Promise<void> {
    return this.request(`/bento/api/boxes/${id}/`, { method: "DELETE" });
  }

  getCategories(): Promise<{ categories: NoteCategory[] }> {
    return this.request("/bento/api/categories/");
  }

  // ── Vault ──────────────────────────────────────────────────────────────────

  getFiles(): Promise<{ files: VaultFile[] }> {
    return this.request("/vault/api/files/");
  }

  deleteFile(key: string): Promise<void> {
    return this.request(`/vault/api/files/${key}/`, { method: "DELETE" });
  }

  uploadFile(file: File, title: string): Promise<VaultFile> {
    return new Promise(async (resolve, reject) => {
      const base = await serverBase();
      const token = await getAuthToken();
      const form = new FormData();
      form.append("file", file);
      form.append("title", title || file.name);

      const xhr = new XMLHttpRequest();
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`${xhr.status}: ${xhr.responseText}`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.open("POST", `${base}/vault/api/files/upload/`);
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(form);
    });
  }

  // ── Kanban (Tasks) ─────────────────────────────────────────────────────────

  getProjects(): Promise<{ projects: KanbanProject[] }> {
    return this.request("/kanban/api/projects/");
  }

  getProject(id: number): Promise<KanbanProject> {
    return this.request(`/kanban/api/projects/${id}/`);
  }

  getProjectTasks(projectId: number): Promise<{ tasks: KanbanTask[] }> {
    return this.request(`/kanban/api/projects/${projectId}/tasks/`);
  }

  createTask(projectId: number, data: { title: string; description?: string; column_id: number }): Promise<KanbanTask> {
    return this.request(`/kanban/api/projects/${projectId}/tasks/`, { method: "POST", body: JSON.stringify(data) });
  }

  updateTask(id: number, data: Partial<{ title: string; description: string; column_id: number }>): Promise<KanbanTask> {
    return this.request(`/kanban/api/tasks/${id}/`, { method: "PATCH", body: JSON.stringify(data) });
  }

  promoteTask(id: number): Promise<KanbanTask> {
    return this.request(`/kanban/api/tasks/${id}/promote/`, { method: "POST" });
  }

  demoteTask(id: number): Promise<KanbanTask> {
    return this.request(`/kanban/api/tasks/${id}/demote/`, { method: "POST" });
  }

  // ── Locations ──────────────────────────────────────────────────────────────

  getZones(): Promise<{ zones: Zone[] }> {
    return this.request("/locations/api/zones/");
  }

  getAddresses(): Promise<{ addresses: Address[] }> {
    return this.request("/locations/api/addresses/");
  }

  createAddress(data: { street: string; building: string; locality_name: string; country_name: string; state_or_province_name?: string }): Promise<Address> {
    return this.request("/locations/api/addresses/", { method: "POST", body: JSON.stringify(data) });
  }

  // ── Socialhub ──────────────────────────────────────────────────────────────

  getProfiles(): Promise<{ profiles: Profile[] }> {
    return this.request("/socialhub/api/profiles/");
  }

  getProfile(slug: string): Promise<Profile> {
    return this.request(`/socialhub/api/profiles/${slug}/`);
  }

  getCommunities(): Promise<{ communities: Community[] }> {
    return this.request("/socialhub/api/communities/");
  }

  getCommunity(slug: string): Promise<Community> {
    return this.request(`/socialhub/api/communities/${slug}/`);
  }

  // ── Wallet ─────────────────────────────────────────────────────────────────

  getWalletSummary(): Promise<WalletSummary> {
    return this.request("/assets/api/wallet/summary/");
  }

  // ── Audio upload ───────────────────────────────────────────────────────────

  uploadAudio(slug: string, audioBlob: Blob): Promise<{ ok: boolean }> {
    return new Promise(async (resolve, reject) => {
      const base = await serverBase();
      const token = await getAuthToken();
      const form = new FormData();
      form.append("audio", audioBlob, "recording.webm");

      const xhr = new XMLHttpRequest();
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`${xhr.status}: ${xhr.responseText}`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.open("POST", `${base}/telegraph/api/channels/${slug}/upload-audio/`);
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(form);
    });
  }

  uploadImage(
    slug: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<{ ok: boolean }> {
    return new Promise(async (resolve, reject) => {
      const base = await serverBase();
      const token = await getAuthToken();
      const form = new FormData();
      form.append("image", file);

      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`${xhr.status}: ${xhr.responseText}`));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Network error")));

      xhr.open("POST", `${base}/telegraph/api/channels/${slug}/upload/`);
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(form);
    });
  }
}

export const api = new ApiService();
