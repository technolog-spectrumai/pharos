// node --test scripts/build_plan.test.mjs   (npm run test:build)
//
// What build.yaml turns into, checked without building anything.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { loadConfig, planApp } from "./build_plan.mjs";

const facts = {
  platform: "linux",
  apps: {
    enigma: { editions: ["basic", "custom", "professional", "standard"], overlays: ["basic", "professional", "standard"] },
    morion: { editions: [], overlays: [] },
  },
};

const load = (yaml, f = facts) => loadConfig(yaml, f);
const argvs = (steps) => steps.filter((s) => s.argv).map((s) => s.argv.join(" "));

test("the shipped build.yaml is valid", () => {
  const { config, errors } = load(fs.readFileSync(new URL("../build.yaml", import.meta.url), "utf8"));
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(config.apps), ["enigma", "morion"]);
});

test("an edition selects its config, its overlay and the env var build.rs reads", () => {
  const { config } = load(`
apps:
  enigma:
    edition: professional
    desktop: { profile: release, bundles: [deb, rpm] }
`);
  const steps = planApp("enigma", config.apps.enigma, { ...facts.apps.enigma, inWorkspace: false });
  const build = steps.find((s) => s.argv);
  assert.equal(build.cwd, "apps/enigma");
  assert.deepEqual(build.env, { ENIGMA_EDITION: "professional" });
  assert.equal(
    build.argv.join(" "),
    "npx tauri build --bundles deb,rpm --config src-tauri/tauri.professional.conf.json",
  );
});

test("an edition without an overlay passes no --config", () => {
  const { config } = load("apps: { enigma: { edition: custom, desktop: { profile: debug } } }");
  const steps = planApp("enigma", config.apps.enigma, { ...facts.apps.enigma, inWorkspace: false });
  assert.deepEqual(argvs(steps), ["npx tauri build --debug"]);
});

test("no edition means no env var: the plain build_config.yaml", () => {
  const { config } = load("apps: { enigma: { desktop: {} } }");
  const [, build] = planApp("enigma", config.apps.enigma, { ...facts.apps.enigma, inWorkspace: false });
  assert.deepEqual(build.env, {});
  assert.equal(build.argv.join(" "), "npx tauri build");
});

test("tests run before the bundle, and a workspace member is tested through the workspace", () => {
  const { config } = load("apps: { morion: { test: true, desktop: {} }, enigma: { test: true, desktop: {} } }");
  assert.deepEqual(argvs(planApp("morion", config.apps.morion, { ...facts.apps.morion, inWorkspace: true })), [
    "npm run test -w apps/morion",
    "cargo test --workspace",
    "npx tauri build",
  ]);
  assert.deepEqual(argvs(planApp("enigma", config.apps.enigma, { ...facts.apps.enigma, inWorkspace: false })), [
    "npm run test -w apps/enigma",
    "cargo test --manifest-path apps/enigma/src-tauri/Cargo.toml",
    "npx tauri build",
  ]);
});

test("old bundles are cleared before a desktop build and collected after it", () => {
  const { config } = load("apps: { morion: { desktop: { profile: debug } } }");
  const steps = planApp("morion", config.apps.morion, { ...facts.apps.morion, inWorkspace: true });
  assert.deepEqual(
    steps.map((s) => (s.cleanBundles ? `clean ${s.cleanBundles}` : s.collect ? `collect ${s.collect} ${s.profile}` : "run")),
    ["clean debug", "run", "collect desktop debug"],
  );
});

test("android goes through scripts/build_android.sh with the edition in its environment", () => {
  const { config } = load(`
apps:
  enigma:
    edition: basic
    android: { profile: release, abis: [aarch64, x86_64], allow_unsigned_release: true }
`);
  const [build] = planApp("enigma", config.apps.enigma, { ...facts.apps.enigma, inWorkspace: false });
  assert.equal(build.argv.join(" "), "bash scripts/build_android.sh enigma release aarch64,x86_64 --allow-unsigned-release");
  assert.deepEqual(build.env, { ENIGMA_EDITION: "basic" });
});

test("enabled: false keeps a section's settings but builds nothing", () => {
  const { config, errors } = load(`
apps:
  morion:
    desktop: { enabled: false, bundles: [deb] }
    android: { enabled: false }
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(planApp("morion", config.apps.morion, { ...facts.apps.morion, inWorkspace: true }), []);
});

test("a typo is an error, never a default", () => {
  const cases = [
    ["apps: { enigma: { desktop: { profil: debug } } }", "apps.enigma.desktop.profil: unknown key"],
    ["apps: { enigma: { desktop: { profile: fast } } }", "apps.enigma.desktop.profile: must be release or debug"],
    ["apps: { enigma: { edition: pro, desktop: {} } }", "apps.enigma.edition: \"pro\" has no src-tauri/configs/build_config.pro.yaml"],
    ["apps: { morion: { edition: basic } }", "apps.morion.edition: morion has no editions"],
    ["apps: { sketch: { desktop: {} } }", "apps.sketch: no such app under apps/ (have: enigma, morion)"],
    ["apps: { morion: { test: yes please } }", "apps.morion.test: must be true or false"],
    ["apps: { morion: { android: { abis: [arm64] } } }", "apps.morion.android.abis: unknown ABI \"arm64\""],
    ["apps: { morion: { android: { profile: debug, allow_unsigned_release: true } } }", "only applies to profile: release"],
    ["outputs: dist\napps: { morion: {} }", "outputs: unknown key"],
    ["apps: {}", "apps: must name at least one app"],
    ["apps: [", "not valid YAML"],
  ];
  for (const [yaml, expected] of cases) {
    const { config, errors } = load(yaml);
    assert.equal(config, null, yaml);
    assert.ok(errors.some((e) => e.includes(expected)), `${yaml}\n  expected: ${expected}\n  got: ${errors.join(" | ")}`);
  }
});

test("a package format this host cannot build is refused, with the host that can", () => {
  const { errors } = load("apps: { morion: { desktop: { bundles: [deb, dmg] } } }");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /apps\.morion\.desktop\.bundles: dmg has to be built on macOS; this is Linux/);

  const onMac = load("apps: { morion: { desktop: { bundles: [dmg] } } }", { ...facts, platform: "darwin" });
  assert.deepEqual(onMac.errors, []);

  const unknown = load("apps: { morion: { desktop: { bundles: [snap] } } }");
  assert.match(unknown.errors[0], /unknown package format "snap" \(this host builds: deb, rpm, appimage\)/);
});

test("every problem is reported at once", () => {
  const { errors } = load("apps: { enigma: { edition: pro, desktop: { profile: fast, bundles: [dmg] } } }");
  assert.equal(errors.length, 3);
});
