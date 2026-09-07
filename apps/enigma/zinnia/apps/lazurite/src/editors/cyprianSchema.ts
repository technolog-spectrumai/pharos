// Cyprian's TipTap schema, ported from
// portal/vendor/toto_libs/packages/toto-works/src/toto/cyprian/static/cyprian/tiptap_setup.js
//
// This file is a FIDELITY contract, not a design. Every mark and node here
// exists because cyprian's sanitiser allows exactly this markup and no more: a
// schema that knows less silently deletes formatting on the first save, and one
// that emits more has it stripped server-side, which looks the same to the user
// and is just as lossy. When in doubt, match the Python allowlist
// (cyprian/sanitize_html.py), not what TipTap makes convenient.
//
// Colour and size are CLASSES, not inline styles, because the server strips
// `style=` attributes — that is why cyprian has cy-ink-* / cy-size-* at all.
import { Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";

export const INKS = ["accent", "success", "warn"] as const;
export const SIZES = ["sm", "lg"] as const;

/** One mark, one class, one attribute — used for both ink and size. */
function classMark(name: string, attribute: string, values: readonly string[], prefix: string) {
  return Mark.create({
    name,
    addAttributes() {
      return {
        [attribute]: {
          default: null,
          parseHTML: (element: HTMLElement) =>
            values.find((v) => element.classList.contains(prefix + v)) || null,
          renderHTML: (attrs: Record<string, unknown>) => {
            const value = attrs[attribute];
            return value ? { class: prefix + value } : {};
          },
        },
      };
    },
    parseHTML() {
      return [{
        tag: "span",
        getAttrs: (element: HTMLElement) =>
          values.some((v) => element.classList.contains(prefix + v)) && null,
      }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["span", mergeAttributes(HTMLAttributes), 0];
    },
    addCommands() {
      const cap = name[0].toUpperCase() + name.slice(1);
      return {
        [`set${cap}`]: (value: string) => ({ commands }: never) =>
          values.indexOf(value) === -1
            ? (commands as never as { unsetMark(n: string): boolean }).unsetMark(name)
            : (commands as never as { setMark(n: string, a: object): boolean })
                .setMark(name, { [attribute]: value }),
        [`unset${cap}`]: () => ({ commands }: never) =>
          (commands as never as { unsetMark(n: string): boolean }).unsetMark(name),
      } as never;
    },
  });
}

export const CyInk = classMark("cyInk", "ink", INKS, "cy-ink-");
export const CySize = classMark("cySize", "size", SIZES, "cy-size-");

function escapeText(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** A formula. The LaTeX lives in `data-latex`; the KaTeX rendering lives in the
 *  node's HTML so the PDF has something to show — WeasyPrint runs no JavaScript.
 *  `atom: true` because the rendered markup is not editable text: you edit the
 *  source in the dialog. */
export const Formula = Node.create({
  name: "formula",
  group: "block",
  atom: true,
  draggable: false,
  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-latex") || "",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-latex": attrs.latex || "" }),
      },
      rendered: {
        default: "",
        // The cached KaTeX output. Carried through so a document opened and
        // saved without touching the formula keeps its rendering — the server
        // and the PDF both depend on it being there.
        parseHTML: (element: HTMLElement) => element.innerHTML || "",
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div.cy-formula" }];
  },
  renderHTML({ node }) {
    // Raw HTML, so it cannot go through renderHTML's array form.
    const dom = document.createElement("div");
    dom.className = "cy-formula";
    dom.setAttribute("data-latex", String(node.attrs.latex || ""));
    dom.innerHTML = String(node.attrs.rendered || "")
      || `<code class="cy-formula-source">${escapeText(String(node.attrs.latex || ""))}</code>`;
    return { dom };
  },
});

/** A callout: a note, a warning, an aside. Ordinary block content inside, so it
 *  is editable in place — unlike a formula, a callout is just prose in a box. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      tone: {
        default: "note",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-tone") || "note",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-tone": attrs.tone || "note" }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div.cy-callout" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "cy-callout" }), 0];
  },
});

/** A page break. Nothing to edit; the PDF gets `break-after: page`. */
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  parseHTML() {
    return [{ tag: "div.cy-pagebreak" }];
  },
  renderHTML() {
    return ["div", { class: "cy-pagebreak" }];
  },
});

/** Highlight, as the class the server allows rather than a style attribute. */
export const CyHighlight = Extension.create({ name: "cyHighlight" });

export interface SchemaOptions {
  placeholder?: string;
}

/** The extension list cyprian's editor runs with. Kept as one exported array so
 *  the editor component and the schema tests cannot drift apart. */
export function cyprianExtensions(opts: SchemaOptions = {}) {
  return [
    StarterKit.configure({
      // Cyprian's heading levels are 1-3 — the outline and the contents page
      // both assume it, and the sanitiser drops h4+.
      heading: { levels: [1, 2, 3] },
    }),
    Underline,
    Link.configure({ openOnClick: false, autolink: false }),
    Image.configure({ inline: false, allowBase64: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    CyInk,
    CySize,
    Formula,
    Callout,
    PageBreak,
    Placeholder.configure({ placeholder: opts.placeholder ?? "" }),
  ];
}
