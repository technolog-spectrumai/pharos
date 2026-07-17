import { config } from "@vue/test-utils";
import { afterEach } from "vitest";
import { initBuildConfig } from "rakotis";
import { brand, policy } from "../src/config/app";

// Mirror main.ts: seed rakotis' browser-mode build-config fallback so tests see
// the same shipped defaults the app boots with (vitest has no Tauri binary; the
// `app_get_build_config` fetch is skipped because __TAURI_INTERNALS__ is unset
// while setup runs).
await initBuildConfig({
  app_name: brand.name,
  app_identifier: brand.bundleId,
  use_tor_default: policy.featureDefaults.useTor,
  stable_onion_default: policy.featureDefaults.stableOnion,
  max_file_size_mb: {
    default: policy.fileShare.defaultMaxFileSizeMb,
    min: 0,
    max: 100 * 1024,
  },
});

// FontAwesome is registered globally in main.ts; stub it everywhere so component
// tests don't need the icon library wired up.
config.global.stubs = {
  "font-awesome-icon": true,
};

afterEach(() => {
  localStorage.clear();
});
