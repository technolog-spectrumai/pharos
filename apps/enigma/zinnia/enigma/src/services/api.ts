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

export interface NoteLink {
  id: number;
  from_box: number;
  to_box: number;
  label: string;
  from_box_title: string;
  to_box_title: string;
}

export interface NoteEdge {
  id: number;
  from_box: number;
  to_box: number;
  label: string;
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
  source_type?: string;
  quote?: string;
  properties?: Record<string, unknown>;
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
  mission_title: string | null;
  assignee: string | null;
  due_date: string | null;
  completed_at: string | null;
  position: number;
}

export interface KanbanMission {
  id: number;
  title: string;
  campaign: string;
  urgency: number;
  urgency_label: string;
  impact: number;
  impact_label: string;
  total_tasks?: number;
  completed_tasks?: number;
  open_tasks?: number;
  total_weight?: number;
  completed_weight?: number;
  completion_rate?: number;
  weight_completion_rate?: number;
  tasks?: KanbanTask[];
}

export interface MissionDetail {
  id: number;
  title: string;
  description: string;
  urgency: number;
  urgency_label: string;
  impact: number;
  impact_label: string;
  campaign: { id: number; name: string; description: string; start_date: string | null; end_date: string | null; owner: string | null };
  project: { id: number; name: string; lead: string | null };
  owner: string | null;
  location: string | null;
  route: string | null;
  zone: string | null;
  metadata: Record<string, unknown>;
  stats: {
    total: number; completed: number; open: number;
    progress_pct: number; total_weight: number;
    completed_weight: number; weighted_pct: number;
  };
  tasks: KanbanTask[];
}

export interface SprintItem {
  id: number; name: string;
  start: string | null; end: string | null;
  total_tasks: number; completed_tasks: number; open_tasks: number;
  total_weight: number; completed_weight: number; open_weight: number;
  completion_rate: number; weight_completion_rate: number;
}

export interface SprintMetrics {
  total_sprints: number; total_tasks: number;
  completed_tasks: number; open_tasks: number;
  total_weight: number; completed_weight: number; open_weight: number;
  overall_completion_rate: number; overall_weight_completion_rate: number;
  sprint_items: SprintItem[];
  selected_sprint_id: number | null;
  burndown: { labels: string[]; data: number[] };
  velocity: { labels: string[]; data: number[] };
  lead_time: { labels: string[]; data: number[] };
  assignees: { label: string; total_tasks: number; completed_tasks: number; total_weight: number; completed_weight: number }[];
  campaign_progress: { label: string; total: number; done: number; pct: number }[];
  sprints: { id: number; name: string }[];
}

export interface BacklogData {
  total_missions: number; total_tasks: number;
  completed_tasks: number; open_tasks: number;
  overall_completion_rate: number;
  missions: KanbanMission[];
}

export type EisenhowerMatrix = Record<string, { id: number; title: string; campaign: string }[]>;

// ── Events ────────────────────────────────────────────────────────────────────

export interface EnigmaEvent {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  category: string | null;
  public: boolean;
  owner: string | null;
  address: string | null;
  capacity: number | null;
  requires_registration: boolean;
  organizers?: string[];
  accepted_count?: number;
  invite_count?: number;
}

export interface EventInvite {
  id: string;
  event_id: string;
  event_title: string;
  event_start: string;
  event_end: string;
  event_category: string | null;
  status: "pending" | "accepted" | "declined";
  sent_at: string;
}

export interface EventListResponse {
  events: EnigmaEvent[];
  total: number;
  upcoming_count: number;
  past_count: number;
  upcoming: EnigmaEvent[];
}

export interface EventFormData {
  categories: { id: number; name: string }[];
  addresses: { id: number; display: string }[];
  people: { id: number; name: string }[];
}

export interface CreateEventPayload {
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  category_id?: number | null;
  address_id?: number | null;
  capacity?: number | null;
  requires_registration?: boolean;
  public?: boolean;
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

export interface MapLocation {
  type: string;
  name: string;
  detail: string | null;
  geometry: Record<string, any> | null;
  lat?: number | null;
  lng?: number | null;
}

export interface MapLayerPolygon {
  id: number;
  name: string;
  value: number;
  center: Record<string, any> | null;
  geometry: Record<string, any>;
}

export interface MapLayer {
  id: number;
  name: string;
  slug: string;
  unit: string;
  min_value: number | null;
  max_value: number | null;
  style: Record<string, any>;
  inverted_importance: boolean;
  half_range: boolean;
  polygons: MapLayerPolygon[];
}

export interface RouteResult {
  type: string;
  properties: {
    mode: string;
    distance_km: number;
    duration_min: number;
  };
  geometry: Record<string, any>;
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

export interface OrgNode {
  id: string;
  name: string;
  slug: string;
  pid: string | null;
  avatar_url: string | null;
  email: string;
  phone: string;
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

  // ── Notes links + graph ───────────────────────────────────────────────────

  getBoxLinks(boxId: number): Promise<{ links: NoteLink[] }> {
    return this.request(`/bento/api/boxes/${boxId}/links/`);
  }

