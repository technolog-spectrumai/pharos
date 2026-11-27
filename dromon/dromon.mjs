#!/usr/bin/env node
// Dromon: Belisario's build. Reads apps/<app>/dromon.yaml, asks the checkout the
// facts the file is checked against, and runs the plan.
//
// The mapping from the file to commands lives in plan.mjs and is pure; this
// file is everything with side effects — cargo metadata, processes, files.
//
//   node dromon/dromon.mjs APP [VARIANT] [--dry-run | --validate]
//   node dromon/dromon.mjs APP all       every variant of APP
//   node dromon/dromon.mjs all           every variant of every app
//   node dromon/dromon.mjs --list
//   node dromon/dromon.mjs APP VARIANT --print-features
//
// Normally reached through ./build.sh at the repo root, which checks the
// toolchain and installs dependencies first.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkApp, forbiddenIn, loadAppFile, loadVariant, planBuild } from "./plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dromon/ → the repo root.
const ROOT = path.resolve(process.env.REPO_ROOT ?? path.join(HERE, ".."));
const FILE = "dromon.yaml";

const USAGE = `Dromon — build an app as its apps/<app>/dromon.yaml says.

  ./build.sh APP VARIANT              build one variant (e.g. ./build.sh enigma pro)
  ./build.sh APP                      the app's only variant (an error if it has several)
  ./build.sh APP all                  every variant of the app
  ./build.sh all                      every variant of every app
  ./build.sh ... --dry-run            print the commands it resolves to, run none
  ./build.sh ... --validate           check the file against the checkout, build nothing
  ./build.sh --list                   the apps and their variants

What is built — features, debug or release, platforms, package formats,
signing, tests, where it lands — is set in the app's dromon.yaml and nowhere
else.`;

const step = (msg) => console.log(`\n\x1b[1;36m==> ${msg}\x1b[0m`);
const die = (msg) => {
  console.error(`\x1b[1;31mERROR: ${msg}\x1b[0m`);
  process.exit(1);
};
const rel = (p) => {
  const r = path.relative(ROOT, p);
  return r === "" ? "." : r.startsWith("..") ? p : r;
};

// ── arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { app: null, variant: null, mode: "build", list: false, printFeatures: false };
  const positional = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a === "--dry-run") args.mode = "dry-run";
    else if (a === "--validate") args.mode = "validate";
    else if (a === "--list") args.list = true;
    else if (a === "--print-features") args.printFeatures = true;
    else if (a.startsWith("-")) die(`unknown option ${a} — what is built is set in dromon.yaml (try --help)`);
    else positional.push(a);
  }
  if (args.list) {
    if (positional.length) die("--list takes no app or variant");
    return args;
  }
  if (positional.length === 0 || positional.length > 2) die("name an app and a variant, e.g. ./build.sh enigma pro (try --help)");
  [args.app, args.variant = null] = positional;
  if (args.app === "all" && args.variant) die("`all` builds every variant of every app; it takes no variant");
  return args;
}

// ── facts about the checkout ────────────────────────────────────────────────

const metadataCache = new Map();
/** `cargo metadata` for a workspace, once per run. */
function metadata(workspace) {
  if (metadataCache.has(workspace)) return metadataCache.get(workspace);
  const out = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {
    cwd: path.join(ROOT, workspace),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) die(`cargo metadata failed in ${workspace}:\n${out.stderr}`);
  const meta = JSON.parse(out.stdout);
  metadataCache.set(workspace, meta);
  return meta;
}

/** A Cargo `[features]` table as { id: [ids it requires] }, without `default`.
 *  Of each feature's entries, only the ones naming ANOTHER feature are
 *  requirements; `dep:crate` and `crate/feature` are cargo's business. */
function catalogueOf(table) {
  const ids = Object.keys(table).filter((id) => id !== "default");
  return Object.fromEntries(ids.map((id) => [id, table[id].filter((entry) => ids.includes(entry))]));
}

