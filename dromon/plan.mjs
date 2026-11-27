// Dromon's planner: apps/<app>/dromon.yaml → the commands a build runs. Pure:
// nothing here touches the disk or starts a process, so the whole mapping from
// "what the file says" to "what gets executed" can be tested without building
// anything (plan.test.mjs). dromon.mjs gathers the facts about the checkout and
// runs the result.
//
// Each app has ONE file, apps/<app>/dromon.yaml (`schema: 1`), in two parts:
//
//   app:        what the app IS — its identifier, which cargo workspace and
//               package build it, its frontend, what it may never link
//   variants:   the named ways to build it — features, profile, platforms,
//               formats, signing, tests, output directory
//
// An unknown key or value is an error, never a default: a typo must not quietly
// build something else.

import { parse } from "yaml";

export const SCHEMA = 1;

/** Package formats per host. Tauri compiles for the machine it runs on — there
 *  is no cross-compile for desktop targets — so a format this host cannot
 *  produce is refused up front rather than minutes into a cargo build. */
export const BUNDLES = {
  linux: ["deb", "rpm", "appimage"],
  darwin: ["dmg", "app"],
  win32: ["msi", "nsis"],
};

const HOST_NAMES = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** How a host is named in a per-OS `desktop.bundles` map. */
export const HOST_KEYS = { linux: "linux", darwin: "macos", win32: "windows" };

/** How a Windows package is signed (Authenticode). `certificate`: a code-signing
 *  certificate in the Windows certificate store, named by its thumbprint in
 *  DROMON_WINDOWS_CERT_THUMBPRINT (timestamped at DROMON_WINDOWS_TIMESTAMP_URL,
 *  default DigiCert's); `command`: a command that signs the file `%1` (a cloud
 *  signer, a hardware token), in DROMON_WINDOWS_SIGN_COMMAND; `none`: not
 *  signed — SmartScreen warns on every install, so for testing only. */
export const WINDOWS_SIGNING = ["none", "certificate", "command"];

/** How the installer gets Microsoft Edge WebView2 where it is missing
 *  (Windows 10 before it shipped by default). */
export const WEBVIEW2 = {
  download: "downloadBootstrapper", // a small bootstrapper fetches it (needs internet)
  embed: "embedBootstrapper", //        the bootstrapper inside the installer
  offline: "offlineInstaller", //       the whole runtime inside (about 130 MB more)
  skip: "skip", //                      assume it is there
};

export const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

/** The names build_android.sh accepts; it is the authority and refuses
 *  anything else, this only refuses it sooner. */
export const ABIS = ["aarch64", "x86_64", "armv7", "i686"];

const PROFILES = ["release", "debug"];

/** How an Android package is signed. `debug-key` is the SDK's debug key (debug
 *  builds only); `release-key` the app's keystore (release builds only, the
 *  default there); `none` a release that is deliberately NOT signed — it
 *  installs nowhere and must never be distributed. */
export const ANDROID_SIGNING = ["debug-key", "release-key", "none"];

const KINDS = ["tauri"];

const KEYS = {
  file: ["schema", "app", "variants"],
  app: ["kind", "identifier", "cargo", "frontend", "android", "forbid_crates", "cli"],
  cargo: ["workspace", "package", "test_packages"],
  frontend: ["workspace", "entry"],
  cli: ["package", "bin", "workspace"],
  variant: ["output_dir", "features", "forbid_crates", "test", "desktop", "android", "cli"],
  vDesktop: ["enabled", "profile", "bundles", "windows"],
  vWindows: ["signing", "webview2"],
  vAndroid: ["enabled", "profile", "abis", "signing"],
  vCli: ["enabled", "profile", "bundle"],
};

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const NAME = /^[a-z][a-z0-9_-]*$/;

/** A little validation kit: every problem is collected, not just the first, and
 *  each names the path of the key at fault. */
