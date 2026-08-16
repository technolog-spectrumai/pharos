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
