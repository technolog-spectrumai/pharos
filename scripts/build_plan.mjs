// build.yaml → the commands a build runs. Pure: nothing here touches the disk
// or starts a process, so the whole mapping from "what the file says" to "what
// gets executed" can be tested without building anything (build_plan.test.mjs).
// build.mjs gathers the facts about the checkout and runs the result.

import { parse } from "yaml";

/** Package formats per host. Tauri compiles for the machine it runs on — there
 *  is no cross-compile for desktop targets — so a format this host cannot
 *  produce is refused up front rather than minutes into a cargo build. */
export const BUNDLES = {
  linux: ["deb", "rpm", "appimage"],
  darwin: ["dmg", "app"],
  win32: ["msi", "nsis"],
};

const HOST_NAMES = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** The names build_android.sh accepts; it is the authority and refuses
 *  anything else, this only refuses it sooner. */
export const ABIS = ["aarch64", "x86_64", "armv7", "i686"];

const PROFILES = ["release", "debug"];

const KEYS = {
  root: ["output_dir", "apps"],
  app: ["edition", "test", "desktop", "android"],
  desktop: ["enabled", "profile", "bundles"],
  android: ["enabled", "profile", "abis", "allow_unsigned_release"],
};

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Parse and validate a build config.
 *
 * `facts` is what the checkout says, gathered by the caller:
 *   platform  process.platform
 *   apps      { <name>: { editions: [..], overlays: [..] } } — every directory
 *             under apps/ that has a src-tauri/, the editions it has a
 *             configs/build_config.<edition>.yaml for, and the editions that
 *             also have a tauri.<edition>.conf.json overlay.
 *
 * Returns { config, errors }. Every problem is reported, not just the first,
 * and each names the path of the key at fault.
 */
export function loadConfig(text, facts) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);

  let raw;
  try {
    raw = parse(text);
  } catch (e) {
    return { config: null, errors: [`not valid YAML — ${e.message}`] };
  }
  if (!isMap(raw)) return { config: null, errors: ["the file must be a mapping with an `apps:` key"] };

  const unknown = (path, map, allowed) => {
    for (const key of Object.keys(map)) {
      if (!allowed.includes(key)) err(`${path}${key}`, `unknown key (known: ${allowed.join(", ")})`);
    }
  };
  const bool = (path, value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") err(path, `must be true or false, not ${JSON.stringify(value)}`);
    return value === true;
  };
  const profile = (path, value) => {
    if (value === undefined) return "release";
    if (!PROFILES.includes(value)) err(path, `must be release or debug, not ${JSON.stringify(value)}`);
    return value;
  };
  const list = (path, value) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      err(path, `must be a list of names, e.g. [a, b] — not ${JSON.stringify(value)}`);
      return [];
    }
    return value;
  };

  unknown("", raw, KEYS.root);

  let outputDir = null;
  if (raw.output_dir !== undefined && raw.output_dir !== null) {
    if (typeof raw.output_dir !== "string" || raw.output_dir.trim() === "") {
      err("output_dir", "must be a directory path");
    } else {
      outputDir = raw.output_dir;
    }
  }

  const apps = {};
  if (!isMap(raw.apps) || Object.keys(raw.apps).length === 0) {
    err("apps", "must name at least one app to build");
    return { config: null, errors };
  }

  for (const [name, section] of Object.entries(raw.apps)) {
    const at = `apps.${name}`;
    const known = facts.apps[name];
    if (!known) {
      err(at, `no such app under apps/ (have: ${Object.keys(facts.apps).join(", ")})`);
      continue;
    }
    if (!isMap(section)) {
      err(at, "must be a mapping");
      continue;
    }
    unknown(`${at}.`, section, KEYS.app);

    let edition = null;
    if (section.edition !== undefined && section.edition !== null) {
      if (known.editions.length === 0) {
        err(`${at}.edition`, `${name} has no editions (no src-tauri/configs/build_config.<edition>.yaml)`);
      } else if (!known.editions.includes(section.edition)) {
        err(
          `${at}.edition`,
          `${JSON.stringify(section.edition)} has no src-tauri/configs/build_config.${section.edition}.yaml ` +
            `(have: ${known.editions.join(", ")})`,
        );
      } else {
        edition = section.edition;
      }
    }

    const app = { edition, test: bool(`${at}.test`, section.test, false), desktop: null, android: null };

    if (section.desktop !== undefined) {
      const d = section.desktop;
      const dat = `${at}.desktop`;
      if (!isMap(d)) {
        err(dat, "must be a mapping");
      } else {
        unknown(`${dat}.`, d, KEYS.desktop);
        const bundles = list(`${dat}.bundles`, d.bundles);
        const here = BUNDLES[facts.platform] ?? [];
        for (const b of bundles) {
          if (here.includes(b)) continue;
          const host = Object.keys(BUNDLES).find((p) => BUNDLES[p].includes(b));
          err(
            `${dat}.bundles`,
            host
              ? `${b} has to be built on ${HOST_NAMES[host]}; this is ${HOST_NAMES[facts.platform] ?? facts.platform}. ` +
                  `Tauri compiles for the machine it runs on — there is no cross-compile for desktop packages`
              : `unknown package format ${JSON.stringify(b)} (this host builds: ${here.join(", ")})`,
          );
        }
        const desktop = { profile: profile(`${dat}.profile`, d.profile), bundles };
        if (bool(`${dat}.enabled`, d.enabled, true)) app.desktop = desktop;
      }
    }

    if (section.android !== undefined) {
      const a = section.android;
      const aat = `${at}.android`;
      if (!isMap(a)) {
        err(aat, "must be a mapping");
      } else {
        unknown(`${aat}.`, a, KEYS.android);
        let abis = list(`${aat}.abis`, a.abis);
        if (abis.length === 0) abis = ["aarch64"];
        if (abis.includes("all") && abis.length > 1) {
          err(`${aat}.abis`, "`all` already means every ABI — list it alone");
        }
        for (const abi of abis) {
          if (abi !== "all" && !ABIS.includes(abi)) {
            err(`${aat}.abis`, `unknown ABI ${JSON.stringify(abi)} (known: ${ABIS.join(", ")}, all)`);
          }
        }
        const android = {
          profile: a.profile === undefined ? "debug" : profile(`${aat}.profile`, a.profile),
          abis,
          allowUnsigned: bool(`${aat}.allow_unsigned_release`, a.allow_unsigned_release, false),
        };
        if (android.allowUnsigned && android.profile !== "release") {
          err(`${aat}.allow_unsigned_release`, "only applies to profile: release (debug builds are always signed with the SDK debug key)");
        }
        if (bool(`${aat}.enabled`, a.enabled, true)) app.android = android;
      }
    }

    apps[name] = app;
  }

  return { config: errors.length ? null : { outputDir, apps }, errors };
}

