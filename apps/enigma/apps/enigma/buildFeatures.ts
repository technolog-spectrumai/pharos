// The build's feature allowlist, for the bundler.
//
// Enigma26's optional features are Cargo features (src-tauri/Cargo.toml
// `[features]` — the catalogue). A build picks from them in a root config
// (pro.yaml / std.yaml), and `./build.sh` hands the SAME list to cargo
// (`--features`) and to this file (`ENIGMA_FEATURES`). Here it becomes one
// literal per feature — `__FEATURE_MAPS__` and so on — which Vite substitutes
// before bundling, so a branch guarded by a feature the build left out is
// dead code and is dropped, together with everything only that branch imports.
//
// Unset means "all of them": plain `npm run dev`, vitest and Playwright see the
// whole app. Set — even to the empty string — means exactly that list.
//
// Used by vite.config.ts and vitest.config.ts; never imported by app code.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The ids in Cargo.toml's `[features]` table, minus `default`. Read from the
 *  manifest rather than repeated here: one catalogue, and the frontend cannot
 *  be asked for a feature the Rust side does not know. */
export function catalogue(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = readFileSync(join(here, "src-tauri", "Cargo.toml"), "utf8");
  const section = /^\[features\]\n([\s\S]*?)(?=^\[)/m.exec(manifest);
  if (!section) throw new Error("src-tauri/Cargo.toml has no [features] table");
  return [...section[1].matchAll(/^([a-z][a-z0-9_]*)\s*=/gm)].map((m) => m[1]).filter((id) => id !== "default");
}

/** `{ __FEATURE_MAPS__: "true", … }` for Vite's `define`.
 *  `list` is ENIGMA_FEATURES: undefined = everything, otherwise comma-separated. */
export function featureDefines(list: string | undefined): Record<string, string> {
  const ids = catalogue();
  const wanted = list === undefined ? ids : list.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !ids.includes(id));
  if (unknown.length) {
    throw new Error(`ENIGMA_FEATURES names unknown feature(s) ${unknown.join(", ")} (available: ${ids.join(", ")})`);
  }
  return Object.fromEntries(ids.map((id) => [`__FEATURE_${id.toUpperCase()}__`, String(wanted.includes(id))]));
}