function checker() {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
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
  const oneOf = (path, value, allowed, fallback) => {
    if (value === undefined) return fallback;
    if (!allowed.includes(value)) err(path, `must be one of ${allowed.join(", ")}, not ${JSON.stringify(value)}`);
    return value;
  };
  const str = (path, value) => {
    if (typeof value !== "string" || value.trim() === "") {
      err(path, value === undefined ? "required" : `must be a non-empty string, not ${JSON.stringify(value)}`);
      return undefined;
    }
    return value;
  };
  const list = (path, value) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      err(path, `must be a list of names, e.g. [a, b] — not ${JSON.stringify(value)}`);
      return [];
    }
    const seen = new Set();
    for (const v of value) {
      if (seen.has(v)) err(path, `${v} is listed twice`);
      seen.add(v);
    }
    return value;
  };
  /** A relative, forward-slash path inside the repo. */
  const repoPath = (path, value) => {
    const v = str(path, value);
    if (v && v !== "." && (v.startsWith("/") || v.split("/").includes("..") || v.includes("\\"))) {
      err(path, `must be a path inside the repo, relative to its root, with forward slashes — not ${JSON.stringify(v)}`);
    }
    return v;
  };
  const map = (path, value, keys) => {
    if (value === undefined) return {};
    if (!isMap(value)) {
      err(path, "must be a mapping");
      return {};
    }
    unknown(`${path}.`, value, keys);
    return value;
  };
  return { errors, err, unknown, bool, oneOf, str, list, repoPath, map };
}

/**
 * Parse and validate one app's file, apps/<name>/dromon.yaml.
 *
 * Returns { app, variants, errors }:
 *   app        what the app is, every default filled in; `dir` is apps/<name>
 *   variants   { <variant>: raw section } — validated by loadVariant, which
 *              needs facts from the checkout
 * Both are null when there are errors.
 */
export function loadAppFile(text, name) {
  let raw;
  try {
    raw = parse(text);
  } catch (e) {
    return { app: null, variants: null, errors: [`not valid YAML — ${e.message}`] };
  }
  if (!isMap(raw)) return { app: null, variants: null, errors: ["the file must be a mapping with app: and variants:"] };

  const c = checker();
  c.unknown("", raw, KEYS.file);
  if (raw.schema !== SCHEMA) c.err("schema", `must be ${SCHEMA} (the version of this file's shape), not ${JSON.stringify(raw.schema)}`);
  if (!NAME.test(name)) c.err("", `${JSON.stringify(name)} is not an app name: lower case letters, digits, - and _`);

  const dir = `apps/${name}`;
  const a = isMap(raw.app) ? raw.app : (c.err("app", "required — a mapping saying what the app is"), {});
  c.unknown("app.", a, KEYS.app);
  const kind = a.kind === undefined ? (c.err("app.kind", `required (${KINDS.join(", ")})`), undefined) : c.oneOf("app.kind", a.kind, KINDS);
  const identifier = c.str("app.identifier", a.identifier);

  const cargo = isMap(a.cargo) ? a.cargo : (c.err("app.cargo", "required — a mapping with workspace and package"), {});
  c.unknown("app.cargo.", cargo, KEYS.cargo);
  const workspace = c.repoPath("app.cargo.workspace", cargo.workspace);
  const pkg = c.str("app.cargo.package", cargo.package);
  const testPackages = c.list("app.cargo.test_packages", cargo.test_packages);

  const fe = c.map("app.frontend", a.frontend, KEYS.frontend);
  const frontend = {
    workspace: fe.workspace === undefined ? dir : c.repoPath("app.frontend.workspace", fe.workspace),
    entry: fe.entry === undefined ? "index.html" : c.str("app.frontend.entry", fe.entry),
  };

  const cli = [];
  if (a.cli !== undefined) {
    if (!Array.isArray(a.cli)) c.err("app.cli", "must be a list of { package, bin }");
    else {
      a.cli.forEach((t, i) => {
        const at = `app.cli[${i}]`;
        if (!isMap(t)) return c.err(at, "must be a mapping with package and bin");
        c.unknown(`${at}.`, t, KEYS.cli);
        // A tool may come from another cargo workspace than the app's (Teutates ships the
        // `teutates` CLI from apps/irena); it is built there, against that workspace's lock.
        const ws = t.workspace === undefined ? workspace : c.repoPath(`${at}.workspace`, t.workspace);
        cli.push({ package: c.str(`${at}.package`, t.package), bin: c.str(`${at}.bin`, t.bin), workspace: ws });
      });
    }
  }

  const app = {
    name,
    kind,
    dir,
    identifier,
    cargo: { workspace, package: pkg, testPackages },
    frontend,
    android: c.bool("app.android", a.android, false),
    forbidCrates: c.list("app.forbid_crates", a.forbid_crates),
    cli,
  };

  let variants = null;
  if (!isMap(raw.variants) || Object.keys(raw.variants).length === 0) {
    c.err("variants", "must name at least one way to build the app");
  } else {
    variants = {};
    for (const [v, section] of Object.entries(raw.variants)) {
      if (!NAME.test(v) || v === "all") c.err(`variants.${v}`, "a variant name is lower case letters, digits, - and _ (and not `all`)");
      variants[v] = section;
    }
  }

  return c.errors.length ? { app: null, variants: null, errors: c.errors } : { app, variants, errors: [] };
}

