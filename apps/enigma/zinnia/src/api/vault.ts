// The vault endpoints zinnia consumes today. Shapes are transcribed from
// toto/vault/api_views.py, not guessed — if a field is missing here, check the
// server first.
import type { ApiClient } from "./client";

export interface VaultFileDto {
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

export interface VaultDirectoryDto {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
}

export interface VaultBucketDto {
  id: number;
  slug: string;
  name: string;
  directories: VaultDirectoryDto[];
}

export interface FileContent {
  key: string;
  title: string;
  file_type: string;
  is_editable: boolean;
  size: number;
  content: string;
  /** The state this content came from. Send it back as `base_hash` when saving
   *  and the server refuses the write if the file moved on meanwhile, instead
   *  of silently overwriting whoever moved it. */
  content_hash: string;
  /** Whoever holds the edit lock, if anyone. Advisory — the save is what
   *  enforces it — but knowing before you type is worth a lot more. */
  locked_by: string | null;
}

/** The server's hard cap on the file list. Not a page size — there is no
 *  pagination behind it, so a vault with more files simply cannot reach the
 *  older ones through this endpoint. The UI has to say so rather than show a
 *  truncated list as if it were the whole vault. */
export const FILE_LIST_CAP = 200;

/** Owner's files, newest first, capped at 200 by the server. */
export async function listFiles(client: ApiClient): Promise<VaultFileDto[]> {
  const res = await client.get<{ files: VaultFileDto[] }>("/vault/api/files/");
  return res.files;
}

/** Buckets + directories only; files overlay from listFiles by
 *  bucket_slug/directory_id — the server splits them on purpose. */
export async function bucketTree(client: ApiClient): Promise<VaultBucketDto[]> {
  const res = await client.get<{ buckets: VaultBucketDto[] }>("/vault/api/buckets/");
  return res.buckets;
}

export async function getContent(client: ApiClient, key: string): Promise<FileContent> {
  return client.get<FileContent>(`/vault/api/files/${encodeURIComponent(key)}/content/`);
}

/** Write content back to a file that is already in the vault.
 *
 *  `baseHash` is the `content_hash` that came with the content being edited.
 *  ALWAYS pass it. Without it the server cannot tell an ordinary save from an
 *  overwrite of work somebody else did while this buffer was open, and the
 *  save becomes last-writer-wins — which is exactly why this app opened vault
 *  files read-only until the server grew the precondition.
 *
 *  Throws `{kind: "conflict"}` when the file moved on (the server keeps the
 *  rejected content as a version, so nothing is lost) and `{kind: "locked"}`
 *  when somebody is in the browser editor. */
export async function putContent(
  client: ApiClient, key: string, content: string, baseHash?: string,
): Promise<VaultFileDto> {
  return client.put<VaultFileDto>(
    `/vault/api/files/${encodeURIComponent(key)}/content/`,
    baseHash ? { content, base_hash: baseHash } : { content });
}

/** Create a vault file. With `content`, this is a PUSH — the client already
 *  holds the bytes, so the server does not need a starter for the type and any
 *  writable type is allowed. Without it, the server mints an empty file, which
 *  only works for types it knows an empty shape for. */
export async function createFile(
  client: ApiClient,
  args: {
    bucket_slug: string; title: string; file_type: string;
    directory_id?: number; content?: string;
  },
): Promise<VaultFileDto> {
  return client.post<VaultFileDto>("/vault/api/files/create/", args);
}

export async function deleteFile(client: ApiClient, key: string): Promise<void> {
  await client.del(`/vault/api/files/${encodeURIComponent(key)}/`);
}

export async function createDirectory(
  client: ApiClient,
  args: { bucket_slug: string; name: string; parent_id?: number | null },
): Promise<VaultDirectoryDto> {
  return client.post<VaultDirectoryDto>("/vault/api/directories/", args);
}

/** The server refuses a directory that still holds anything (409). The UI only
 *  offers this for one it can see is empty, but the check that counts is the
 *  server's — a listing can be stale. */
export async function deleteDirectory(client: ApiClient, id: number): Promise<void> {
  await client.del(`/vault/api/directories/${id}/`);
}

/** Encrypt a vault file, server-side.
 *
 *  The SERVER does this one, not zinnia. A vault file that zinnia sealed
 *  locally would be ciphertext the platform could never open, scan or preview —
 *  so the cloud side drives zenobia's own encrypt/decrypt and the local side
 *  uses zinnia's. Two engines, deliberately, each owning the bytes it stores.
 *
 *  The password is a parameter and nothing else: it is never persisted here and
 *  the caller clears its field as soon as this returns.
 */
export async function encryptFile(
  client: ApiClient, key: string, password: string,
): Promise<VaultFileDto> {
  return client.post<VaultFileDto>(
    `/vault/api/files/${encodeURIComponent(key)}/encrypt/`, { password });
}

export async function decryptFile(
  client: ApiClient, key: string, password: string,
): Promise<VaultFileDto> {
  return client.post<VaultFileDto>(
    `/vault/api/files/${encodeURIComponent(key)}/decrypt/`, { password });
}

export interface StrongboxDto {
  kdf: string;
  kdf_version: number;
  salt: string;
  memory_cost: number;
  iterations: number;
  lanes: number;
}

/** The caller's own KDF record — salt and Argon2 costs.
 *
 *  This is what makes a locally locked file the same bytes the platform's
 *  vault produces: both derive the Fernet key from THIS salt with THESE costs,
 *  so the same password opens the file on either side. Created server-side on
 *  first ask; never anyone else's.
 */
export async function getStrongbox(client: ApiClient): Promise<StrongboxDto> {
  return client.get<StrongboxDto>("/vault/api/strongbox/");
}
