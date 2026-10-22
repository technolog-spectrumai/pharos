// One-time ACE wiring for the local notes editor, kept fully offline.
//
// Modes and themes are imported statically so the bundler emits them with the app
// (each self-registers with ACE on import). The syntax-check workers can't be
// imported that way — ACE loads them at runtime — so we hand it a bundled asset URL
// for each one. Without this it would fall back to fetching them from a CDN, which
// this app never does. Only the modes listed here are bundled; ace-builds ships far
// more, and importing them all would add ~18 MB.
// The package root, not the src-noconflict/ace subpath. Both bundle correctly, but
// the subpath's CommonJS interop hands back a partial object (no config.setModuleUrl)
// outside a full browser build, which makes this module throw on import under vitest.
import ace from "ace-builds";

import "ace-builds/src-noconflict/mode-plain_text";
import "ace-builds/src-noconflict/mode-markdown";
import "ace-builds/src-noconflict/mode-json";
import "ace-builds/src-noconflict/mode-yaml";
import "ace-builds/src-noconflict/mode-toml";
import "ace-builds/src-noconflict/mode-ini";
import "ace-builds/src-noconflict/mode-xml";
import "ace-builds/src-noconflict/mode-javascript";
import "ace-builds/src-noconflict/mode-typescript";
import "ace-builds/src-noconflict/mode-python";
import "ace-builds/src-noconflict/mode-rust";
import "ace-builds/src-noconflict/mode-sh";
import "ace-builds/src-noconflict/mode-html";
import "ace-builds/src-noconflict/mode-css";

import "ace-builds/src-noconflict/theme-github";
import "ace-builds/src-noconflict/theme-github_dark";

import "ace-builds/src-noconflict/ext-searchbox"; // Ctrl+F inside the editor

import workerJsonUrl from "ace-builds/src-noconflict/worker-json.js?url";
import workerJavascriptUrl from "ace-builds/src-noconflict/worker-javascript.js?url";
import workerCssUrl from "ace-builds/src-noconflict/worker-css.js?url";
import workerHtmlUrl from "ace-builds/src-noconflict/worker-html.js?url";
import workerXmlUrl from "ace-builds/src-noconflict/worker-xml.js?url";
import workerYamlUrl from "ace-builds/src-noconflict/worker-yaml.js?url";

// Only these six modes have a worker upstream; toml/ini/python/rust/sh/plain_text
// and markdown have none, so they simply never ask for one.
ace.config.setModuleUrl("ace/mode/json_worker", workerJsonUrl);
ace.config.setModuleUrl("ace/mode/javascript_worker", workerJavascriptUrl); // also serves typescript
ace.config.setModuleUrl("ace/mode/css_worker", workerCssUrl);
ace.config.setModuleUrl("ace/mode/html_worker", workerHtmlUrl);
ace.config.setModuleUrl("ace/mode/xml_worker", workerXmlUrl);
ace.config.setModuleUrl("ace/mode/yaml_worker", workerYamlUrl);

export const THEME_LIGHT = "ace/theme/github";
export const THEME_DARK = "ace/theme/github_dark";

const EXT_TO_MODE: Record<string, string> = {
  txt: "plain_text",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  xml: "xml",
  svg: "xml",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rs: "rust",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  html: "html",
  htm: "html",
  css: "css",
};

/** Pick a highlighting mode from a file name; anything unrecognized stays plain text. */
export function modeForFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return `ace/mode/${EXT_TO_MODE[ext] ?? "plain_text"}`;
}

export default ace;
