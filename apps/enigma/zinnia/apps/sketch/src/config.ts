// Constants with no runtime imports, so anything (components, tests, scripts)
// can read them without pulling Vue in.
export const brand = {
  name: "Sketch",
  org: "SpectrumAI",
  bundleId: "com.spectrumaipl.sketch",
} as const;

/** Dev-tooling constants. `vitePort` MUST agree with vite.config.ts server.port,
 *  src-tauri/tauri.conf.json devUrl, and scripts/tauri-dev-server.mjs.
 *
 *  1434/1435: three apps must be runnable at once, and a shared port is how two
 *  `run_dev.sh` fight over one window. */
export const dev = { vitePort: 1434 } as const;
