#!/usr/bin/env node
// Builds the apps build.yaml names, the way it says. Run through ./build.sh,
// which checks the toolchain and installs dependencies first — this file needs
// the `yaml` package and so cannot do that part itself.
//
// The mapping from the config to commands lives in build_plan.mjs and is pure;
// this file is the half that looks at the checkout and starts processes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, planApp } from "./build_plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Build Enigma and Morion as build.yaml says.

  ./build.sh                 every app in build.yaml
  ./build.sh enigma          one app (or several: ./build.sh enigma morion)
  ./build.sh --dry-run       print the commands the config resolves to, run none
  ./build.sh --config FILE   read another config instead of build.yaml

What is built — edition, debug or release, package formats, Android, tests —
is set in build.yaml and nowhere else.`;

const step = (msg) => console.log(`\n\x1b[1;36m==> ${msg}\x1b[0m`);
const die = (msg) => {
  console.error(`\x1b[1;31mERROR: ${msg}\x1b[0m`);
  process.exit(1);
};

// ── arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { config: "build.yaml", dryRun: false, apps: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--config") {
      args.config = argv[++i] ?? die("--config needs a file");
    } else if (a.startsWith("--config=")) {
      args.config = a.slice("--config=".length);
    } else if (a.startsWith("-")) {
      // Deliberately no --debug, --bundles and friends: a flag that overrides
      // the file is a second place a build can be configured.
      die(`unknown option ${a} — what is built is set in build.yaml (try --help)`);
    } else {
      args.apps.push(a);
    }
  }
  return args;
}

// ── what the checkout says ──────────────────────────────────────────────────

/** Every app under apps/ with a src-tauri/, and the editions each one has. */
function discoverApps() {
  const apps = {};
  for (const name of fs.readdirSync(path.join(ROOT, "apps")).sort()) {
    const srcTauri = path.join(ROOT, "apps", name, "src-tauri");
    if (!fs.existsSync(path.join(srcTauri, "tauri.conf.json"))) continue;
    const names = (dir, pattern) =>
      fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => pattern.exec(f)?.[1]).filter(Boolean).sort() : [];
    apps[name] = {
      editions: names(path.join(srcTauri, "configs"), /^build_config\.(.+)\.yaml$/),
      overlays: names(srcTauri, /^tauri\.(.+)\.conf\.json$/),
    };
  }
  return apps;
}

/** Asked of cargo rather than assumed: Morion is a member of the repo-root
 *  workspace and so builds into <repo>/target, Enigma stands outside it and
 *  builds beside its crate, and CARGO_TARGET_DIR overrides both. */
function cargoFacts(name) {
  const manifest = path.join(ROOT, "apps", name, "src-tauri", "Cargo.toml");
  const out = spawnSync(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.status !== 0) die(`cargo metadata failed for ${name}:\n${out.stderr}`);
  const meta = JSON.parse(out.stdout);
  return { inWorkspace: path.resolve(meta.workspace_root) === ROOT, targetDir: meta.target_directory };
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
const configPath = path.resolve(process.cwd(), args.config);
if (!fs.existsSync(configPath)) die(`no build config at ${configPath}`);

const facts = { platform: process.platform, apps: discoverApps() };
const { config, errors } = loadConfig(fs.readFileSync(configPath, "utf8"), facts);
if (errors.length) {
  die(`${path.relative(process.cwd(), configPath)} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

const names = args.apps.length ? args.apps : Object.keys(config.apps);
for (const name of names) {
  if (!config.apps[name]) die(`'${name}' is not in ${args.config} (it has: ${Object.keys(config.apps).join(", ")})`);
}

const built = [];
for (const name of names) {
  const app = config.apps[name];
  if (!app.desktop && !app.android && !app.test) {
    console.log(`\n${name}: nothing enabled in ${args.config} — skipped`);
    continue;
  }
  built.push(...runApp(name, app, { ...facts.apps[name], ...cargoFacts(name) }, config, args.dryRun));
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
