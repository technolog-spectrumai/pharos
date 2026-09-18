// File tags, as the page reaches src-tauri/src/meta.rs.
//
// Plain text in `.lazurite/metadata.json`, on purpose and said so in the UI:
// a tag is one word about a file that stays readable when the file does not.
import { invoke } from "../ipc";

export const MAX_TAGS = 3;


export function tagsGet(path: string): Promise<string[]> {
  return invoke<string[]>("tags_get", { path });
}

export function tagsSet(path: string, tags: string[]): Promise<string[]> {
  return invoke<string[]>("tags_set", { path, tags });
}

export function tagsAll(): Promise<Record<string, string[]>> {
  return invoke<Record<string, string[]>>("tags_all");
}
