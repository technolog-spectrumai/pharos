// The seven colour slots, kept between sessions. Enigma sealed these in its
// encrypted kv behind Rust commands zinnia does not have; a colour preference
// is not a secret, so plain localStorage is the honest equivalent here.
const KEY = "zinnia:sketch:palette";

export async function loadPaletteRaw(): Promise<string | null> {
  return localStorage.getItem(KEY);
}

export async function savePaletteRaw(value: string): Promise<void> {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* storage full or unavailable — the palette just won't survive a restart */
  }
}
