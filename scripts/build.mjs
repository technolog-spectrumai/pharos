#!/usr/bin/env node
// Builds the apps an app repo's build config names, the way it says. Run through
// build.sh, which checks the toolchain and installs dependencies first — this
// file needs the `yaml` package and so cannot do that part itself.
//
// The mapping from the config to commands lives in build_plan.mjs and is pure;
// this file is the half that looks at the checkout and starts processes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, planApp } from "./build_plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The app repo: Rutile is mounted one level below its root. build.sh passes it
// explicitly, so this default only matters when the file is run by hand.
const ROOT = path.resolve(process.env.REPO_ROOT ?? path.join(HERE, "..", ".."));

// The config a bare `./build.sh` reads. An app repo with presets names its
// default (Enigma: pro.yaml); otherwise it is build.yaml.
const DEFAULT_CONFIG = process.env.BUILD_CONFIG_DEFAULT || "build.yaml";

const USAGE = `Build this repo's apps as a build config says.

  ./build.sh                 what ${DEFAULT_CONFIG} describes
  ./build.sh FILE.yaml       what another config describes
  ./build.sh APP [APP...]    only these apps from the config
  ./build.sh --dry-run       print the commands the config resolves to, run none

What is built — features, debug or release, package formats, Android, tests —
is set in the config and nowhere else. (--config FILE is the same as naming the
file.)`;

const step = (msg) => console.log(`\n\x1b[1;36m==> ${msg}\x1b[0m`);
const die = (msg) => {
  console.error(`\x1b[1;31mERROR: ${msg}\x1b[0m`);
  process.exit(1);
};

// ── arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { config: null, dryRun: false, apps: [], printFeatures: null };
  const setConfig = (file) => {
    if (args.config) die(`two configs given: ${args.config} and ${file}`);
    args.config = file;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--config") {
      setConfig(argv[++i] ?? die("--config needs a file"));
    } else if (a.startsWith("--config=")) {
      setConfig(a.slice("--config=".length));
    } else if (a === "--print-features") {
      // For the dev runner and tests.sh: the validated allowlist of one app,
      // comma-separated, and nothing else on stdout.
      args.printFeatures = argv[++i] ?? die("--print-features needs an app name");
    } else if (a.startsWith("-")) {
      // Deliberately no --debug, --bundles and friends: a flag that overrides
      // the file is a second place a build can be configured.
      die(`unknown option ${a} — what is built is set in the config (try --help)`);
    } else if (/\.ya?ml$/.test(a)) {
      // A config, not an app: `./build.sh std.yaml`.
      setConfig(a);
    } else {
      args.apps.push(a);
    }
  }
  return args;
}

// ── what the checkout says ──────────────────────────────────────────────────

/** Every app under apps/ with a src-tauri/, and what cargo says about it.
 *
 *  Asked of cargo rather than assumed, for three things:
 *    * where it builds — Morion is a member of the repo-root workspace and so
 *      builds into <repo>/target, Enigma stands outside it and builds beside
 *      its crate, and CARGO_TARGET_DIR overrides both;
 *    * whether it is a workspace member, which decides how it is tested;
 *    * its feature catalogue — the `[features]` table of its Cargo.toml. */
function discoverApps() {
  const apps = {};
  for (const name of fs.readdirSync(path.join(ROOT, "apps")).sort()) {
    const manifest = path.join(ROOT, "apps", name, "src-tauri", "Cargo.toml");
    if (!fs.existsSync(path.join(path.dirname(manifest), "tauri.conf.json"))) continue;
    const out = spawnSync(
      "cargo",
      ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (out.status !== 0) die(`cargo metadata failed for ${name}:\n${out.stderr}`);
    const meta = JSON.parse(out.stdout);
    const pkg = meta.packages.find((p) => path.resolve(p.manifest_path) === manifest);
    apps[name] = {
      features: catalogueOf(pkg?.features ?? {}),
      inWorkspace: path.resolve(meta.workspace_root) === ROOT,
      targetDir: meta.target_directory,
      // Rutile's own script, as the app repo sees it.
      androidScript: path.relative(ROOT, path.join(HERE, "build_android.sh")),
    };
  }
  return apps;
}

/** A Cargo `[features]` table as { id: [ids it requires] }.
 *
 *  `default` is not a feature anyone lists — it is what a bare `cargo build`
 *  gets. Of each feature's entries, only the ones naming ANOTHER feature are
 *  requirements; `dep:crate` and `crate/feature` are what the feature pulls
 *  in, which is cargo's business. */
function catalogueOf(table) {
  const ids = Object.keys(table).filter((id) => id !== "default");
  return Object.fromEntries(ids.map((id) => [id, table[id].filter((entry) => ids.includes(entry))]));
}

// ── artefacts ───────────────────────────────────────────────────────────────

const DESKTOP_PACKAGES = [".deb", ".rpm", ".AppImage", ".dmg", ".msi", ".exe"];
const ANDROID_PACKAGES = [".apk", ".aab"];

/** Files under `dir` with one of `extensions`. A macOS .app is a directory and
 *  is reported whole rather than descended into. */
function findPackages(dir, extensions) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".app")) found.push(full);
        else walk(full);
      } else if (extensions.includes(path.extname(entry.name))) {
        found.push(full);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found.sort();
}

