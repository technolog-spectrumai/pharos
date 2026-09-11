// Capsules and jobs — the anastasia half of `/api/v1/`.
//
// Every DTO here is TRANSCRIBED from the server's own dict literal, not
// guessed: `services.pool_report` and `services.capsule_report` in
// `toto/anastasia/services.py`, `_job_json` in `toto/anastasia/api.py`. The
// server has a contract test that freezes those keys, so a rename there goes
// red there rather than silently here.
//
// The types are DELIBERATELY NOT EXHAUSTIVE VALIDATORS. Extra keys the server
// adds later flow through untouched, because a client that rejected an unknown
// field would break on every additive change — and additive change is the only
// kind the versioned path promises to allow.
import type { ApiClient } from "./client";
import type { Dimensions } from "./auth";

export type { Dimensions, PoolReading } from "./auth";

/** What a capsule is doing. `accepts_work` is the one to branch on — the
 *  states are the server's vocabulary and it may grow one. */
export interface Capsule {
  uuid: string;
  name: string;
  state: string;
  detail: string;
  reserved: Dimensions;
  free: Dimensions;
  usage: Record<string, number> | null;
  sample_age_seconds: number | null;
  expires_at: string | null;
  executions_running: number;
  accepts_work: boolean;
  /** Which isolation this capsule's runners get. */
  tier: string;
  /** THE ONE TO SHOW A PERSON, and never `tier !== "docker"`.
   *
   *  The server computes it from a whitelist so an unknown tier falls to the
   *  weaker claim — understating isolation is a smaller wrong than promising
   *  one that is not there. Interpolating `tier` into a sentence is exactly how
   *  "your code runs in a virtual machine" gets rendered for a container. */
  isolates_kernel: boolean;
}

export interface Job {
  uuid: string;
  capsule: string;
  operation: string;
  family: string;
  status: string;
  /** Poll until this. Computed server-side from its own FINISHED set, so a
   *  client cannot poll a dead job for ever because the two lists drifted. */
  finished: boolean;
  exit_code: number | null;
  error: string;
  created_at: string;
  finished_at: string | null;
}

/** A slice of a running job's output, and where the next one starts. */
export interface LogSlice {
  uuid: string;
  text: string;
  /** Byte offset to ask from next. Hold it; do not recompute it from
   *  `text.length` — that is a character count and would desynchronise on the
   *  first non-ASCII line. */
  offset: number;
  /** False when the slice was truncated: ask again NOW, not in a second. */
  complete: boolean;
  finished: boolean;
}

export interface StorageReading {
  [dimension: string]: number | boolean | string;
}

export function pool(client: ApiClient) {
  return client.get<import("./auth").PoolReading>("/api/v1/pool");
}

export function listCapsules(client: ApiClient) {
  return client.get<{ capsules: Capsule[] }>("/api/v1/capsules");
}

export function capsule(client: ApiClient, uuid: string) {
  return client.get<Capsule>(`/api/v1/capsules/${uuid}`);
}

export function capsuleStorage(client: ApiClient, uuid: string) {
  return client.get<StorageReading>(`/api/v1/capsules/${uuid}/storage`);
}

/** mount / unmount / release. The server names the verbs; this does not
 *  enumerate them, so a fourth appears without a client change. */
export function capsuleAction(client: ApiClient, uuid: string, action: string) {
  return client.post<Capsule>(`/api/v1/capsules/${uuid}/${action}`);
}

export interface SubmitJob {
  operation: string;
  params?: Record<string, unknown>;
  /** `{filename: base64}`. THE FIELD THAT MAKES THE ENDPOINT USABLE — every
   *  family needs a staged file, and until 2026-09-10 there was no way to send
   *  one. Flat names or nested paths; no `..`, no leading `/`. */
  inputs?: Record<string, string>;
  timeout?: number;
}

export function submitJob(client: ApiClient, capsuleUuid: string, job: SubmitJob) {
  return client.post<Job>(`/api/v1/capsules/${capsuleUuid}/jobs`, job);
}

export function job(client: ApiClient, uuid: string) {
  return client.get<Job>(`/api/v1/jobs/${uuid}`);
}

export function jobLogs(client: ApiClient, uuid: string, offset = 0) {
  return client.get<LogSlice>(`/api/v1/jobs/${uuid}/logs?offset=${offset}`);
}

/** The files a FINISHED job produced, as `{name: base64}`.
 *
 *  Refused with `conflict` while the job runs, on purpose: a partial output
 *  that looks complete is the kind of answer a client writes to a file and a
 *  person then trusts. Poll `finished` and ask once. */
export function jobOutput(client: ApiClient, uuid: string) {
  return client.get<{ uuid: string; files: Record<string, string> }>(
    `/api/v1/jobs/${uuid}/output`);
}

