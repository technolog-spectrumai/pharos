// node --test scripts/lib.test.mjs
//
// lib.sh and tests_lib.sh, the shell every dev, build and test script sources,
// exercised through bash in a scratch directory: no app is built, nothing
// outside the scratch directory is touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SCRATCH = mkdtempSync(join(tmpdir(), "belisario-lib-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

// Runs `body` in bash with lib.sh (and tests_lib.sh) sourced, from SCRATCH.
// Only what the test passes in `env` is set beyond PATH and HOME, so a snap or
// an XDG override in the caller's shell cannot leak in.
function sh(body, env = {}) {
  const script = `set -euo pipefail
REPO_ROOT="${SCRATCH}"
. "${SCRIPTS}/lib.sh"
. "${SCRIPTS}/tests_lib.sh"
${body}`;
  const result = spawnSync("bash", ["-c", script], {
    cwd: SCRATCH,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: join(SCRATCH, "home"), ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tauriConf(identifier) {
  const path = join(SCRATCH, `tauri-${identifier ?? "none"}.conf.json`);
  writeFileSync(path, JSON.stringify(identifier ? { identifier } : { productName: "x" }));
  return path;
}

const linux = process.platform !== "darwin";

// ── stored data ─────────────────────────────────────────────────────────────

test("app_data_dir follows the bundle identifier and XDG_DATA_HOME", { skip: !linux }, () => {
  const conf = tauriConf("com.example.one");
  const xdg = sh(`app_data_dir "${conf}"`, { XDG_DATA_HOME: "/data" });
  assert.equal(xdg.stdout.trim(), "/data/com.example.one");
  const fallback = sh(`app_data_dir "${conf}"`);
  assert.equal(fallback.stdout.trim(), `${join(SCRATCH, "home")}/.local/share/com.example.one`);
});

test("app_stored_dirs names config, data and cache, in that order", { skip: !linux }, () => {
  const conf = tauriConf("com.example.two");
  const out = sh(`app_stored_dirs "${conf}"`, {
    XDG_CONFIG_HOME: "/c",
    XDG_DATA_HOME: "/d",
    XDG_CACHE_HOME: "/k",
  });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n"), ["/c/com.example.two", "/d/com.example.two", "/k/com.example.two"]);
});

test("app_stored_dirs refuses a config with no identifier", () => {
  const out = sh(`app_stored_dirs "${tauriConf(null)}"`);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /no identifier in/);
  assert.equal(out.stdout, "", "nothing a caller could go on to delete");
});

test("remove_stored_dirs removes what exists, reports what does not, skips blanks", () => {
  const present = join(SCRATCH, "stored", "present");
  const absent = join(SCRATCH, "stored", "absent");
  mkdirSync(join(present, "deep"), { recursive: true });
  writeFileSync(join(present, "deep", "file"), "x");
  const out = sh(`printf '%s\\n\\n%s\\n' "${present}" "${absent}" | remove_stored_dirs`);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!existsSync(present));
  assert.equal(out.stdout, `    removed ${present}\n    nothing stored yet (${absent})\n`);
});

test("a reset through app_stored_dirs stops before deleting anything when the identifier is missing", () => {
  const keep = join(SCRATCH, "home", ".config", "undefined");
  mkdirSync(keep, { recursive: true });
  const out = sh(`app_stored_dirs "${tauriConf(null)}" | remove_stored_dirs`);
  assert.notEqual(out.status, 0, "pipefail carries the refusal out");
  assert.ok(existsSync(keep));
});

// ── dev runners ─────────────────────────────────────────────────────────────

test("dev_parse_args sets the three flags", () => {
  const show = 'echo "$WEB $RESET $RESET_ONLY"';
  assert.equal(sh(`dev_parse_args; ${show}`).stdout.trim(), "0 0 0");
  assert.equal(sh(`dev_parse_args --web; ${show}`).stdout.trim(), "1 0 0");
  assert.equal(sh(`dev_parse_args --reset --web; ${show}`).stdout.trim(), "1 1 0");
  assert.equal(sh(`dev_parse_args --reset-only; ${show}`).stdout.trim(), "0 1 1");
});

test("dev_parse_args refuses an unknown option with status 2", () => {
  const out = sh(`dev_parse_args --wbe; echo reached`);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /unknown option: --wbe/);
  assert.doesNotMatch(out.stdout, /reached/);
});

