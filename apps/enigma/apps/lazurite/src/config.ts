// Constants with no runtime imports, so anything (components, tests, scripts)
// can read them without pulling Vue in.
export const brand = {
  /** What the app CALLS itself: the window title, the page title, the menu
   *  tooltip. This app was carved out of the original single-app Zinnia and
   *  kept its old name on screen long after it became Lazurite. */
  name: "Lazurite",
  org: "SpectrumAI",
  /** The bundle identifier, and NOT `com.spectrumaipl.lazurite`.
   *
   *  It is what the OS files user data and keyring entries under, so changing
   *  it orphans every installed copy: saved documents keep existing, and the
   *  renamed app looks in a directory that has never been written to. The
   *  display name above is free to change; this is not, and the two are
   *  deliberately separate fields for that reason. */
  bundleId: "com.spectrumaipl.zinnia",
} as const;

/** Dev-tooling constants. `vitePort` MUST agree with vite.config.ts server.port,
 *  src-tauri/tauri.conf.json devUrl, and scripts/tauri-dev-server.mjs. */
export const dev = { vitePort: 1430 } as const;
