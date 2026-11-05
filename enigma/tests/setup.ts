import { config, enableAutoUnmount } from "@vue/test-utils";
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
  stable_onion_default: policy.featureDefaults.stableOnion,
});

// FontAwesome is registered globally in main.ts; stub it everywhere so component
// tests don't need the icon library wired up.
config.global.stubs = {
  "font-awesome-icon": true,
};

// Unmount whatever a test mounted once it ends. A wrapper left mounted keeps
// reacting to the module-level state the next tests change (the HP ledger, the
// build config, the router), so every later write re-renders every earlier
// test's components: hpUi's 30-charge test took 120 ms alone and over 6 s
// under coverage, past the timeout, before this.
enableAutoUnmount(afterEach);

afterEach(() => {
  localStorage.clear();
});
