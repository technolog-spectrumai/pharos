// Inert stand-in for cytoscape under jsdom (no canvas, no layout engine).
// Component tests only need mount/teardown and event wiring to hold together;
// everything with real logic (collapse sets, element building, validation)
// lives in pure modules tested without cytoscape at all.
//
// The element map is just deep enough for MindGraph's patching calls: elements
// are stored by id, collections support the handful of traversals the canvas
// uses, and `emit` lets a test fire cytoscape events by hand.

type Handler = (evt: StubEvent) => void;

interface StubEvent {
  target: unknown;
  position: { x: number; y: number };
  originalEvent?: Event;
}

interface ElementDef {
  group?: "nodes" | "edges";
  data: Record<string, unknown>;
  position?: { x: number; y: number };
  classes?: string;
  grabbable?: boolean;
  selectable?: boolean;
}

class StubElement {
  core: StubCore;
  _data: Record<string, unknown>;
  _position: { x: number; y: number };
  _classes: Set<string>;
  _selected = false;
  removed = false;

  constructor(core: StubCore, def: ElementDef) {
    this.core = core;
    this._data = { ...def.data };
    this._position = def.position ? { ...def.position } : { x: 0, y: 0 };
    this._classes = new Set((def.classes ?? "").split(/\s+/).filter(Boolean));
  }

  id() {
    return String(this._data.id);
  }
  isNode() {
    return !("source" in this._data);
  }
  isEdge() {
    return "source" in this._data;
  }
  data(k?: string | Record<string, unknown>, v?: unknown) {
    if (k === undefined) return this._data;
    if (typeof k === "object") {
      Object.assign(this._data, k);
      return this;
    }
    if (v === undefined) return this._data[k];
    this._data[k] = v;
    return this;
  }
  position(p?: { x: number; y: number }) {
    if (!p) return { ...this._position };
    this._position = { ...p };
    return this;
  }
  addClass(c: string) {
    for (const x of c.split(/\s+/)) if (x) this._classes.add(x);
    return this;
  }
  removeClass(c: string) {
    for (const x of c.split(/\s+/)) this._classes.delete(x);
    return this;
  }
  toggleClass(c: string, on?: boolean) {
    const want = on ?? !this._classes.has(c);
    return want ? this.addClass(c) : this.removeClass(c);
  }
  hasClass(c: string) {
    return this._classes.has(c);
  }
  select() {
    this._selected = true;
    this.core.emit("select", this);
    return this;
  }
  unselect() {
    this._selected = false;
    this.core.emit("unselect", this);
    return this;
  }
  selected() {
    return this._selected;
  }
  remove() {
    this.removed = true;
    this.core.els.delete(this.id());
    return this;
  }
  /** Mirrors the real replace semantics: the old element is removed and a new
   *  one (same id, moved endpoint) takes its place. */
  move(loc: { source?: string; target?: string }) {
    const def: ElementDef = {
      data: { ...this._data, ...(loc.source ? { source: loc.source } : {}), ...(loc.target ? { target: loc.target } : {}) },
      position: this._position,
      classes: [...this._classes].join(" "),
    };
    this.remove();
    return this.core.addOne(def);
  }
  source() {
    return this.core.getElementById(String(this._data.source));
  }
  target() {
    return this.core.getElementById(String(this._data.target));
  }
  connectedEdges() {
    return new StubCollection(
      this.core,
      [...this.core.els.values()].filter((e) => e.isEdge() && (e._data.source === this.id() || e._data.target === this.id())),
    );
  }
  outgoers() {
    const out = [...this.core.els.values()].filter((e) => e.isEdge() && e._data.source === this.id());
    const nodes = out.map((e) => e.target()).filter((n): n is StubElement => n instanceof StubElement);
    return new StubCollection(this.core, [...out, ...nodes]);
  }
  renderedBoundingBox() {
    return { x1: 0, y1: 0, x2: 0, y2: 0, w: 0, h: 0 };
  }
  renderedSourceEndpoint() {
    return { x: 0, y: 0 };
  }
  renderedTargetEndpoint() {
    return { x: 0, y: 0 };
  }
  empty() {
    return false;
  }
  length = 1;
}

class StubCollection {
  core: StubCore;
  items: StubElement[];
  constructor(core: StubCore, items: StubElement[]) {
    this.core = core;
    this.items = items;
  }
  get length() {
    return this.items.length;
  }
  empty() {
    return this.items.length === 0;
  }
  forEach(fn: (el: StubElement, i: number) => void) {
    this.items.forEach(fn);
    return this;
  }
  map<T>(fn: (el: StubElement, i: number) => T): T[] {
    return this.items.map(fn);
  }
  filter(fn: (el: StubElement) => boolean) {
    return new StubCollection(this.core, this.items.filter(fn));
  }
  addClass(c: string) {
    this.items.forEach((el) => el.addClass(c));
    return this;
  }
  removeClass(c: string) {
    this.items.forEach((el) => el.removeClass(c));
    return this;
  }
  remove() {
    this.items.forEach((el) => el.remove());
    return this;
  }
  unselect() {
    this.items.forEach((el) => el.unselect());
    return this;
  }
  union(other: StubCollection) {
    return new StubCollection(this.core, [...this.items, ...other.items]);
  }
  positions(fn: (el: StubElement) => { x: number; y: number }) {
    this.items.forEach((el) => el.position(fn(el)));
    return this;
  }
  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
  }
}