/**
 * Check an app against the checkout. `facts` is what dromon.mjs found:
 *   tauriConf     { identifier } read from <dir>/src-tauri/tauri.conf.json, or null
 *   packages      the package names in its cargo workspace
 *   workspacePackages  { <workspace>: [names] } for the other workspaces app.cli names
 */
export function checkApp(app, facts) {
  const errors = [];
  if (!facts.tauriConf) errors.push(`app: no ${app.dir}/src-tauri/tauri.conf.json`);
  else if (facts.tauriConf.identifier !== app.identifier) {
    errors.push(`app.identifier: ${app.identifier} here, ${facts.tauriConf.identifier} in tauri.conf.json — an app's identifier names its data directory, so the two must agree`);
  }
  for (const p of [app.cargo.package, ...app.cargo.testPackages]) {
    if (p && !facts.packages.includes(p)) errors.push(`app: no package ${p} in the cargo workspace at ${app.cargo.workspace}`);
  }
  for (const t of app.cli) {
    const names = t.workspace === app.cargo.workspace ? facts.packages : facts.workspacePackages?.[t.workspace] ?? [];
    if (t.package && !names.includes(t.package)) errors.push(`app: no package ${t.package} in the cargo workspace at ${t.workspace}`);
  }
  return errors;
}

/**
 * Validate one variant of an app.
 *
 * `facts`:
 *   platform   process.platform
 *   windowsSigning  { thumbprint, timestampUrl, command } from the environment
 *                   (read only for a Windows build that signs)
 *   features   the app package's feature CATALOGUE: { <id>: [required ids] }
 *   defaults   the ids its `default` feature turns on
 *
 * Returns { config, errors }; config is
 *   { app, variant, outputDir, features, forbidCrates, test, desktop, android, cli }
 */