const megabytes = (file) => {
  const stat = fs.statSync(file);
  return stat.isDirectory() ? "   (dir)" : `${(stat.size / 1_048_576).toFixed(1).padStart(8)} MB`;
};

/** Copy this build's packages into <output_dir>/<app>/ and refresh the
 *  checksums there. Returns the paths to report. */
function deliver(name, packages, outputDir, rename) {
  if (!outputDir) return packages;
  const dest = path.resolve(ROOT, outputDir, name);
  fs.mkdirSync(dest, { recursive: true });
  const delivered = packages.map((src) => {
    const to = path.join(dest, rename(path.basename(src)));
    fs.cpSync(src, to, { recursive: true, force: true });
    return to;
  });
  const sums = fs
    .readdirSync(dest, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== "SHA256SUMS")
    .map((e) => `${createHash("sha256").update(fs.readFileSync(path.join(dest, e.name))).digest("hex")}  ${e.name}`)
    .sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  fs.writeFileSync(path.join(dest, "SHA256SUMS"), sums.join("\n") + "\n");
  return delivered;
}

// ── running ─────────────────────────────────────────────────────────────────

const shown = (s) => {
  const env = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v} `).join("");
  return `${s.cwd === "." ? "" : `(in ${s.cwd}) `}${env}${s.argv.join(" ")}`;
};

function runApp(name, app, known, config, dryRun) {
  const built = [];
  const bundleDir = (profile) => path.join(known.targetDir, profile, "bundle");

  for (const s of planApp(name, app, known)) {
    if (s.cleanBundles) {
      if (!dryRun) fs.rmSync(bundleDir(s.cleanBundles), { recursive: true, force: true });
      continue;
    }

    if (s.collect) {
      if (dryRun) continue;
      const android = s.collect === "android";
      const packages = android
        ? findPackages(
            path.join(ROOT, "apps", name, "src-tauri", "gen", "android", "app", "build", "outputs"),
            ANDROID_PACKAGES,
            // gen/android keeps both variants' outputs; report the one just built.
          ).filter((p) => p.toLowerCase().includes(s.profile))
        : findPackages(bundleDir(s.profile), DESKTOP_PACKAGES);
      if (packages.length === 0) die(`${s.title}: the build reported success but produced no package`);
      // Tauri names every Android output `app-…`; in a shared folder that says
      // nothing about which app it is.
      const rename = android ? (base) => `${name}-${base.replace(/^app-/, "")}` : (base) => base;
      built.push(...deliver(name, packages, config.outputDir, rename));
      continue;
    }

    step(s.title);
    console.log(`    ${shown(s)}`);
    if (dryRun) continue;
    const result = spawnSync(s.argv[0], s.argv.slice(1), {
      cwd: path.join(ROOT, s.cwd),
      env: { ...process.env, ...s.env },
      stdio: "inherit",
      shell: process.platform === "win32", // npx is a .cmd there
    });
    if (result.error) die(`${s.title}: cannot start ${s.argv[0]} — ${result.error.message}`);
    if (result.status !== 0) {
      console.error(`\x1b[1;31mERROR: ${s.title} failed\x1b[0m`);
      process.exit(result.status ?? 1);
    }
  }
  return built;
}

// ── main ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
// The repo's default config unless one was named. A name given by hand is
// looked for where it was typed first, then at the repo root — so
// `./build.sh std.yaml` works from any directory.
const wanted = args.config ?? DEFAULT_CONFIG;
const configPath =
  [path.resolve(process.cwd(), wanted), path.resolve(ROOT, wanted)].find((p) => fs.existsSync(p)) ??
  die(`no build config ${wanted} (looked in ${process.cwd()} and ${ROOT})`);
const configName = path.relative(process.cwd(), configPath) || configPath;

const facts = { platform: process.platform, apps: discoverApps() };
const { config, errors } = loadConfig(fs.readFileSync(configPath, "utf8"), facts);
if (errors.length) {
  die(`${configName} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

if (args.printFeatures) {
  const app = config.apps[args.printFeatures];
  if (!app) die(`'${args.printFeatures}' is not in ${configName} (it has: ${Object.keys(config.apps).join(", ")})`);
  console.log((app.features ?? []).join(","));
  process.exit(0);
}

const names = args.apps.length ? args.apps : Object.keys(config.apps);
for (const name of names) {
  if (!config.apps[name]) die(`'${name}' is not in ${configName} (it has: ${Object.keys(config.apps).join(", ")})`);
}

const built = [];
for (const name of names) {
  const app = config.apps[name];
  if (!app.desktop && !app.android && !app.test) {
    console.log(`\n${name}: nothing enabled in ${configName} — skipped`);
    continue;
  }
  built.push(...runApp(name, app, facts.apps[name], config, args.dryRun));
}

if (args.dryRun) {
  console.log("\n(dry run — nothing was built)");
} else if (built.length) {
  step("Built");
  for (const file of built) {
    const rel = path.relative(ROOT, file);
    console.log(`  ${megabytes(file)}  ${rel.startsWith("..") ? file : rel}`);
  }
}
