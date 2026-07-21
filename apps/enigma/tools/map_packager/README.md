# Enigma Map Packager

A standalone **PyQt6** desktop tool that produces offline map **region
packages** for the Enigma app. The app itself never talks to tile servers
(see `enigma/map.md` Part II) — this tool does, on a machine you choose, and
the app only ever **imports files**.

A package is two files, side by side:

```
<name>.pmtiles          # bbox/zoom subset extracted from a PMTiles archive
<name>.manifest.json    # BLAKE3 manifest — the app verifies both on import
```

## Install & run

```bash
python -m venv venv && . venv/bin/activate   # optional but recommended
pip install -r requirements.txt              # PyQt6, pmtiles, requests, blake3
python main.py
```

## Workflow

1. **Source URL** — any `.pmtiles` archive reachable over HTTP with Range
   support (e.g. a [Protomaps build](https://protomaps.com/) you host or
   downloaded location). *Check source* fetches only the header (a few KB) and
   shows its zoom range.
2. **Area** — type W/S/E/N degrees directly, or use *Find area* (Nominatim
   town lookup — one explicit request per click, editable endpoint for
   self-hosting) to fill the box.
3. **Zoom levels + name**, then **Package region**. Progress, cancel, and a
   log with the output paths. The *Coarse world (z0–5)* preset makes a small
   whole-planet base layer worth importing alongside detailed regions.
4. Copy **both files** to the device (USB, your own Enigma Cloud via the
   Files tab, any channel you trust) and import the `.pmtiles` in
   **Enigma → Map → Regions → Import** — the manifest sidecar is auto-detected
   by filename and the app re-verifies BLAKE3 + every field itself.

## Command-line downloads (no GUI)

Ready-made one-command scripts live alongside the tool — they bootstrap a
`.venv` on first run (from `requirements.txt`), download from the latest
Protomaps daily build, and show a `tqdm` progress bar. Output defaults to
`~/enigma-maps`; pass a folder to override.

```bash
./download_warsaw.sh            # Warsaw + immediate surroundings
./download_gdansk.sh            # Gdańsk + region (Tricity, delta, near lakes)
./download_gdansk.sh /media/usb # …to a chosen folder
```

For any other area, drive the shared CLI directly:

```bash
python download_map.py --name "Kraków" --bbox 19.8,50.0,20.2,50.15 \
    --min-zoom 0 --max-zoom 14 --out ~/enigma-maps
```

These produce **Protomaps-schema** packages, which is what the app's bundled
style renders — a `.pmtiles` in another schema (e.g. Shortbread) imports fine
but paints blank. Copy both output files to the device and import the
`.pmtiles` in Enigma → Map → Regions.

## Notes

- Extraction copies stored tile bytes (no recompression); the output archive
  keeps the source's tile type/compression and carries `vector_layers`
  metadata over, so any PMTiles tooling can inspect it.
- Missing tiles in the source (pruned ocean, etc.) are skipped and counted.
- A soft cap of 200k tiles per package guards against accidental
  planet-at-z14 runs; shrink the area or zoom range instead of raising it.
- Tests: `python -m pytest tests/` (pure tile math, manifest matrix mirrored
  from the app's `maps.rs`, extraction round-trips over file + HTTP-range
  sources, cancellation).

## Module map

| File | Role |
|---|---|
| `main.py` / `window.py` / `theme.py` | App entry, main window, QSS theme (video_tools conventions) |
| `packager.py` | The Package tab + QThread workers (source check, lookup, extract) |
| `pm_source.py` | `get_bytes` sources (file / HTTP-Range / LRU cache) + `extract()` |
| `tile_math.py` | Web-Mercator bbox↔tile math — mirrors the app's `maps.rs` |
| `manifest.py` | `MapRegionManifest` wire shape + validation + BLAKE3 — mirrors `maps.rs` |
| `geocode.py` | Nominatim jsonv2 town→bbox lookup (honest UA, editable endpoint) |
| `download_map.py` | CLI: extract a bbox/zoom package from a source (tqdm progress) |
| `download_warsaw.sh` / `download_gdansk.sh` | One-command wrappers over `download_map.py` |