/** Every app: a directory under apps/ with a dromon.yaml. */
function appNames() {
  return fs
    .readdirSync(path.join(ROOT, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, "apps", e.name, FILE)))
    .map((e) => e.name)
    .sort();
}

const problems = (file, errors) => `${file} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`;

/** Read, validate and check one app's file. */
function readApp(name) {
  const file = `apps/${name}/${FILE}`;
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) die(`no app ${name}: there is no ${file} (apps: ${appNames().join(", ")})`);
  const { app, variants, errors } = loadAppFile(fs.readFileSync(full, "utf8"), name);
  if (errors.length) die(problems(file, errors));

  const confPath = path.join(ROOT, app.dir, "src-tauri", "tauri.conf.json");
  const meta = metadata(app.cargo.workspace);
  const pkg = meta.packages.find((p) => p.name === app.cargo.package);
  // The other workspaces an app's tools come from (Teutates: apps/irena).
  const workspacePackages = {};
  const workspaceTargetDirs = {};
  for (const ws of new Set(app.cli.map((t) => t.workspace).filter((w) => w !== app.cargo.workspace))) {
    const m = metadata(ws);
    workspacePackages[ws] = m.packages.map((p) => p.name);
    workspaceTargetDirs[ws] = m.target_directory;
  }
  const facts = {
    platform: process.platform,
    tauriConf: fs.existsSync(confPath) ? JSON.parse(fs.readFileSync(confPath, "utf8")) : null,
    packages: meta.packages.map((p) => p.name),
    features: catalogueOf(pkg?.features ?? {}),
    defaults: pkg?.features?.default ?? [],
    targetDir: meta.target_directory,
    workspacePackages,
    workspaceTargetDirs,
    androidScript: "tools/android/build_android.sh",
    windowsSigning: {
      thumbprint: process.env.DROMON_WINDOWS_CERT_THUMBPRINT ?? "",
      timestampUrl: process.env.DROMON_WINDOWS_TIMESTAMP_URL ?? "",
      command: process.env.DROMON_WINDOWS_SIGN_COMMAND ?? "",
    },
  };
  const mismatch = checkApp(app, facts);
  if (mismatch.length) die(`${file} does not match the checkout:\n${mismatch.map((e) => `  - ${e}`).join("\n")}`);

  const configs = {};
  for (const [v, section] of Object.entries(variants)) {
    const { config, errors: verrs } = loadVariant(app, v, section, facts);
    if (verrs.length) die(problems(file, verrs));
    configs[v] = config;
  }
  return { file, app, facts, configs };
}

// ── artifacts ───────────────────────────────────────────────────────────────

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

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const megabytes = (file) => {
  const stat = fs.statSync(file);
  return stat.isDirectory() ? "   (dir)" : `${(stat.size / 1_048_576).toFixed(1).padStart(8)} MB`;
};

/** Copy this build's packages into <output_dir>/<app>/ and refresh the
 *  checksums there. Returns the delivered paths. */
function deliver(name, packages, outputDir, rename) {
  const dest = path.resolve(ROOT, outputDir, name);
  fs.mkdirSync(dest, { recursive: true });
  const delivered = packages.map((src) => {
    const to = path.join(dest, rename(path.basename(src)));
    fs.cpSync(src, to, { recursive: true, force: true });
    return to;
  });
  const sums = fs
    .readdirSync(dest, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== "SHA256SUMS" && e.name !== "build.json")
    .map((e) => `${sha256(path.join(dest, e.name))}  ${e.name}`)
    .sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  fs.writeFileSync(path.join(dest, "SHA256SUMS"), sums.join("\n") + "\n");
  return delivered;
}

const git = (...a) => {
  const out = spawnSync("git", a, { cwd: ROOT, encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : null;
};

/** What was built and from what, beside the packages: the commit, whether the
 *  tree was clean, the app file and variant, the resolved build, every step with
 *  its status and time, every artifact with its hash. */
function writeRecord(dest, record) {
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "build.json"), JSON.stringify(record, null, 2) + "\n");
}

