// The contract every zinnia editor implements — enigma's NoteEditor/SvgEditor
// twin interface, minus the vault (no locked/encrypt here). The host owns the
// FILE (path, name, reading, writing, the discard prompt); an editor owns only
// its BUFFER and reports when the two diverge.
//
// Keeping the interface identical across editors is what lets the host hold one
// loosely-typed ref for whichever is mounted — and it is why a new editor must
// not invent its own save path.
import type { Ref } from "vue";

export interface EditorProps {
  /** null while the file has never been saved (awaiting Save As). */
  path: string | null;
  name: string;
  content: string;
  busy?: boolean;
  /** The HOST's channel for save failures. Editor-local problems stay local. */
  error?: string;
}

export interface EditorHandle {
  /** Re-baseline the dirty flag after the host saves this buffer. */
  markSaved(): void;
  getContent(): string;
  isDirty(): boolean;
}

/** What the host binds of itself into each mounted editor. */
export interface EditorEvents {
  save: [content: string];
  "update:dirty": [boolean];
  /** The visual editor cannot represent this file — reopen it as plain text. */
  "open-as-text": [];
}

export type EditorRef = Ref<EditorHandle | null>;
