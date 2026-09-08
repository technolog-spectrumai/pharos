# wisteria

The drawing engine: the shape model, the SVG codec, the canvas, the toolbar and
the PNG export. One copy, two consumers.

It exists because there were **two** — enigma's `components/sketch/` and
Zinnia's `apps/sketch/src/sketch/` — forked when Sketch left enigma and drifted
apart while both were still edited. Zinnia's was ahead on every shared file
(rotation, arrow heads, the picker UI, a `line` that stays a line), and
enigma's carried a bug the divergence had hidden: a plain line grew an
arrowhead the first time the file was saved, so a triangle drawn from three
lines came back as three arrows, permanently.

## What is injected, and why

Two things differ per app and are therefore parameters, not imports:

* **writing a file.** Enigma has no `@tauri-apps/plugin-fs`; it writes through
  its own `fs_write_base64_file` command. Zinnia has the plugin and no such
  command. `exportPng` takes a `WriteFile` rather than picking one — the same
  move `petalite/files` makes with its injected seal probe.
* **the palette.** `petalite/theme` owns the system colours; a consumer that
  wants different ones passes them.

Nothing here imports a store, a router or an app. The rule is petalite's:
a package that owns a feature owns the strings that feature shows, and nothing
else.
