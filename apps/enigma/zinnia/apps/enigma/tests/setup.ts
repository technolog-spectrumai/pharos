import { config } from "@vue/test-utils";
import { afterEach } from "vitest";

// FontAwesome is registered globally in main.ts; stub it everywhere so component
// tests don't need the icon library wired up.
config.global.stubs = {
  "font-awesome-icon": true,
};

afterEach(() => {
  localStorage.clear();
});