test("dev_parse_args --help prints the calling script's usage header", () => {
  const runner = join(SCRATCH, "run_dev.sh");
  writeFileSync(
    runner,
    `#!/usr/bin/env bash
#
# Run Example in development.
#
#   ./run_dev.sh --web   browser only
#
#
#
#
# (line 10, not usage)
. "${SCRIPTS}/lib.sh"
dev_parse_args "$@"
echo "not reached"
`,
  );
  const out = spawnSync("bash", [runner, "--help"], { encoding: "utf8" });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^\nRun Example in development\.\n\n {2}\.\/run_dev\.sh --web {3}browser only\n/);
  assert.doesNotMatch(out.stdout, /line 10|not reached/);
});

test("vite_port reads the port the app's vite.config.ts serves on", () => {
  for (const app of ["vesper", "morion", "irena"]) {
    const config = join(SCRIPTS, "..", "apps", app, "vite.config.ts");
    const port = sh(`vite_port "${config}"`).stdout.trim();
    assert.match(port, /^14[234]0$/, `${app}: got "${port}"`);
  }
  writeFileSync(join(SCRATCH, "vite.config.ts"), "export default { server: tauriDevServer({ port: 5555 }) };\n");
  assert.equal(sh("vite_port").stdout.trim(), "5555", "defaults to ./vite.config.ts");
});

// ── snap ────────────────────────────────────────────────────────────────────

test("scrub_snap_env does nothing outside a snap", () => {
  const out = sh('scrub_snap_env; echo "$IN_SNAP $LD_LIBRARY_PATH"', { LD_LIBRARY_PATH: "/snap/x/lib:/usr/lib" });
  assert.equal(out.stdout.trim(), "0 /snap/x/lib:/usr/lib");
});

test("scrub_snap_env restores saved variables and drops snap paths", () => {
  const out = sh(
    `scrub_snap_env
echo "in=$IN_SNAP"
echo "ld=$LD_LIBRARY_PATH"
echo "gtk=\${GTK_PATH-unset}"
echo "data=\${XDG_DATA_HOME-unset}"
echo "dirs=$XDG_DATA_DIRS"
echo "cfg=\${XDG_CONFIG_HOME-unset}"`,
    {
      SNAP: "/snap/code/1",
      LD_LIBRARY_PATH: "/snap/code/1/usr/lib:/usr/local/lib::/snap/core/lib",
      GTK_PATH: "/snap/code/1/gtk",
      XDG_DATA_HOME: "/home/u/snap/code/1/.local/share",
      XDG_DATA_DIRS: "/snap/code/1/share",
      XDG_DATA_DIRS_VSCODE_SNAP_ORIG: "/usr/share:/usr/local/share",
      XDG_CONFIG_HOME: "/snapped",
      XDG_CONFIG_HOME_VSCODE_SNAP_ORIG: "",
    },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split("\n"), [
    "in=1",
    "ld=/usr/local/lib",
    "gtk=unset",
    "data=unset",
    "dirs=/usr/share:/usr/local/share",
    "cfg=unset",
  ]);
});

// ── the test runner ─────────────────────────────────────────────────────────

const STEPS = `
tests_step a "first"  'echo one'
tests_step b "second" 'echo two; exit 3'
tests_step a "third"  'echo three'
`;

test("tests_main runs every step, even after one fails, and fails overall", () => {
  const out = sh(`${STEPS}\ntests_main`);
  assert.equal(out.status, 1);
  for (const line of ["one", "two", "three"]) assert.match(out.stdout, new RegExp(`^${line}$`, "m"));
  assert.match(out.stdout, /1 of 3 steps failed/);
  assert.ok(existsSync(join(SCRATCH, "test-results", "tests", "02-b.log")));
});

test("tests_main runs only the groups named", () => {
  const out = sh(`${STEPS}\ntests_main a`);
  assert.equal(out.status, 0, out.stdout);
  assert.doesNotMatch(out.stdout, /^two$/m);
  assert.match(out.stdout, /all 2 steps passed/);
});

test("tests_main refuses a group that does not exist rather than run nothing", () => {
  const out = sh(`${STEPS}\ntests_main c`);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /no group 'c' \(have: a b \)/);
});

test("tests_answered handles --list and --help without running anything", () => {
  const list = sh(`${STEPS}\ntests_answered --list && echo answered`);
  assert.match(list.stdout, /^a {8}first\n {9}echo one$/m);
  assert.match(list.stdout, /answered/);
  assert.doesNotMatch(list.stdout, /^one$/m);
  assert.match(sh(`tests_answered -h && echo answered`).stdout, /Run this repo's full test suite[\s\S]*answered/);
  assert.equal(sh(`tests_answered b && echo answered || echo carry-on`).stdout.trim(), "carry-on");
});