class StubCore {
  els = new Map<string, StubElement>();
  handlers: { event: string; selector: string | null; fn: Handler }[] = [];
  _zoom = 1;
  _pan = { x: 0, y: 0 };
  destroyed = false;
  container: HTMLElement | null;
  opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown> = {}) {
    this.opts = opts;
    this.container = (opts.container as HTMLElement) ?? null;
    const elements = (opts.elements as ElementDef[]) ?? [];
    for (const def of elements) this.addOne(def);
  }

  addOne(def: ElementDef): StubElement {
    const el = new StubElement(this, def);
    this.els.set(el.id(), el);
    return el;
  }

  add(defs: ElementDef | ElementDef[]) {
    const list = Array.isArray(defs) ? defs : [defs];
    return new StubCollection(this, list.map((d) => this.addOne(d)));
  }

  remove(sel: StubElement | StubCollection) {
    sel.remove();
    return sel;
  }

  getElementById(id: string) {
    return this.els.get(id) ?? emptySingleton(this);
  }

  nodes(selector?: string) {
    return this.collect((el) => el.isNode(), selector);
  }
  edges(selector?: string) {
    return this.collect((el) => el.isEdge(), selector);
  }
  elements() {
    return new StubCollection(this, [...this.els.values()]);
  }
  $(selector?: string) {
    return this.collect(() => true, selector);
  }
  filter(fn: (el: StubElement) => boolean) {
    return new StubCollection(this, [...this.els.values()].filter(fn));
  }
  collection(items: StubElement[] = []) {
    return new StubCollection(this, items);
  }

  /** Selector support is deliberately tiny: `.class`, `:selected`, `node`, `edge`. */
  private collect(base: (el: StubElement) => boolean, selector?: string) {
    let items = [...this.els.values()].filter(base);
    if (selector) {
      for (const part of selector.split(/(?=[.:])/)) {
        if (part.startsWith(".")) items = items.filter((el) => el.hasClass(part.slice(1)));
        else if (part === ":selected") items = items.filter((el) => el.selected());
        else if (part === ":visible") items = items.filter((el) => !el.hasClass("hidden-collapsed"));
        else if (part === "node") items = items.filter((el) => el.isNode());
        else if (part === "edge") items = items.filter((el) => el.isEdge());
      }
    }
    return new StubCollection(this, items);
  }

  on(event: string, a: string | Handler, b?: Handler) {
    const selector = typeof a === "string" ? a : null;
    const fn = typeof a === "function" ? a : b!;
    for (const ev of event.split(/\s+/)) this.handlers.push({ event: ev, selector, fn });
    return this;
  }
  off() {
    this.handlers = [];
    return this;
  }
  one(event: string, a: string | Handler, b?: Handler) {
    return this.on(event, a as never, b as never);
  }

  /** Test seam: fire an event as cytoscape would. Selector matching is by
   *  element kind + class only — enough for the canvas wiring. */
  emit(event: string, target?: StubElement | StubCore | null, position = { x: 0, y: 0 }) {
    const tgt = target ?? this;
    for (const h of [...this.handlers]) {
      if (h.event !== event) continue;
      if (h.selector) {
        if (!(tgt instanceof StubElement)) continue;
        const parts = h.selector.split(",").map((s) => s.trim());
        const matches = parts.some((p) => {
          if (p === "node") return tgt.isNode();
          if (p === "edge") return tgt.isEdge();
          if (p.startsWith(".")) return tgt.hasClass(p.slice(1));
          if (p === "node, edge") return true;
          return false;
        });
        if (!matches) continue;
      }
      h.fn({ target: tgt, position });
    }
  }

  style(_sheet?: unknown) {
    return { update() {}, fromJson: () => ({ update() {} }) };
  }
  layout(_opts?: unknown) {
    return { run() {} };
  }
  batch(fn: () => void) {
    fn();
  }
  startBatch() {
    return this;
  }
  endBatch() {
    return this;
  }
  fit() {
    return this;
  }
  center() {
    return this;
  }
  resize() {
    return this;
  }
  zoom(z?: number) {
    if (z === undefined) return this._zoom;
    this._zoom = z;
    return this;
  }
  pan(p?: { x: number; y: number }) {
    if (p === undefined) return { ...this._pan };
    this._pan = { ...p };
    return this;
  }
  viewport(v: { zoom: number; pan: { x: number; y: number } }) {
    this._zoom = v.zoom;
    this._pan = { ...v.pan };
    return this;
  }
  extent() {
    return { x1: 0, y1: 0, x2: 1000, y2: 600, w: 1000, h: 600 };
  }
  autoungrabify(_v?: boolean) {
    return this;
  }
  autounselectify(_v?: boolean) {
    return this;
  }
  userPanningEnabled(_v?: boolean) {
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.els.clear();
    this.handlers = [];
  }
}

/** getElementById on a missing id returns an empty singleton in cytoscape. */
function emptySingleton(core: StubCore) {
  const c = new StubCollection(core, []) as StubCollection & { id: () => undefined };
  c.id = () => undefined;
  return c as unknown as StubElement;
}

export default function cytoscape(opts?: Record<string, unknown>) {
  return new StubCore(opts ?? {});
}

export type { StubCore, StubElement };
