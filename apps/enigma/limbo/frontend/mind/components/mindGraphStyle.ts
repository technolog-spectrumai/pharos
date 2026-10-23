// Mind canvas theming. Cytoscape paints to a <canvas>, so Tailwind classes and
// CSS variables can't reach its elements — resolved colors are read from the
// style.css tokens at build time and re-read on every theme flip (the toto
// bento pattern). The tokens are mode-suffixed, so we PICK the -dark or -light
// set rather than racing the `.dark` class swap.

import type cytoscape from "cytoscape";

export interface MindPalette {
  bg: string;
  node: string;
  text: string;
  border: string;
  accent: string;
  accentText: string;
  warn: string;
  success: string;
  highlight: string;
  font: string;
}

/** Fallbacks mirror style.css so a headless/jsdom run still yields a complete
 *  stylesheet. */
const FALLBACK: Record<string, string> = {
  "--color-sunken-light": "#e1e2e5",
  "--color-sunken-dark": "#141821",
  "--color-bubble-bg-light": "#e8e9ec",
  "--color-bubble-bg-dark": "#191f2d",
  "--color-text-main-light": "#0f1114",
  "--color-text-main-dark": "#d3d7e0",
  "--color-accent-light": "#2f3d63",
  "--color-accent-dark": "#4f5fa1",
  "--color-accent-1": "#4f5fa1",
  "--color-accent-2": "#2f3d63",
  "--color-primary-bg-light": "#f2f3f5",
  "--color-primary-bg-dark": "#0a0c11",
  "--color-warn-light": "#d94a4a",
  "--color-warn-dark": "#ff4455",
  "--color-success-light": "#4a8f7a",
  "--color-success-dark": "#5fa38c",
  "--color-highlight": "#facc15",
};

export function readPalette(dark: boolean): MindPalette {
  const style = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const token = (name: string) => style?.getPropertyValue(name).trim() || FALLBACK[name] || "#888888";
  const mode = dark ? "dark" : "light";
  return {
    bg: token(`--color-sunken-${mode}`),
    node: token(`--color-bubble-bg-${mode}`),
    text: token(`--color-text-main-${mode}`),
    // Same choice the bordered panels make: accent-1 reads on dark, accent-2 on light.
    border: dark ? token("--color-accent-1") : token("--color-accent-2"),
    accent: token(`--color-accent-${mode}`),
    // Topic labels sit on an accent fill — the app pairs that with primary-bg text.
    accentText: token(`--color-primary-bg-${mode}`),
    warn: token(`--color-warn-${mode}`),
    success: token(`--color-success-${mode}`),
    highlight: token("--color-highlight"),
    font: "Orbitron, sans-serif",
  };
}

/** The full static stylesheet. No function-valued styles: dynamic bits (the
 *  ⊕ badge, visibility) ride on data fields and classes instead, so a theme
 *  flip is a single sheet swap. */
export function buildStylesheet(c: MindPalette): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        width: 160,
        height: 44,
        "background-color": c.node,
        "border-width": 1.5,
        "border-color": c.border,
        label: "data(displayLabel)",
        color: c.text,
        "font-size": 11,
        "font-family": c.font,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "ellipsis",
        "text-max-width": "140px",
      },
    },
    {
      selector: "node.topic",
      style: {
        shape: "round-hexagon",
        width: 190,
        height: 60,
        "background-color": c.accent,
        color: c.accentText,
        "font-weight": "bold",
        "font-size": 12,
        // The hexagon insets its corners; keep the ellipsis inside them.
        "text-max-width": "130px",
        "border-width": 2,
        "border-color": c.border,
      },
    },
    {
      // The collapsed ROOT stays visible — double border + the ⊕ N badge in its
      // label mark the tucked-away branch.
      selector: "node.collapsed",
      style: {
        "border-width": 4,
        "border-style": "double",
      },
    },
    {
      selector: "edge",
      style: {
        width: 2, // ≥2 keeps edges clickable
        "curve-style": "bezier", // auto-bundles an A→B / B→A pair
        "line-color": c.border,
        "target-arrow-shape": "triangle",
        "target-arrow-color": c.border,
        "arrow-scale": 1.2,
        label: "data(label)",
        "font-size": 9,
        "font-family": c.font,
        color: c.text,
        "text-rotation": "autorotate",
        "text-background-color": c.bg,
        "text-background-opacity": 1,
        "text-background-padding": "2px",
        "text-background-shape": "roundrectangle",
      },
    },
    {
      selector: "node:selected",
      style: {
        "border-width": 3,
        "border-color": c.highlight,
        "overlay-color": c.highlight,
        "overlay-opacity": 0.12,
        "overlay-padding": 4,
      },
    },
    {
      selector: "edge:selected",
      style: {
        width: 3.5,
        "line-color": c.highlight,
        "target-arrow-color": c.highlight,
      },
    },
    // ── interaction affordances ──────────────────────────────────────────────
    {
      selector: "node.connect-source",
      style: { "border-width": 3, "border-color": c.success, "border-style": "dashed" },
    },
    {
      selector: "node.connect-hover",
      style: { "overlay-color": c.success, "overlay-opacity": 0.25, "overlay-padding": 4 },
    },
    {
      selector: "node.connect-invalid",
      style: { "overlay-color": c.warn, "overlay-opacity": 0.25, "overlay-padding": 4 },
    },
    {
      // The pointer-chasing anchor of the rubber band: tiny, inert, invisible.
      selector: "node.ghost",
      style: { width: 8, height: 8, opacity: 0, events: "no", label: "" },
    },
    {
      selector: "edge.ghost-edge",
      style: {
        "line-style": "dashed",
        width: 2,
        "line-color": c.accent,
        "target-arrow-shape": "triangle",
        "target-arrow-color": c.accent,
        opacity: 0.7,
        events: "no",
        label: "",
      },
    },
    {
      // The edge being reconnected: kept faintly visible for context.
      selector: "edge.reconnect-dim",
      style: { opacity: 0.25 },
    },
    {
      selector: ".hidden-collapsed",
      style: { display: "none" },
    },
  ];
}
