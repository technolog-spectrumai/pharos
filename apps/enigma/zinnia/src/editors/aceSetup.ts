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
import "ace-builds/src-noconflict/mode-latex";
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

// Only these six modes have a worker upstream; toml/ini/python/rust/sh/latex/
// plain_text and markdown have none, so they simply never ask for one.
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
  pxml: "xml",
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
  // A .sty is a LaTeX package and a .tex is a document; one mode reads both.
  tex: "latex",
  sty: "latex",
};

/** Pick a highlighting mode from a file name; anything unrecognized stays plain text. */
export function modeForFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return `ace/mode/${EXT_TO_MODE[ext] ?? "plain_text"}`;
}

/** A language the Code tab offers by name. */
export interface CodeLanguage {
  id: string;
  /** The bare mode name; the session takes `ace/mode/${mode}`. */
  mode: string;
  /** Shown in the picker. A proper noun, so it is NOT translated — "Python" is
   *  Python in every locale. The one exception is plain text, whose label is
   *  empty here and supplied by the picker through SelectMenu's `emptyLabel`,
   *  because "Plain text" is a phrase and does translate. */
  label: string;
}

/**
 * What the language picker offers.
 *
 * A SUBSET of what is bundled, not a mirror of it: `EXT_TO_MODE` above covers
 * 26 extensions because detection should recognise everything the app can
 * highlight, while this list is what a person is asked to choose from — and a
 * dropdown of every mode ACE ships is a worse dropdown. A file whose detected
 * mode is not on this list (a `.rs`, say) still gets its real highlighting; it
 * is only the picker's label that falls back to plain text.
 *
 * Plain text first because it is the default a new file is born as; the rest
 * alphabetical, which is the only order a reader can predict.
 */
export const LANGUAGES: readonly CodeLanguage[] = [
  { id: "text", mode: "plain_text", label: "" },
  { id: "css", mode: "css", label: "CSS" },
  { id: "html", mode: "html", label: "HTML" },
  { id: "javascript", mode: "javascript", label: "JavaScript" },
  { id: "json", mode: "json", label: "JSON" },
  { id: "latex", mode: "latex", label: "LaTeX" },
  { id: "markdown", mode: "markdown", label: "Markdown" },
  { id: "python", mode: "python", label: "Python" },
  { id: "sh", mode: "sh", label: "Shell" },
  { id: "typescript", mode: "typescript", label: "TypeScript" },
  { id: "xml", mode: "xml", label: "XML" },
  { id: "yaml", mode: "yaml", label: "YAML" },
];

/** Which OFFERED language a file name detects as — what the picker should show
 *  before anyone touches it. Falls back to plain text for a mode that is
 *  bundled but not offered, which is a display fallback only: the session was
 *  already given the real mode by `modeForFilename`. */
export function languageForFilename(name: string): CodeLanguage {
  const mode = modeForFilename(name);
  return LANGUAGES.find((l) => `ace/mode/${l.mode}` === mode) ?? LANGUAGES[0];
}

export default ace;
