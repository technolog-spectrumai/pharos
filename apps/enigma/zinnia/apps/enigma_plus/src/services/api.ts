import {
  ApiBase,
  assertServerReachable,
  serverBase,
  uploadViaRust,
  getAuthToken,
  isTauri,
  invoke,
} from "rakotis";

// The HTTP transport, offline cache, auth/identity calls and shared response
// types now live in Euclid's ApiBase. Re-export the shared types + cache/error
// helpers so existing call sites that import them from this module keep working.
export type { Me, Health, Room, Participant } from "rakotis";
export {
  countResponseCache,
  clearResponseCache,
  SERVER_OFF_ERROR,
  SILENT_NO_CACHE,
  NO_SERVER_ERROR,
} from "rakotis";

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

// ── Knowledge graph (ravioli) ──────────────────────────────────────────────────

export interface KgQuery {
  id: number;
  name: string;
  description: string;
}

export interface KgNode {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
}

export interface KgEdge {
  id: string;
  type: string;
  start: string;
  end: string;
  props: Record<string, unknown>;
}

export interface KgGraph {
  nodes: KgNode[];
  edges: KgEdge[];
  selected_query: { id: number; name: string; description: string };
}

class ApiService extends ApiBase {
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

  /** Fetch a vault image as a `data:` URL. In Tauri this goes through Rust (no CORS);
   *  in the browser it fetches the file's download URL directly. */
  async downloadVaultImageDataUrl(file: VaultFile): Promise<string> {
    const url = file.download_url;
    if (!url) throw new Error("No download URL for this file.");
    // In Tauri the fetch rides the data gateway (Tor-aware); Rust relativizes the URL.
    if (isTauri()) return invoke<string>("vault_image_data_url", { path: url });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(blob);
    });
  }

  saveFileContent(key: string, content: string): Promise<VaultFile> {
    return this.request(`/vault/api/files/${key}/content/`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
  }

  /** Create an empty editable file (text/json/yaml/xml/csv/html/latex/bib/svg) in a
   *  bucket (optionally a directory) and return it, ready to open in the Ace editor. */
  createFile(bucketSlug: string, directoryId: number | null, title: string, fileType: string): Promise<VaultFile> {
    return this.request(`/vault/api/files/create/`, {
      method: "POST",
      body: JSON.stringify({ bucket_slug: bucketSlug, directory_id: directoryId, title, file_type: fileType }),
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
      try { await assertServerReachable(); } catch (e) { reject(e); return; }
      if (isTauri()) {
        try {
          const extra: Record<string, string> = { title: title || file.name };
          if (bucketSlug) extra.bucket_slug = bucketSlug;
          const text = await uploadViaRust("/vault/api/files/upload/", "file", file, extra);
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
        return;
      }
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
      try { await assertServerReachable(); } catch (e) { reject(e); return; }
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
      try { await assertServerReachable(); } catch (e) { reject(e); return; }
      if (isTauri()) {
        try {
          onProgress?.(100); // progress isn't tracked through the Rust gateway
          const text = await uploadViaRust(`/telegraph/api/channels/${slug}/upload/`, "image", file);
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
        return;
      }
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

  // ── Knowledge graph (ravioli) ──────────────────────────────────────────────
  // Saved "Knowledge Graph Queries" (CypherQuery) defined in Django admin, gated
  // by the data_mesh group. Reads fail gracefully when Neo4j is down (503).

  getKgQueries(): Promise<{ queries: KgQuery[] }> {
    return this.request<{ queries: KgQuery[] }>("/ravioli/api/queries/");
  }

  runKgQuery(id: number): Promise<KgGraph> {
    return this.request<KgGraph>(`/ravioli/api/queries/${id}/run/`);
  }
}

export const api = new ApiService();