export function loadVariant(app, variant, section, facts) {
  const c = checker();
  const at = `variants.${variant}`;
  if (!isMap(section)) {
    c.err(at, "must be a mapping");
    return { config: null, errors: c.errors };
  }
  c.unknown(`${at}.`, section, KEYS.variant);

  const outputDir = c.repoPath(`${at}.output_dir`, section.output_dir);

  // The allowlist. `null` = this app has no optional features at all.
  //
  // Nothing here is a default: an app with a catalogue must say which features
  // it wants, every id must exist, and the list must be CLOSED under
  // requirements — a feature that needs another is refused, never quietly
  // widened, so the file always says exactly what is built.
  const catalogue = facts.features ?? {};
  const ids = Object.keys(catalogue);
  let features = null;
  if (ids.length === 0) {
    if (section.features !== undefined) c.err(`${at}.features`, `${app.name} has no optional features (no [features] in its Cargo.toml)`);
  } else if (section.features === undefined) {
    c.err(`${at}.features`, `required — list the features to build ([] for none; available: ${ids.join(", ")})`);
  } else {
    features = [];
    for (const id of c.list(`${at}.features`, section.features)) {
      if (!ids.includes(id)) c.err(`${at}.features`, `unknown feature ${JSON.stringify(id)} (available: ${ids.join(", ")})`);
      else if (!features.includes(id)) features.push(id);
    }
    for (const id of features) {
      for (const needs of catalogue[id]) {
        if (!features.includes(needs)) c.err(`${at}.features`, `${id} requires ${needs}, which is not listed`);
      }
    }
    // Cargo adds `default` to every build that does not opt out, and Tauri's
    // build has no clean way to opt out. So an allowlist is only exact when the
    // app has no defaults.
    if ((facts.defaults ?? []).length) {
      c.err(`${at}.features`, `${app.name}'s Cargo.toml turns on ${facts.defaults.join(", ")} by default, so a list cannot be exact — make its default empty`);
    }
  }

  const config = {
    app: app.name,
    variant,
    outputDir,
    features,
    // What this variant must not link, on top of what the app may never link.
    forbidCrates: [...new Set([...app.forbidCrates, ...c.list(`${at}.forbid_crates`, section.forbid_crates)])],
    test: c.bool(`${at}.test`, section.test, false),
    desktop: null,
    android: null,
    cli: null,
  };

  if (section.desktop !== undefined) {
    const d = c.map(`${at}.desktop`, section.desktop, KEYS.vDesktop);
    const here = BUNDLES[facts.platform] ?? [];
    const hostName = HOST_NAMES[facts.platform] ?? facts.platform;
    const enabled = c.bool(`${at}.desktop.enabled`, d.enabled, true);
    // One list (this host's formats), or one list per OS: `{ linux: [deb, rpm],
    // windows: [msi, nsis] }`, of which this host builds its own.
    let bundles = [];
    let declaresWindows = false;
    if (isMap(d.bundles)) {
      c.unknown(`${at}.desktop.bundles.`, d.bundles, Object.values(HOST_KEYS));
      for (const [plat, key] of Object.entries(HOST_KEYS)) {
        if (d.bundles[key] === undefined) continue;
        const list = c.list(`${at}.desktop.bundles.${key}`, d.bundles[key]);
        for (const b of list) {
          if (!BUNDLES[plat].includes(b)) {
            c.err(`${at}.desktop.bundles.${key}`, `${JSON.stringify(b)} is not a ${HOST_NAMES[plat]} format (${HOST_NAMES[plat]} builds: ${BUNDLES[plat].join(", ")})`);
          }
        }
        if (plat === "win32") declaresWindows = list.length > 0;
        if (plat === facts.platform) bundles = list;
      }
      const mine = HOST_KEYS[facts.platform];
      if (enabled && (!mine || d.bundles[mine] === undefined)) {
        c.err(`${at}.desktop.bundles`, `no ${hostName} packages: this variant names ${Object.keys(d.bundles).join(", ")} only — add \`${mine ?? facts.platform}: [...]\` to build here`);
      }
    } else {
      bundles = c.list(`${at}.desktop.bundles`, d.bundles);
      declaresWindows = bundles.some((b) => BUNDLES.win32.includes(b));
      for (const b of bundles) {
        if (here.includes(b)) continue;
        const host = Object.keys(BUNDLES).find((p) => BUNDLES[p].includes(b));
        c.err(
          `${at}.desktop.bundles`,
          host
            ? `${b} has to be built on ${HOST_NAMES[host]}; this is ${hostName}. ` +
                `Tauri compiles for the machine it runs on — there is no cross-compile for desktop packages`
            : `unknown package format ${JSON.stringify(b)} (this host builds: ${here.join(", ")})`,
        );
      }
    }
    const desktop = { profile: c.oneOf(`${at}.desktop.profile`, d.profile, PROFILES, "release"), bundles, windows: null };

    // Windows: signing is always said, never assumed — an unsigned installer
    // is a choice (`none`), not something a missing secret quietly produces.
    if (d.windows !== undefined || declaresWindows) {
      const w = c.map(`${at}.desktop.windows`, d.windows ?? {}, KEYS.vWindows);
      if (w.signing === undefined) {
        c.err(`${at}.desktop.windows.signing`, `required for Windows packages (${WINDOWS_SIGNING.join(" | ")})`);
      }
      const signing = c.oneOf(`${at}.desktop.windows.signing`, w.signing, WINDOWS_SIGNING, "none");
      const webview2 = c.oneOf(`${at}.desktop.windows.webview2`, w.webview2, Object.keys(WEBVIEW2), "download");
      desktop.windows = { signing, webview2 };
      // The secrets are checked only where they are used: a Windows build.
      if (enabled && facts.platform === "win32") {
        const env = facts.windowsSigning ?? {};
        if (signing === "certificate" && !env.thumbprint) {
          c.err(`${at}.desktop.windows.signing`, "certificate: set DROMON_WINDOWS_CERT_THUMBPRINT to the signing certificate's thumbprint");
        }
        if (signing === "command" && !env.command) {
          c.err(`${at}.desktop.windows.signing`, "command: set DROMON_WINDOWS_SIGN_COMMAND to a command that signs %1");
        }
      }
    }
    if (enabled) config.desktop = desktop;
  }

  if (section.android !== undefined) {
    const a = c.map(`${at}.android`, section.android, KEYS.vAndroid);
    const enabled = c.bool(`${at}.android.enabled`, a.enabled, true);
    if (enabled && !app.android) c.err(`${at}.android`, `${app.name} has no Android build (app.android is not true)`);
    let abis = c.list(`${at}.android.abis`, a.abis);
    if (abis.length === 0) abis = ["aarch64"];
    if (abis.includes("all") && abis.length > 1) c.err(`${at}.android.abis`, "`all` already means every ABI — list it alone");
    for (const abi of abis) {
      if (abi !== "all" && !ABIS.includes(abi)) c.err(`${at}.android.abis`, `unknown ABI ${JSON.stringify(abi)} (known: ${ABIS.join(", ")}, all)`);
    }
    const profile = c.oneOf(`${at}.android.profile`, a.profile, PROFILES, "debug");
    const signing = c.oneOf(`${at}.android.signing`, a.signing, ANDROID_SIGNING, profile === "release" ? "release-key" : "debug-key");
    if (profile === "debug" && signing !== "debug-key") {
      c.err(`${at}.android.signing`, "a debug build is always signed with the SDK debug key (debug-key)");
    }
    if (profile === "release" && signing === "debug-key") {
      c.err(`${at}.android.signing`, "a release is signed with the app's keystore (release-key), or deliberately not at all (none)");
    }
    if (enabled) config.android = { profile, abis, signing };
  }

  if (section.cli !== undefined) {
    const t = c.map(`${at}.cli`, section.cli, KEYS.vCli);
    const enabled = c.bool(`${at}.cli.enabled`, t.enabled, true);
    if (enabled && app.cli.length === 0) c.err(`${at}.cli`, `${app.name} has no command-line tools (no app.cli)`);
    const profile = c.oneOf(`${at}.cli.profile`, t.profile, PROFILES, "release");
    // bundle: the tools go into the desktop .deb/.rpm, in /usr/bin, beside the app.
    const bundle = c.bool(`${at}.cli.bundle`, t.bundle, false);
    if (enabled && bundle) {
      const pk = config.desktop?.bundles ?? [];
      if (!config.desktop || !pk.some((b) => b === "deb" || b === "rpm")) {
        c.err(`${at}.cli.bundle`, "puts the tools into the desktop .deb/.rpm — this variant builds neither");
      }
    }
    if (enabled) config.cli = { profile, bundle };
  }

  return { config: c.errors.length ? null : config, errors: c.errors };
}

