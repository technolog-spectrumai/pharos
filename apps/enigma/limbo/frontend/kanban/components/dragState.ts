// Shared drag state for the Kanban board's native HTML5 drag-and-drop.
//
// The dragged card id is stashed in this module-level ref instead of the
// DragEvent's dataTransfer, because WebKitGTK (Tauri's Linux webview) is finicky
// with custom-MIME dataTransfer round-trips. Only one board is ever on screen, so
// a single shared ref is safe.
import { ref } from "vue";

export const draggingCardId = ref<string | null>(null);
