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

/** Returns the refreshed file dict; the server recomputes size + content hash. */
export async function putContent(
  client: ApiClient, key: string, content: string,
): Promise<VaultFileDto> {
  return client.put<VaultFileDto>(
    `/vault/api/files/${encodeURIComponent(key)}/content/`, { content });
}

export async function createFile(
  client: ApiClient,
  args: { bucket_slug: string; title: string; file_type: string; directory_id?: number },
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