/** The cargo arguments that select exactly this app and exactly its features.
 *
 *  ONE package, never --workspace: cargo unifies features across every package
 *  an invocation selects, so `cargo build --workspace` would hand Enigma the
 *  gervasius `gervazy` half (and OpenSSL) that Morion turns on. */
export function cargoSelection(app, features, extraPackages = []) {
  const argv = ["-p", app.cargo.package];
  for (const p of extraPackages) argv.push("-p", p);
  if (features) {
    argv.push("--no-default-features");
    if (features.length) argv.push("--features", features.join(","));
  }
  return argv;
}

/** The variable the app's frontend reads its feature list from. */
export const featureEnvName = (name) => `${name.toUpperCase()}_FEATURES`;

/**
 * The ordered steps that build one variant.
 *
 * `known` is the app's facts, plus:
 *   targetDir      the cargo workspace's target directory (absolute)
 *   androidScript  build_android.sh, as a path from the repo root
 *   workspaceTargetDirs  { <workspace>: target dir } for app.cli's other workspaces
 *
 * Each step is one of
 *   { title, cwd, argv, env }                       run; cwd relative to the repo root
 *   { title, cwd, argv, env, forbid: [crates] }     run, and its output must name none of them
 *   { title, cleanBundles: profile }                remove stale bundles first
 *   { title, collect: "desktop"|"android"|"cli", profile, bins?, targetDir? }
 *   { title, writeJson: file, json }                write a Tauri config file merged over tauri.conf.json
 */
