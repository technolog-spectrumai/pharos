// Editing an encrypted file: the page's side of src-tauri/src/sealed.rs.
//
// Rust decrypts into memory and keeps the file's key in a session; what the
// page holds is a token. Saving hands the token and the text back, and Rust
// re-seals. Nothing here can read a key, and nothing here keeps a passphrase:
// the one typed into the modal goes straight to `sealedOpen` and is dropped.

import { invoke } from "../ipc";

export interface SealedOpen {
  token: number;
  name: string;
  size: number;
  text: string;
}


/** Decrypt a text file into memory. `password` null means the remembered one. */
export function sealedOpen(path: string, password: string | null): Promise<SealedOpen> {
  return invoke<SealedOpen>("sealed_open", { path, password });
}

/** Decrypt a picture to bytes. No session: the viewer never writes. */
export async function sealedOpenBytes(path: string, password: string | null): Promise<Uint8Array> {
  const body = await invoke<ArrayBuffer | Uint8Array | number[]>("sealed_open_bytes", { path, password });
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return Uint8Array.from(body);
}

/** Re-seal and write. `path` may be a new file (Save As). */
export async function sealedWrite(token: number, path: string, text: string): Promise<void> {
  await invoke("sealed_write", { token, path, text });
}

export async function sealedClose(token: number): Promise<void> {
  await invoke("sealed_close", { token });
}
