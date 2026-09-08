// Constants with no runtime imports, so anything (components, tests, scripts)
// can read them without pulling Vue in.
export const brand = {
  name: "Zinnia",
  org: "SpectrumAI",
  bundleId: "com.spectrumaipl.zinnia",
} as const;

/** Dev-tooling constants. `vitePort` MUST agree with vite.config.ts server.port,
 *  src-tauri/tauri.conf.json devUrl, and scripts/tauri-dev-server.mjs. */
export const dev = { vitePort: 1430 } as const;
