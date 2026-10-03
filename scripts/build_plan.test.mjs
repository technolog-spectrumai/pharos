// node --test scripts/build_plan.test.mjs
//
// What build.yaml turns into, checked without building anything.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig, planApp } from "./build_plan.mjs";

const facts = {
  platform: "linux",
  apps: {
    // A catalogue as Cargo's [features] gives it: id -> the ids it requires.
    enigma: { features: { hosted_relays: [], dht: ["hosted_relays"], calls: [], maps: [] } },
    morion: { features: {} },
  },
};

const load = (yaml, f = facts) => loadConfig(yaml, f);
const argvs = (steps) => steps.filter((s) => s.argv).map((s) => s.argv.join(" "));
const standalone = { ...facts.apps.enigma, inWorkspace: false, androidScript: "rutile/scripts/build_android.sh" };
const member = { ...facts.apps.morion, inWorkspace: true, androidScript: "rutile/scripts/build_android.sh" };

test("a feature list reaches cargo as --features and the frontend as an env var", () => {
  const { config, errors } = load(`
apps:
  enigma:
    features: [hosted_relays, dht, maps]
    desktop: { profile: release, bundles: [deb, rpm] }
`);
  assert.deepEqual(errors, []);
  const build = planApp("enigma", config.apps.enigma, standalone).find((s) => s.argv);
  assert.equal(build.cwd, "apps/enigma");
  assert.deepEqual(build.env, { ENIGMA_FEATURES: "hosted_relays,dht,maps" });
  assert.equal(build.argv.join(" "), "npx tauri build --bundles deb,rpm --features hosted_relays,dht,maps");
});

test("an empty list builds with no optional feature, and still says so to the frontend", () => {
  const { config } = load("apps: { enigma: { features: [], desktop: { profile: debug } } }");
  const [, build] = planApp("enigma", config.apps.enigma, standalone);
  assert.deepEqual(build.env, { ENIGMA_FEATURES: "" });
  assert.equal(build.argv.join(" "), "npx tauri build --debug");
});

test("an app without optional features gets no flags and no env var", () => {
  const { config } = load("apps: { morion: { desktop: {} } }");
  const [, build] = planApp("morion", config.apps.morion, member);
  assert.deepEqual(build.env, {});
  assert.equal(build.argv.join(" "), "npx tauri build");
});

test("the allowlist is exact: unknown ids, missing requirements and silence are all refused", () => {
  const cases = [
    ["apps: { enigma: { features: [mapz], desktop: {} } }", 'apps.enigma.features: unknown feature "mapz" (available: hosted_relays, dht, calls, maps)'],
    ["apps: { enigma: { features: [dht], desktop: {} } }", "apps.enigma.features: dht requires hosted_relays, which is not listed"],
    ["apps: { enigma: { features: [maps, maps], desktop: {} } }", "apps.enigma.features: maps is listed twice"],
    ["apps: { enigma: { desktop: {} } }", "apps.enigma.features: required — list the features to build ([] for none; available: hosted_relays, dht, calls, maps)"],
    ["apps: { enigma: { features: maps, desktop: {} } }", "apps.enigma.features: must be a list of names"],
    ["apps: { morion: { features: [maps] } }", "apps.morion.features: morion has no optional features"],
    ["apps: { enigma: { edition: pro, features: [], desktop: {} } }", "apps.enigma.edition: unknown key"],
  ];
  for (const [yaml, expected] of cases) {
    const { config, errors } = load(yaml);
    assert.equal(config, null, yaml);
    assert.ok(errors.some((e) => e.includes(expected)), `${yaml}\n  expected: ${expected}\n  got: ${errors.join(" | ")}`);
  }
});

test("tests run before the bundle, with exactly the listed features", () => {
  const { config } = load("apps: { morion: { test: true, desktop: {} }, enigma: { features: [maps], test: true, desktop: {} } }");
  assert.deepEqual(argvs(planApp("morion", config.apps.morion, member)), [
    "npm run test -w apps/morion",
    "cargo test --workspace",
    "npx tauri build",
  ]);
  assert.deepEqual(argvs(planApp("enigma", config.apps.enigma, standalone)), [
    "npm run test -w apps/enigma",
    "cargo test --manifest-path apps/enigma/src-tauri/Cargo.toml --no-default-features --features maps",
    "npx tauri build --features maps",
  ]);
});

test("old bundles are cleared before a desktop build and collected after it", () => {
  const { config } = load("apps: { morion: { desktop: { profile: debug } } }");
  const steps = planApp("morion", config.apps.morion, member);
  assert.deepEqual(
    steps.map((s) => (s.cleanBundles ? `clean ${s.cleanBundles}` : s.collect ? `collect ${s.collect} ${s.profile}` : "run")),
    ["clean debug", "run", "collect desktop debug"],
  );
});

test("android goes through build_android.sh with the same feature list", () => {
  const { config } = load(`
apps:
  enigma:
    features: [maps]
    android: { profile: release, abis: [aarch64, x86_64], allow_unsigned_release: true }
`);
  const [build] = planApp("enigma", config.apps.enigma, standalone);
  assert.equal(
    build.argv.join(" "),
    "bash rutile/scripts/build_android.sh enigma release aarch64,x86_64 --allow-unsigned-release --features=maps",
  );
  assert.deepEqual(build.env, { ENIGMA_FEATURES: "maps" });
});

test("enabled: false keeps a section's settings but builds nothing", () => {
  const { config, errors } = load(`
apps:
  morion:
    desktop: { enabled: false, bundles: [deb] }
    android: { enabled: false }
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(planApp("morion", config.apps.morion, member), []);
});

test("a typo is an error, never a default", () => {
  const cases = [
    ["apps: { morion: { desktop: { profil: debug } } }", "apps.morion.desktop.profil: unknown key"],
    ["apps: { morion: { desktop: { profile: fast } } }", "apps.morion.desktop.profile: must be release or debug"],
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
  const { errors } = load("apps: { enigma: { features: [dht, nope], desktop: { profile: fast, bundles: [dmg] } } }");
  assert.equal(errors.length, 4);
});
