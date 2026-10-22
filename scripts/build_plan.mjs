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
  app: ["features", "test", "desktop", "android"],
  desktop: ["enabled", "profile", "bundles"],
  android: ["enabled", "profile", "abis", "allow_unsigned_release"],
};

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Parse and validate a build config.
 *
 * `facts` is what the checkout says, gathered by the caller:
 *   platform  process.platform
 *   apps      { <name>: { features: { <id>: [required ids] } } } — every
 *             directory under apps/ that has a src-tauri/, with the app's
 *             feature CATALOGUE: the `[features]` table of its Cargo.toml,
 *             which is the one authority for which ids exist and what each
 *             requires. Empty for an app that has no optional features.
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

    // The allowlist. `null` = this app has no optional features at all.
    //
    // Nothing here is a default: an app with a catalogue must say which
    // features it wants, every id must exist, and the list must be CLOSED
    // under requirements — a feature that needs another is refused, never
    // quietly widened, so the file always says exactly what is built.
    const catalogue = known.features ?? {};
    const ids = Object.keys(catalogue);
    let features = null;
    if (ids.length === 0) {
      if (section.features !== undefined) {
        err(`${at}.features`, `${name} has no optional features (no [features] in its Cargo.toml)`);
      }
    } else if (section.features === undefined) {
      err(`${at}.features`, `required — list the features to build ([] for none; available: ${ids.join(", ")})`);
    } else {
      features = [];
      for (const id of list(`${at}.features`, section.features)) {
        if (!ids.includes(id)) {
          err(`${at}.features`, `unknown feature ${JSON.stringify(id)} (available: ${ids.join(", ")})`);
        } else if (features.includes(id)) {
          err(`${at}.features`, `${id} is listed twice`);
        } else {
          features.push(id);
        }
      }
      for (const id of features) {
        for (const needs of catalogue[id]) {
          if (!features.includes(needs)) err(`${at}.features`, `${id} requires ${needs}, which is not listed`);
        }
      }
    }

    const app = { features, test: bool(`${at}.test`, section.test, false), desktop: null, android: null };

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

  // The allowlist reaches the build twice, and both halves must get the same
  // list. Cargo takes it as `--features`, so an omitted feature's Rust code
  // and optional dependencies are not compiled. The frontend takes it from
  // `<APP>_FEATURES` in the environment (the app's vite.config reads it), so
  // the bundler drops the omitted feature's code too. Set on EVERY step — the
  // test run and the Android build must be the same build as the desktop one.
  const list = app.features;
  const env = list ? { [`${name.toUpperCase()}_FEATURES`]: list.join(",") } : {};
  const featureArgs = list && list.length ? ["--features", list.join(",")] : [];

  if (app.test) {
    steps.push({ title: `${name}: frontend tests`, cwd: ".", argv: ["npm", "run", "test", "-w", appDir], env });
    steps.push({
      title: `${name}: Rust tests`,
      cwd: ".",
      // A workspace member is tested through the WORKSPACE: `cargo test -p`
      // compiles one crate and silently skips the doctests of the crates it
      // shares — padova's `compile_fail` guard among them.
      //
      // A crate with features is tested with exactly the listed ones:
      // `--no-default-features` because a bare `cargo test` would otherwise
      // add whatever the manifest's `default` says.
      argv: known.inWorkspace
        ? ["cargo", "test", "--workspace"]
        : [
            "cargo", "test", "--manifest-path", `${appDir}/src-tauri/Cargo.toml`,
            ...(list ? ["--no-default-features", ...featureArgs] : []),
          ],
      env,
    });
  }

  if (app.desktop) {
    const { profile, bundles } = app.desktop;
    const argv = ["npx", "tauri", "build"];
    if (profile === "debug") argv.push("--debug");
    if (bundles.length) argv.push("--bundles", bundles.join(","));
    argv.push(...featureArgs);
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
    if (featureArgs.length) argv.push(`--features=${list.join(",")}`);
    steps.push({ title: `${name}: Android ${profile} (${abis.join(", ")})`, cwd: ".", argv, env });
    steps.push({ title: `${name}: Android packages`, collect: "android", profile });
  }

  return steps;
}
