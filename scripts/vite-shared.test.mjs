// node --test scripts/vite-shared.test.mjs
//
// The aliases and dev-server block every app's Vite config takes from
// vite-shared.mjs, checked as Vite would use them, and against the apps that
// use them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sourceAliases, tauriDevServer } from "./vite-shared.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// What Vite does with an alias list: the FIRST entry whose `find` matches
// wins, and only the matched part of the specifier is replaced.
function resolve(aliases, specifier) {
  for (const { find, replacement } of aliases) {
    if (find.test(specifier)) return specifier.replace(find, replacement);
  }
  return null;
}

test("resolves the entry, subpaths and components to the package source", () => {
  const aliases = sourceAliases("petalite", "/repo/packages/petalite/src");
  assert.equal(resolve(aliases, "petalite"), "/repo/packages/petalite/src/index.ts");
  assert.equal(resolve(aliases, "petalite/theme"), "/repo/packages/petalite/src/theme");
  assert.equal(resolve(aliases, "petalite/files/format"), "/repo/packages/petalite/src/files/format");
  assert.equal(resolve(aliases, "petalite/ModalPanel.vue"), "/repo/packages/petalite/src/components/ModalPanel.vue");
});

test("puts the .vue rule first, because the subpath rule would match it too", () => {
  const [first, second] = sourceAliases("wisteria", "/w/src");
  assert.ok(first.find.test("wisteria/SketchCanvas.vue"));
  assert.ok(second.find.test("wisteria/SketchCanvas.vue"), "if this stops matching, the order no longer matters");
  assert.ok(!first.find.test("wisteria/sketchModel"));
});

test("leaves other packages alone, including ones whose name starts the same", () => {
  const aliases = sourceAliases("padova", "/p/src");
  assert.equal(resolve(aliases, "padova-extra"), null);
  assert.equal(resolve(aliases, "padovax/thing"), null);
  assert.equal(resolve(aliases, "vue"), null);
  assert.equal(resolve(aliases, "@scope/padova"), null);
});

test("takes no .vue rule and another entry when asked (rakotis)", () => {
  const aliases = sourceAliases("rakotis", "/r/src", { components: false, entry: "/nm/rakotis/src/index.ts" });
  assert.equal(aliases.length, 2);
  assert.equal(resolve(aliases, "rakotis"), "/nm/rakotis/src/index.ts");
  assert.equal(resolve(aliases, "rakotis/components/Chat.vue"), "/r/src/components/Chat.vue");
});

test("matches a scoped or dotted name literally", () => {
  const aliases = sourceAliases("@irena/ui", "/i/src");
  assert.equal(resolve(aliases, "@irena/ui"), "/i/src/index.ts");
  assert.equal(resolve(aliases, "@irena/ui/Button.vue"), "/i/src/components/Button.vue");
  const dotted = sourceAliases("a.b", "/ab/src");
  assert.equal(resolve(dotted, "axb"), null);
});

test("serves on a fixed, strict port with nothing cached and src-tauri unwatched", () => {
  const server = tauriDevServer({ port: 1430, host: "" });
  assert.equal(server.port, 1430);
  assert.equal(server.strictPort, true);
  assert.equal(server.headers["Cache-Control"], "no-store");
  assert.equal(server.host, false);
  assert.equal(server.hmr, undefined);
  assert.deepEqual(server.watch.ignored, ["**/src-tauri/**"]);
});

test("opens HMR on port + 1 only for a dev host", () => {
  const server = tauriDevServer({ port: 1440, host: "192.168.1.5" });
  assert.equal(server.host, "192.168.1.5");
  assert.deepEqual(server.hmr, { protocol: "ws", host: "192.168.1.5", port: 1441 });
});

test("reads the dev host from TAURI_DEV_HOST when none is given", () => {
  const saved = process.env.TAURI_DEV_HOST;
  try {
    process.env.TAURI_DEV_HOST = "10.0.0.2";
    assert.equal(tauriDevServer({ port: 1420 }).hmr.port, 1421);
    delete process.env.TAURI_DEV_HOST;
    assert.equal(tauriDevServer({ port: 1420 }).host, false);
  } finally {
    if (saved === undefined) delete process.env.TAURI_DEV_HOST;
    else process.env.TAURI_DEV_HOST = saved;
  }
});

test("refuses a port that is not one", () => {
  for (const port of [0, -1, 65535, 1430.5, Number.NaN, "1430"]) {
    assert.throws(() => tauriDevServer({ port, host: "" }), /port must be an integer/);
  }
});

// Each app writes its port in several files (vite.config.ts, tauri.conf.json's
// devUrl and devCsp). Each app's own smoke test holds its files together; this
// one holds the apps apart — two on one port could not run side by side.
test("gives every app its own port, the one its devUrl names", () => {
  const ports = {};
  for (const app of ["vesper", "morion", "irena"]) {
    const vite = readFileSync(join(ROOT, "apps", app, "vite.config.ts"), "utf8");
    const match = vite.match(/tauriDevServer\(\{ port: (\d+) \}\)/);
    assert.ok(match, `${app}/vite.config.ts takes its server block from tauriDevServer`);
    const port = Number(match[1]);
    const conf = JSON.parse(readFileSync(join(ROOT, "apps", app, "src-tauri", "tauri.conf.json"), "utf8"));
    assert.equal(Number(new URL(conf.build.devUrl).port), port, `${app}: devUrl and vite.config.ts agree`);
    ports[app] = port;
  }
  const taken = Object.values(ports).flatMap((port) => [port, port + 1]);
  assert.equal(new Set(taken).size, taken.length, `ports and HMR ports overlap: ${JSON.stringify(ports)}`);
});