export function planBuild(config, app, known) {
  const steps = [];
  const name = config.app;
  const ws = app.cargo.workspace;

  // The allowlist reaches the build twice, and both halves must get the same
  // list. Cargo takes it as `--features`, so an omitted feature's Rust code and
  // optional dependencies are not compiled. The frontend takes it from
  // `<APP>_FEATURES` in the environment (the app's vite.config reads it), so the
  // bundler drops the omitted feature's code too. Set on EVERY step — the test
  // run and the Android build must be the same build as the desktop one.
  const list = config.features;
  const env = list ? { [featureEnvName(name)]: list.join(",") } : {};
  const featureArgs = list && list.length ? ["--features", list.join(",")] : [];

  // Preflight: the tree this build resolves to links nothing it must not. Asked
  // of cargo before anything compiles, with exactly the build's selection.
  if (config.forbidCrates.length) {
    steps.push({
      title: `${name}: preflight — links none of ${config.forbidCrates.join(", ")}`,
      cwd: ws,
      argv: ["cargo", "tree", "--locked", "-e", "normal", "--prefix", "none", "--format", "{p}", ...cargoSelection(app, list)],
      env,
      forbid: config.forbidCrates,
    });
  }

  if (config.test) {
    // Smoke only: the app's `smoke` npm script, a handful of essential checks
    // (its CSP, or that its shell mounts). The Rust side is compiled by
    // `tauri build` itself. Fast unit tests: ./fast_tests.sh; everything,
    // integration and e2e included: ./user_tests.sh.
    steps.push({ title: `${name}: smoke`, cwd: ".", argv: ["npm", "run", "smoke", "--if-present", "-w", app.frontend.workspace], env });
  }

  // The tools first: a desktop package that carries them needs them built.
  const cliFiles = {};
  if (config.cli) {
    const { profile } = config.cli;
    const byWs = new Map();
    for (const t of app.cli) byWs.set(t.workspace, [...(byWs.get(t.workspace) ?? []), t]);
    for (const [cliWs, tools] of byWs) {
      const argv = ["cargo", "build", "--locked"];
      if (profile === "release") argv.push("--release");
      for (const p of new Set(tools.map((t) => t.package))) argv.push("-p", p);
      const targetDir = (cliWs === ws ? known.targetDir : known.workspaceTargetDirs?.[cliWs]) ?? known.targetDir;
      const bins = tools.map((t) => t.bin);
      steps.push({ title: `${name}: command-line tools (${bins.join(", ")})${cliWs === ws ? "" : ` from ${cliWs}`}`, cwd: cliWs, argv, env: {} });
      steps.push({ title: `${name}: command-line binaries`, collect: "cli", profile, bins, targetDir });
      for (const b of bins) cliFiles[`/usr/bin/${b}`] = `${targetDir}/${profile}/${b}`;
    }
  }

  if (config.desktop) {
    const { profile, bundles } = config.desktop;
    const argv = ["npx", "tauri", "build"];
    if (profile === "debug") argv.push("--debug");
    if (bundles.length) argv.push("--bundles", bundles.join(","));
    argv.push(...featureArgs);
    // Stale bundles from a previous run would be reported as this build's.
    steps.push({ title: `${name}: clear old ${profile} bundles`, cleanBundles: profile });
    // Windows settings reach Tauri as a config file merged over tauri.conf.json
    // (a file, not inline JSON: npx runs through cmd.exe there, which mangles
    // quotes).
    if (known.platform === "win32" && config.desktop.windows) {
      const file = `${known.targetDir}/dromon/${name}-${config.variant}-windows.json`;
      steps.push({ title: `${name}: Windows bundle settings`, writeJson: file, json: windowsConfig(config.desktop.windows, known.windowsSigning ?? {}) });
      argv.push("--config", file);
    }
    // The tools inside the Linux packages: Tauri copies `files` (destination → source)
    // into the .deb and the .rpm, merged over tauri.conf.json like the Windows settings.
    if (config.cli?.bundle && known.platform === "linux") {
      const file = `${known.targetDir}/dromon/${name}-${config.variant}-cli.json`;
      steps.push({ title: `${name}: command-line tools in the packages`, writeJson: file, json: { bundle: { linux: { deb: { files: cliFiles }, rpm: { files: cliFiles } } } } });
      argv.push("--config", file);
    }
    // `tauri build` runs the frontend build itself (beforeBuildCommand: the
    // typecheck, then vite), so a type error stops it before any Rust. It
    // builds the one package in src-tauri — no other app's features reach it.
    steps.push({ title: `${name}: desktop ${profile} bundle`, cwd: app.dir, argv, env });
    steps.push({ title: `${name}: desktop packages`, collect: "desktop", profile });
  }

  if (config.android) {
    const { profile, abis, signing } = config.android;
    const argv = ["bash", known.androidScript, name, profile, abis.join(",")];
    if (signing === "none") argv.push("--allow-unsigned-release");
    if (signing === "release-key") argv.push("--signed");
    if (featureArgs.length) argv.push(`--features=${list.join(",")}`);
    steps.push({ title: `${name}: Android ${profile} (${abis.join(", ")})`, cwd: ".", argv, env });
    steps.push({ title: `${name}: Android packages`, collect: "android", profile });
  }

  return steps;
}

/** The Tauri config (merged over tauri.conf.json) for a Windows build. */
export function windowsConfig({ signing, webview2 }, env) {
  const windows = { webviewInstallMode: { type: WEBVIEW2[webview2] } };
  if (signing === "certificate") {
    windows.certificateThumbprint = env.thumbprint;
    windows.digestAlgorithm = "sha256";
    windows.timestampUrl = env.timestampUrl || DEFAULT_TIMESTAMP_URL;
  }
  if (signing === "command") windows.signCommand = env.command;
  return { bundle: { windows } };
}

/** Lines of `cargo tree --format {p} --prefix none` that name a forbidden crate. */
export function forbiddenIn(treeOutput, forbid) {
  const found = new Set();
  for (const line of treeOutput.split("\n")) {
    const crate = line.trim().split(" ")[0];
    if (forbid.includes(crate)) found.add(crate);
  }
  return [...found].sort();
}
