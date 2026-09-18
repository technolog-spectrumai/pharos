// The PDF service, as the editors see it.
//
// One store for one job: whether a renderer exists, whether it is busy, and
// what the last attempt said. Editors build their own HTML — a document, a
// deck, a markdown file — and hand it here; this asks where to put the result
// and asks Rust to make it. Rust owns the process, the timeout, the temporary
// files and the final atomic write. Nothing here can name a path the user did
// not pick in the save dialog.
import { ref } from "vue";

export interface PdfStatus {
  available: boolean;
  python: string | null;
  weasyprint: string | null;
  markdown: boolean;
  reason: string | null;
}

export interface PdfResult {
  pages: number;
  bytes: number;
  log: string[];
}

const NONE: PdfStatus = { available: false, python: null, weasyprint: null, markdown: false, reason: null };

/** The prefixes src-tauri/src/pdf.rs and pdf/render.py can answer with. Every
 *  one has a `pdf.errors.*` string; anything else is shown as it came. */
export const PDF_ERRORS = [
  "pdf_unavailable", "weasyprint_unavailable", "markdown_unavailable", "busy",
  "timeout", "too_large", "render_failed", "cancelled", "bad_request", "no_input",
  "tempdir", "spawn", "write", "bad_reply", "desktop_only",
] as const;

export function pdfErrorKey(message: string): string | null {
  const prefix = message.split(":")[0];
  return (PDF_ERRORS as readonly string[]).includes(prefix) ? `pdf.errors.${prefix}` : null;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let bridge: Promise<typeof import("@tauri-apps/api/core")> | null = null;
async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  bridge ??= import("@tauri-apps/api/core");
  const { invoke: call } = await bridge;
  return call<T>(cmd, args);
}

const status = ref<PdfStatus>({ ...NONE });
const busy = ref(false);
const lastError = ref("");
const lastResult = ref<PdfResult | null>(null);

export function usePdf() {
  /** Asked afresh each time the export dialog opens: a WeasyPrint installed
   *  five minutes ago should be noticed without a restart. */
  async function refresh(): Promise<PdfStatus> {
    if (!isTauri()) {
      status.value = { ...NONE, reason: "desktop_only" };
      return status.value;
    }
    try {
      const reply = await invoke<Partial<PdfStatus>>("pdf_status");
      status.value = {
        available: reply?.available === true,
        python: typeof reply?.python === "string" ? reply.python : null,
        weasyprint: typeof reply?.weasyprint === "string" ? reply.weasyprint : null,
        markdown: reply?.markdown === true,
        reason: typeof reply?.reason === "string" ? reply.reason : null,
      };
    } catch (err) {
      status.value = { ...NONE, reason: String(err) };
    }
    return status.value;
  }

  /**
   * Ask where, then ask Rust. Resolves to the result, or null when the user
   * cancelled the dialog — which is not an error and must not read as one.
   * Throws with a `prefix: prose` message otherwise.
   */
  async function render(args: {
    kind: "html" | "markdown";
    source: string;
    css?: string;
    suggestedName: string;
  }): Promise<PdfResult | null> {
    if (!isTauri()) throw new Error("desktop_only: making a PDF needs the desktop app");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const target = await save({
      defaultPath: args.suggestedName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof target !== "string") return null;

    busy.value = true;
    lastError.value = "";
    try {
      const result = await invoke<PdfResult>("pdf_render", {
        request: { kind: args.kind, source: args.source, css: args.css ?? "", output: target },
      });
      lastResult.value = result;
      return result;
    } catch (err) {
      lastError.value = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      throw new Error(lastError.value);
    } finally {
      busy.value = false;
    }
  }

  async function cancel(): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke<boolean>("pdf_cancel");
    } catch {
      /* nothing to cancel is not a failure */
    }
  }

  return { status, busy, lastError, lastResult, refresh, render, cancel };
}
