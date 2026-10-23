// What every app's vite.config.ts and vitest.config.ts would otherwise copy.
//
// Two pieces, each written once per app before this file existed:
//
//   sourceAliases    the three aliases that point a raw-source package
//                    (petalite, wisteria, padova, rakotis) at its src/. Every
//                    config that imports one needs them, in the same order.
//   tauriDevServer   the `server` block Tauri's dev window needs: a fixed,
//                    strict port, no caching, the HMR port beside it.
//
// Plain JavaScript with a .d.mts beside it, so the configs import it as typed
// TS and `node --test scripts/vite-shared.test.mjs` runs it with no loader.
// Nothing app-specific lives here: the port and the packages are the caller's.

/**
 * The aliases that resolve `name`, `name/sub/path` and `name/Component.vue`
 * to the package's source, mirroring its package.json `exports`.
 *
 * ORDER is load-bearing: Vite takes the first alias that matches, and the
 * `.vue` components sit one directory deeper (src/components/) than the
 * subpath exports (src/theme, src/files …), so the `.vue` rule comes first.
 *
 * @param {string} name    the bare specifier, e.g. "petalite"
 * @param {string} srcDir  absolute path to the package's src/ directory
 * @param {{ components?: boolean, entry?: string }} [options]
 *   components  false for a package whose .vue files are not under
 *               src/components (rakotis): no `.vue` rule is emitted, and
 *               `name/x.vue` resolves like any other subpath.
 *   entry       what the bare `name` resolves to; default `<srcDir>/index.ts`.
 * @returns {{ find: RegExp, replacement: string }[]}
 */
export function sourceAliases(name, srcDir, options = {}) {
  const { components = true, entry = `${srcDir}/index.ts` } = options;
  // A name with regex metacharacters (a scope's "@", a ".") must match literally.
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const aliases = [];
  if (components) {
    aliases.push({ find: new RegExp(`^${quoted}\\/(.*\\.vue)$`), replacement: `${srcDir}/components/$1` });
  }
  aliases.push(
    { find: new RegExp(`^${quoted}\\/(.*)`), replacement: `${srcDir}/$1` },
    { find: new RegExp(`^${quoted}$`), replacement: entry },
  );
  return aliases;
}

/**
 * The dev server options for a Tauri app, on `port`.
 *
 *   strictPort  Tauri's window opens devUrl, a fixed address; a Vite that
 *               quietly moved to the next free port would leave it pointed at
 *               nothing (or at another app's server).
 *   no-store    WebKitGTK disk-caches dev modules between sessions and can
 *               replay a stale module graph after a refactor ("Importing
 *               binding name 'X' is not found"). Forbidding the cache makes a
 *               restart always load the current code.
 *   hmr         only when TAURI_DEV_HOST is set (a phone on the network):
 *               HMR then needs its own socket, on `port + 1`. The app's devCsp
 *               names that port, so it must stay exactly one above.
 *   watch       src-tauri/ is cargo's; Vite reloading on every Rust edit, and
 *               on everything under target/, is noise.
 *
 * @param {{ port: number, host?: string }} options
 *   host  defaults to process.env.TAURI_DEV_HOST.
 */
export function tauriDevServer({ port, host = process.env.TAURI_DEV_HOST }) {
  if (!Number.isInteger(port) || port <= 0 || port >= 65535) {
    throw new Error(`tauriDevServer: port must be an integer in 1..65534, got ${port}`);
  }
  return {
    port,
    strictPort: true,
    headers: { "Cache-Control": "no-store" },
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: port + 1 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  };
}