/**
 * The ordered steps that build one app.
 *
 * `known` is this app's entry in `facts.apps`, plus:
 *   inWorkspace    whether its crate is a member of the repo-root cargo workspace
 *   androidScript  build_android.sh, as a path from the repo root
 *
 * Each step is { title, cwd, argv, env } — `cwd` relative to the repo root,
 * `env` the variables added to the inherited environment — or, for the two
 * things that are not a process, { title, cleanBundles } / { title, collect }.
 */
export function planApp(name, app, known) {
  const steps = [];
  const appDir = `apps/${name}`;

  // The edition travels as an environment variable because build.rs is what
  // reads it: `ENIGMA_EDITION=professional` selects the YAML that is compiled
  // in. Set on EVERY step — the test run and the Android build must bake in
  // the same feature set as the desktop bundle.
  const env = app.edition ? { [`${name.toUpperCase()}_EDITION`]: app.edition } : {};

  if (app.test) {
    steps.push({ title: `${name}: frontend tests`, cwd: ".", argv: ["npm", "run", "test", "-w", appDir], env });
    steps.push({
      title: `${name}: Rust tests`,
      cwd: ".",
      // A workspace member is tested through the WORKSPACE: `cargo test -p`
      // compiles one crate and silently skips the doctests of the crates it
      // shares — padova's `compile_fail` guard among them.
      argv: known.inWorkspace
        ? ["cargo", "test", "--workspace"]
        : ["cargo", "test", "--manifest-path", `${appDir}/src-tauri/Cargo.toml`],
      env,
    });
  }

  if (app.desktop) {
    const { profile, bundles } = app.desktop;
    const argv = ["npx", "tauri", "build"];
    if (profile === "debug") argv.push("--debug");
    if (bundles.length) argv.push("--bundles", bundles.join(","));
    // The edition's partial tauri config, deep-merged over tauri.conf.json.
    // build.rs applies the same merge before asserting the app identity, so
    // the two must stay in lockstep — which is why it is passed whenever the
    // file exists and never otherwise.
    if (app.edition && known.overlays.includes(app.edition)) {
      argv.push("--config", `src-tauri/tauri.${app.edition}.conf.json`);
    }
    // Stale bundles from a previous run would be reported as this build's.
    steps.push({ title: `${name}: clear old ${profile} bundles`, cleanBundles: profile });
    // `tauri build` runs the frontend build itself (beforeBuildCommand: the
    // typecheck, then vite), so a type error stops it before any Rust.
    steps.push({ title: `${name}: desktop ${profile} bundle`, cwd: appDir, argv, env });
    steps.push({ title: `${name}: desktop packages`, collect: "desktop", profile });
  }

  if (app.android) {
    const { profile, abis, allowUnsigned } = app.android;
    const argv = ["bash", known.androidScript, name, profile, abis.join(",")];
    if (allowUnsigned) argv.push("--allow-unsigned-release");
    steps.push({ title: `${name}: Android ${profile} (${abis.join(", ")})`, cwd: ".", argv, env });
    steps.push({ title: `${name}: Android packages`, collect: "android", profile });
  }

  return steps;
}