  createLink(fromBox: number, toBox: number, label: string): Promise<NoteLink> {
    return this.request("/bento/api/links/", {
      method: "POST",
      body: JSON.stringify({ from_box: fromBox, to_box: toBox, label }),
    });
  }

  deleteLink(id: number): Promise<void> {
    return this.request(`/bento/api/links/${id}/`, { method: "DELETE" });
  }

  getFullGraph(): Promise<{ nodes: NoteBox[]; edges: NoteEdge[] }> {
    return this.request("/bento/api/graph/");
  }

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

  renameFile(key: string, title: string): Promise<VaultFile> {
    return this.request(`/vault/api/files/${key}/`, { method: "PATCH", body: JSON.stringify({ title }) });
  }

  encryptFile(key: string, password: string): Promise<VaultFile> {
    return this.request(`/vault/api/files/${key}/encrypt/`, { method: "POST", body: JSON.stringify({ password }) });
  }

  decryptFile(key: string, password: string): Promise<VaultFile> {
    return this.request(`/vault/api/files/${key}/decrypt/`, { method: "POST", body: JSON.stringify({ password }) });
  }

  getVaultMetrics(): Promise<any> {
    return this.request("/vault/api/metrics/");
  }

  deleteFile(key: string): Promise<void> {
    return this.request(`/vault/api/files/${key}/`, { method: "DELETE" });
  }

  uploadFile(file: File, title: string, bucketSlug?: string): Promise<VaultFile> {
    return new Promise(async (resolve, reject) => {
      const base = await serverBase();
      const token = await getAuthToken();
      const form = new FormData();
      form.append("file", file);
      form.append("title", title || file.name);
      if (bucketSlug) form.append("bucket_slug", bucketSlug);

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

  updateTask(id: number, data: Partial<{ title: string; description: string; column_id: number; weight: number; due_date: string | null }>): Promise<KanbanTask> {
    return this.request(`/kanban/api/tasks/${id}/`, { method: "PATCH", body: JSON.stringify(data) });
  }

  deleteTask(id: number): Promise<void> {
    return this.request(`/kanban/api/tasks/${id}/`, { method: "DELETE" });
  }

  promoteTask(id: number): Promise<KanbanTask> {
    return this.request(`/kanban/api/tasks/${id}/promote/`, { method: "POST" });
  }

  demoteTask(id: number): Promise<KanbanTask> {
    return this.request(`/kanban/api/tasks/${id}/demote/`, { method: "POST" });
  }

  getProjectMissions(projectId: number): Promise<{ missions: KanbanMission[] }> {
    return this.request(`/kanban/api/projects/${projectId}/missions/`);
  }

  getMission(missionId: number): Promise<MissionDetail> {
    return this.request(`/kanban/api/missions/${missionId}/`);
  }

  getSprintMetrics(projectId: number, sprintId?: number): Promise<SprintMetrics> {
    const qs = sprintId ? `?sprint=${sprintId}` : "";
    return this.request(`/kanban/api/projects/${projectId}/sprint-metrics/${qs}`);
  }

  getBacklog(projectId: number): Promise<BacklogData> {
    return this.request(`/kanban/api/projects/${projectId}/backlog/`);
  }

  getEisenhowerMatrix(projectId: number): Promise<{ matrix: EisenhowerMatrix }> {
    return this.request(`/kanban/api/projects/${projectId}/matrix/`);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  getEvents(): Promise<EventListResponse> {
    return this.request("/events/api/enigma/list/");
  }

  createEvent(data: CreateEventPayload): Promise<EnigmaEvent> {
    return this.request("/events/api/enigma/list/", { method: "POST", body: JSON.stringify(data) });
  }

  getEvent(id: string): Promise<EnigmaEvent> {
    return this.request(`/events/api/enigma/${id}/`);
  }

  getEventFormData(): Promise<EventFormData> {
    return this.request("/events/api/enigma/form-data/");
  }

  sendInvite(eventId: string, personId: number): Promise<{ ok: boolean; created: boolean; invite_id: string; person: string; status: string }> {
    return this.request(`/events/api/enigma/${eventId}/invite/`, {
      method: "POST",
      body: JSON.stringify({ person_id: personId }),
    });
  }

  getMyInvites(): Promise<{ invites: EventInvite[]; pending_count: number }> {
    return this.request("/events/api/enigma/my-invites/");
  }

  respondInvite(id: string, action: "accept" | "decline"): Promise<{ ok: boolean; status: string }> {
    return this.request(`/events/api/enigma/invites/${id}/respond/`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
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

  getMapData(): Promise<{ locations: MapLocation[] }> {
    return this.request("/locations/api/map/");
  }

  getMapLayers(): Promise<{ layers: MapLayer[] }> {
    return this.request("/locations/api/layers/");
  }

  searchRoute(data: { mode: string; start_lat: number; start_lng: number; end_lat: number; end_lng: number }): Promise<RouteResult> {
    return this.request("/locations/api/route-search/", { method: "POST", body: JSON.stringify(data) });
  }

  // ── Socialhub ──────────────────────────────────────────────────────────────

  getOrgChart(slug: string): Promise<{ nodes: OrgNode[] }> {
    return this.request(`/socialhub/api/communities/${slug}/org-chart/`);
  }

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
