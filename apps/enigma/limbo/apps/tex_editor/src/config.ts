// Constants with no runtime imports, so anything (components, tests, scripts)
// can read them without pulling Vue in.
export const brand = {
  name: "LaTeX Editor",
  org: "SpectrumAI",
  bundleId: "com.spectrumaipl.texeditor",
} as const;

/** Dev-tooling constants. `vitePort` MUST agree with vite.config.ts server.port,
 *  src-tauri/tauri.conf.json devUrl, and scripts/tauri-dev-server.mjs.
 *
 *  1438/1439, distinct from every sibling (enigma 1420, lazurite 1430,
 *  primula 1432, sketch 1434, tex_editor 1438): every app must be runnable at
 *  the same time, and a shared port is how two `run_dev.sh` fight over one
 *  window. */
export const dev = { vitePort: 1438 } as const;

/** Where this app remembers its server address. Per app, not shared with
 *  tex_editor: two editors may point at two servers, and one key would make
 *  connecting one silently move the other. */
export const SETTINGS_KEY = "tex_editor:platform";
