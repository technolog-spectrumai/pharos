// The search algorithm, as a setting.
//
// Three choices, kept in localStorage like the other preferences. The words
// are the Settings view's; the value is what Rust is handed as `mode`.
import { ref } from "vue";

export const SEARCH_MODES = ["quick", "full", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

const KEY = "zinnia:searchMode";
const DEFAULT_MODE: SearchMode = "hybrid";

function load(): SearchMode {
  try {
    const raw = localStorage.getItem(KEY);
    return (SEARCH_MODES as readonly string[]).includes(raw ?? "") ? (raw as SearchMode) : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

const mode = ref<SearchMode>(load());

export function useSearchMode() {
  function set(next: SearchMode) {
    mode.value = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* a blocked store must not break the setting */
    }
  }
  return { mode, set };
}
