import {
  getAuthToken,
  getServerUrl,
  getSilentMode,
  setAuthToken,
  clearAuthToken,
} from "./appStorage";
import { kvGet, kvPut, kvCount, kvClearNamespace } from "./localDb";

// Thrown by the upload egress points when silent mode is on. Kept as a named
// export so callers (e.g. the config view) can recognise the blocked state.
export const SILENT_MODE_ERROR = "Silent mode is on — connections are blocked.";

// Thrown when a read is requested in silent mode but no local copy exists yet.
export const SILENT_NO_CACHE = "No offline copy of this data — connect once to download it.";

// Thrown when no server address is set, so requests would otherwise hit the
// local app origin and get HTML back ("Unexpected token '<'" JSON errors).
export const NO_SERVER_ERROR = "No server configured — set a server address in Settings.";

async function assertNotSilent(): Promise<void> {
  if (await getSilentMode()) throw new Error(SILENT_MODE_ERROR);
}

// ── Offline response cache (SQLite via localDb) ───────────────────────────────
// Every successful GET is written through to local storage keyed by
// (server URL, request path); in silent mode reads are served from it so the
// previously-loaded data stays browsable with no network.

const CACHE_NS = "cache";

function cacheScope(serverUrl: string): string {
  return serverUrl.replace(/\/$/, "") || "default";
}

async function cacheGet(scope: string, path: string): Promise<string | null> {
  try {
    return await kvGet(CACHE_NS, scope, path);
  } catch {
    return null;
  }
}

async function cachePut(scope: string, path: string, body: string): Promise<void> {
  try {
    await kvPut(CACHE_NS, scope, path, body);
  } catch {
    /* cache write is best-effort */
  }
}

/** Number of cached responses for a server (shown in Settings). */
export function countResponseCache(serverUrl: string): Promise<number> {
  return kvCount(CACHE_NS, cacheScope(serverUrl));
}

/** Drop all cached responses for a server (Settings → clear local cache). */
export function clearResponseCache(serverUrl: string): Promise<void> {
  return kvClearNamespace(CACHE_NS, cacheScope(serverUrl));
}

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
  from_box_label: string;
  to_box_label: string;
}

export interface NoteEdge {
  id: number;
  from_box: number;
  to_box: number;
  label: string;
}

// An edge from a bento note out to an external toto object (kanban mission,
// event, address, person, …). Created in toto; browsable/deletable here.
export interface NoteReference {
  id: number;
  box: number;
  box_label: string;
  label: string;
  subject_label: string;
  model: string;
  content_type: number;
  object_id: string;
  created_at: string;
}

// Well-known keys inside an IdeaBox's `properties` bag. The backend stores
// everything except the label/category/lock state in `properties`, so body,
// source and quote all live here now. Custom keys are allowed via the index.
export interface NoteProperties {
  body?: string;
  source_title?: string;
  source_url?: string;
  source_type?: string;
  quote?: string;
  [key: string]: unknown;
}

export interface NoteBox {
  id: number;
  label: string;
  is_locked: boolean;
  category_id: number | null;
  category_name: string | null;
  properties: NoteProperties;
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
  directory_id: number | null;
  is_editable: boolean;
}

export interface VaultDirectory {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
}

export interface VaultBucket {
  id: number;
  slug: string;
  name: string;
  directories: VaultDirectory[];
}

export interface FileContent {
  key: string;
  title: string;
  file_type: string;
  is_editable: boolean;
  size: number;
  content: string;
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
  language: string;
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
    const base = await serverBase();
    const scope = cacheScope(base);
    const isGet = (init?.method ?? "GET").toUpperCase() === "GET";

    // Silent mode: serve reads from the local copy, block writes.
    if (await getSilentMode()) {
      if (!isGet) throw new Error(SILENT_MODE_ERROR);
      const cached = await cacheGet(scope, path);
      if (cached !== null) return JSON.parse(cached) as T;
      throw new Error(SILENT_NO_CACHE);
    }

    // No server set → don't fall back to a relative URL (which returns the app's
    // own HTML and yields a cryptic "Unexpected token '<'" JSON error).
    if (!base) throw new Error(NO_SERVER_ERROR);

    const url = `${base}${path}`;
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

    const text = await res.text();
    if (!text) return undefined as T; // e.g. 204 No Content on a delete
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      // HTML/login page instead of JSON — usually a wrong server address.
      throw new Error(
        `Server returned a non-JSON response (HTTP ${res.status}). Check the server address in Settings.`,
      );
    }
    // Write successful reads through to the local store for offline browsing.
    if (isGet) await cachePut(scope, path, text);
    return body;
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

  setLanguage(language: string): Promise<{ ok: boolean; language: string; stored: boolean }> {
    return this.request("/telegraph/api/me/", {
      method: "PATCH",
      body: JSON.stringify({ language }),
    });
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

  getAllLinks(): Promise<{ links: NoteLink[] }> {
    return this.request("/bento/api/links/");
  }

  getReferences(): Promise<{ references: NoteReference[] }> {
    return this.request("/bento/api/references/");
  }

  getBoxReferences(boxId: number): Promise<{ references: NoteReference[] }> {
    return this.request(`/bento/api/boxes/${boxId}/references/`);
  }

  deleteReference(id: number): Promise<void> {
    return this.request(`/bento/api/references/${id}/`, { method: "DELETE" });
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

  createBox(data: { label: string; properties?: NoteProperties; category_id?: number | null }): Promise<NoteBox> {
    return this.request("/bento/api/boxes/", { method: "POST", body: JSON.stringify(data) });
  }

  updateBox(id: number, data: Partial<{ label: string; properties: NoteProperties; category_id: number | null }>): Promise<NoteBox> {
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

  getBuckets(): Promise<{ buckets: VaultBucket[] }> {
    return this.request("/vault/api/buckets/");
  }

  getFileContent(key: string): Promise<FileContent> {
    return this.request(`/vault/api/files/${key}/content/`);
  }

  saveFileContent(key: string, content: string): Promise<VaultFile> {
    return this.request(`/vault/api/files/${key}/content/`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
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
      try { await assertNotSilent(); } catch (e) { reject(e); return; }
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
      try { await assertNotSilent(); } catch (e) { reject(e); return; }
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
      try { await assertNotSilent(); } catch (e) { reject(e); return; }
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