// ── running ─────────────────────────────────────────────────────────────────

const shown = (s) => {
  const env = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v} `).join("");
  return `${s.cwd === "." ? "" : `(in ${s.cwd}) `}${env}${s.argv.join(" ")}`;
};

function runBuild(config, loaded, mode) {
  const { app, facts, file } = loaded;
  const name = config.app;
  const steps = planBuild(config, app, facts);
  const bundleDir = (profile) => path.join(facts.targetDir, profile, "bundle");
  const dest = path.resolve(ROOT, config.outputDir, name);
  const built = [];
  const record = {
    schema: 1,
    app: name,
    variant: config.variant,
    identifier: app.identifier,
    file,
    commit: git("rev-parse", "HEAD"),
    dirty: (git("status", "--porcelain") ?? "") !== "",
    features: config.features,
    platforms: { desktop: config.desktop, android: config.android, cli: config.cli },
    steps: [],
    artifacts: [],
  };

  step(`${name} ${config.variant}${config.features ? ` (features: ${config.features.join(", ") || "none"})` : ""}`);

  for (const s of steps) {
    if (s.cleanBundles) {
      if (mode === "build") fs.rmSync(bundleDir(s.cleanBundles), { recursive: true, force: true });
      continue;
    }

    if (s.writeJson) {
      if (mode === "dry-run") {
        step(s.title);
        console.log(`    ${s.writeJson}: ${JSON.stringify(s.json)}`);
      } else if (mode === "build") {
        fs.mkdirSync(path.dirname(s.writeJson), { recursive: true });
        fs.writeFileSync(s.writeJson, JSON.stringify(s.json, null, 2) + "\n");
      }
      continue;
    }

    if (s.collect) {
      if (mode !== "build") continue;
      let packages;
      let rename = (base) => base;
      if (s.collect === "android") {
        packages = findPackages(
          path.join(ROOT, app.dir, "src-tauri", "gen", "android", "app", "build", "outputs"),
          ANDROID_PACKAGES,
        ).filter((p) => p.toLowerCase().includes(s.profile));
        rename = (base) => `${name}-${base.replace(/^app-/, "")}`;
      } else if (s.collect === "cli") {
        packages = s.bins.map((b) => path.join(s.targetDir ?? facts.targetDir, s.profile, b)).filter((p) => fs.existsSync(p));
        if (packages.length !== s.bins.length) die(`${s.title}: cargo reported success but not every binary is there`);
      } else {
        packages = findPackages(bundleDir(s.profile), DESKTOP_PACKAGES);
      }
      if (packages.length === 0) die(`${s.title}: the build reported success but produced no package`);
      built.push(...deliver(name, packages, config.outputDir, rename));
      continue;
    }

    // The preflight runs in a validate as well: it builds nothing and is the
    // part of "is this file right" only cargo can answer.
    if (mode === "dry-run" || (mode === "validate" && !s.forbid)) {
      if (mode === "dry-run") {
        step(s.title);
        console.log(`    ${shown(s)}`);
      }
      continue;
    }

    step(s.title);
    console.log(`    ${shown(s)}`);
    const started = Date.now();
    // On Windows the command goes through cmd.exe (npx and npm are .cmd
    // files there), which splits an argument at its spaces unless quoted.
    const args = process.platform === "win32" ? s.argv.slice(1).map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)) : s.argv.slice(1);
    const result = spawnSync(s.argv[0], args, {
      cwd: path.join(ROOT, s.cwd),
      env: { ...process.env, ...s.env },
      stdio: s.forbid ? ["ignore", "pipe", "inherit"] : "inherit",
      encoding: s.forbid ? "utf8" : undefined,
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === "win32", // npx is a .cmd there
    });
    if (result.error) die(`${s.title}: cannot start ${s.argv[0]} — ${result.error.message}`);
    record.steps.push({ title: s.title, command: shown(s), status: result.status, seconds: Math.round((Date.now() - started) / 1000) });
    if (result.status !== 0) {
      if (mode === "build") writeRecord(dest, { ...record, result: "failed" });
      console.error(`\x1b[1;31mERROR: ${s.title} failed\x1b[0m`);
      process.exit(result.status ?? 1);
    }
    if (s.forbid) {
      const found = forbiddenIn(result.stdout, s.forbid);
      if (found.length) {
        if (mode === "build") writeRecord(dest, { ...record, result: "refused" });
        die(`${name} ${config.variant} would link ${found.join(", ")}, which ${file} forbids — nothing was built`);
      }
      console.log(`    ok: none of ${s.forbid.join(", ")}`);
    }
  }

  if (mode === "build") {
    record.artifacts = built
      .filter((f) => fs.statSync(f).isFile())
      .map((f) => ({ file: path.basename(f), bytes: fs.statSync(f).size, sha256: sha256(f) }));
    writeRecord(dest, { ...record, result: "built" });
  }
  return built;
}

// ── main ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  for (const name of appNames()) {
    const file = `apps/${name}/${FILE}`;
    const { app, variants, errors } = loadAppFile(fs.readFileSync(path.join(ROOT, file), "utf8"), name);
    if (errors.length) {
      console.log(`  ${name.padEnd(8)} (${file} is invalid — ./build.sh ${name} --validate says why)`);
      continue;
    }
    const extra = [app.android ? "android" : null, app.cli.length ? `cli: ${app.cli.map((t) => t.bin).join(", ")}` : null].filter(Boolean);
    console.log(`${name.padEnd(8)} ${app.identifier}${extra.length ? `  (${extra.join("; ")})` : ""}`);
    const names = Object.keys(variants);
    for (const v of names) console.log(`    ./build.sh ${name} ${names.length === 1 ? `[${v}]` : v}`);
  }
  process.exit(0);
}

// Which (app, variant) pairs this run builds, in a fixed order.
const runs = [];
const apps = args.app === "all" ? appNames() : [args.app];
for (const name of apps) {
  const loaded = readApp(name);
  const names = Object.keys(loaded.configs);
  let chosen;
  if (args.app === "all" || args.variant === "all") chosen = names;
  else if (args.variant) {
    if (!loaded.configs[args.variant]) die(`${loaded.file} has no variant ${args.variant} (it has: ${names.join(", ")})`);
    chosen = [args.variant];
  } else if (names.length === 1) chosen = names;
  else die(`${name} has several variants — name one: ${names.map((v) => `./build.sh ${name} ${v}`).join(", ")}`);
  for (const v of chosen) runs.push({ loaded, config: loaded.configs[v] });
}

// Two builds delivering to one place would overwrite each other's packages.
const outs = runs.map((r) => path.join(r.config.outputDir, r.config.app));
const twice = outs.find((o, i) => outs.indexOf(o) !== i);
if (twice) die(`two variants deliver to ${twice} — give each its own output_dir`);

if (args.printFeatures) {
  if (runs.length !== 1) die("--print-features takes one app and one variant");
  console.log((runs[0].config.features ?? []).join(","));
  process.exit(0);
}

const built = [];
for (const { loaded, config } of runs) {
  if (!config.desktop && !config.android && !config.cli && !config.test) {
    console.log(`\n${config.app} ${config.variant}: nothing enabled — skipped`);
    continue;
  }
  built.push(...runBuild(config, loaded, args.mode));
}

if (args.mode === "dry-run") console.log("\n(dry run — nothing was built)");
else if (args.mode === "validate") console.log(`\n\x1b[1;32mvalid:\x1b[0m ${runs.map((r) => `${r.config.app} ${r.config.variant}`).join(", ")}`);
else if (built.length) {
  step("Built");
  for (const file of built) console.log(`  ${megabytes(file)}  ${rel(file)}`);
}