// ---------------------------------------------------------------------------
// The files area
// ---------------------------------------------------------------------------
//
// A capsule's one place a person can put a file or take one out without
// running a job. KEPT, NOT DURABLE: it outlives a job, an unmount and a
// remount, and it does not outlive a host reboot or releasing the capsule —
// the server holds it on a tmpfs. An app that offers it as storage is lying
// on the server's behalf; `filesAreKept` is the sentence to show.
//
// THE NAME TRAVELS IN THE BODY, never the path, for all four verbs including
// the reads. A file name is a path — slashes, dots, unicode — and putting one
// in a URL means a name that is legal in the area and not in a URL, or worse
// one legal in both that means different things. That is why `capsuleFileRead`
// is a POST.

/** One entry in the files area. Relative to the area's root, so it carries
 *  its directories: `out/report/final.pdf`, not a name plus a parent. */
export interface CapsuleFile {
  name: string;
  size: number;
  /** Unix seconds. 0 for anything the server could not stat. */
  modified: number;
  is_dir: boolean;
}

export interface CapsuleFiles {
  uuid: string;
  files: CapsuleFile[];
  /** False when the walk stopped early OR the runtime did not answer. A
   *  listing that silently truncated reads as "this is everything", which is
   *  how somebody concludes a file was lost — SAY so rather than drawing the
   *  short list plain. */
  complete: boolean;
}

export function capsuleFiles(client: ApiClient, uuid: string) {
  return client.get<CapsuleFiles>(`/api/v1/capsules/${uuid}/files`);
}

/** One file's bytes, base64. A POST because the name is in the body. */
export function capsuleFileRead(client: ApiClient, uuid: string, name: string) {
  return client.post<{ name: string; bytes: number; data_b64: string }>(
    `/api/v1/capsules/${uuid}/files/get`, { name });
}

/** Write one file. Without `replace` an existing name is REFUSED (409) rather
 *  than overwritten — a client that means to replace says so, and one that
 *  does not cannot lose somebody's afternoon to a name collision. */
export function capsuleFileWrite(client: ApiClient, uuid: string, name: string,
                                 dataB64: string, replace = false) {
  return client.post<{ name: string; size: number; bytes: number }>(
    `/api/v1/capsules/${uuid}/files/put`,
    { name, data_b64: dataB64, replace });
}

export function capsuleFileDelete(client: ApiClient, uuid: string, name: string) {
  return client.post<{ name: string; deleted: boolean }>(
    `/api/v1/capsules/${uuid}/files/delete`, { name });
}

/** Copy a file the caller owns in the Vault INTO the capsule.
 *
 *  `key`, not an id: a client outside the server's database has no id to use.
 *  The bytes never pass through here — the server has both ends, and a client
 *  that downloaded and re-uploaded would move them twice over the network and
 *  hold them in a webview's memory in between.
 *
 *  FREE. Nothing durable is created; the bytes land in capacity already
 *  reserved. `name` defaults to the vault file's title. */
export function capsuleFileFromVault(
  client: ApiClient, uuid: string,
  from: { key: string; name?: string; replace?: boolean }) {
  return client.post<{ name: string; bytes: number;
                       from: { key: string; title: string } }>(
    `/api/v1/capsules/${uuid}/files/from-vault`, from);
}

/** Copy one file OUT of the capsule into one of the caller's buckets.
 *
 *  METERED AND VIRUS-SCANNED exactly like an upload, because it is the same
 *  resource through a third door — an app that offers this without saying so
 *  lets somebody discover the charge on an invoice. `filesCostToKeep` is the
 *  sentence. */
export function capsuleFileToVault(
  client: ApiClient, uuid: string,
  to: { name: string; bucket: string; title?: string }) {
  return client.post<{ key: string; title: string; file_type: string;
                       size: number; bucket: string }>(
    `/api/v1/capsules/${uuid}/files/to-vault`, to);
}

/** WHAT THE AREA IS, for an app to show beside it. A constant rather than a
 *  comment because every app that draws the area has to say it, and three
 *  apps writing their own sentence is three chances to imply permanence. */
export const filesAreKept =
  "Files here survive a job and an unmount. They are held in memory on the " +
  "server, so they do not survive a reboot or releasing the Capsule — keep " +
  "anything you want to keep in the Vault.";

/** WHAT COPYING OUT COSTS. Same reason. */
export const filesCostToKeep =
  "This stores the file in your Vault, and is charged and virus-scanned " +
  "exactly like uploading it.";

/** Base64 in the shape `inputs` wants, from text. */
export function encodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** …and back, for `jobOutput`. Decodes as UTF-8, so a traceback with a Polish
 *  identifier in it survives. */
export function decodeText(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
