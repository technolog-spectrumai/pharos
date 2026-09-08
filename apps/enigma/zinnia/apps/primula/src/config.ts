// Constants with no runtime imports, so anything (components, tests, scripts)
// can read them without pulling Vue in.
export const brand = {
  name: "Primula",
  org: "SpectrumAI",
  bundleId: "com.spectrumaipl.primula",
} as const;

/** Dev-tooling constants. `vitePort` MUST agree with vite.config.ts server.port,
 *  src-tauri/tauri.conf.json devUrl, and scripts/tauri-dev-server.mjs.
 *
 *  1432/1433, not Lazurite's 1430/1431: every app must be runnable at the same
 *  time, and a shared port is how two `run_dev.sh` fight over one window. */
export const dev = { vitePort: 1432 } as const;
