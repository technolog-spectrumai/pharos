#!/usr/bin/env python3
"""Download an Enigma map region package for a bbox from a PMTiles source.

Thin CLI over tools/map_packager: extracts the tiles covering a bbox/zoom
range out of a remote `.pmtiles` archive (HTTP range requests) and writes an
Enigma-ready package — `<name>.pmtiles` + `<name>.manifest.json` — that the
app's Map → Regions → Import verifies (BLAKE3 + manifest) and renders.

The default source is the latest Protomaps daily planet build, so the output
uses the **Protomaps** vector schema the app's bundled style expects. (A file
in a different schema — e.g. Shortbread — imports fine but paints blank,
because the style's layers reference different source-layers.)

Used by the ready-made download_warsaw.sh / download_gdansk.sh in this folder;
run directly for any other area:

    python tools/map_packager/download_map.py --name "Kraków" --bbox 19.8,50.0,20.2,50.15
"""
from __future__ import annotations

import argparse
import datetime
import sys
from pathlib import Path

from tqdm import tqdm

# The packager modules are siblings of this file (single source of truth for
# tile math, extraction, and the manifest shape the Rust importer re-verifies).
# Running `python .../download_map.py` already puts this dir on sys.path[0];
# the explicit insert keeps it working when imported by other means.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from manifest import build_manifest, write_sidecar  # noqa: E402
from pm_source import CachingSource, HttpRangeSource, extract, source_info  # noqa: E402
from tile_math import bbox_tile_count, validate_bbox  # noqa: E402
from utils import human_bytes, safe_filename  # noqa: E402

PROTOMAPS_BUILD = "https://build.protomaps.com/{day}.pmtiles"


def resolve_latest_protomaps(days_back: int = 8) -> str:
    """First reachable recent Protomaps daily build (they rotate/expire)."""
    today = datetime.date.today()
    last_err = "no candidates tried"
    for d in range(days_back):
        day = (today - datetime.timedelta(days=d)).strftime("%Y%m%d")
        url = PROTOMAPS_BUILD.format(day=day)
        try:
            source_info(HttpRangeSource(url, timeout=20))
            return url
        except Exception as exc:  # noqa: BLE001 — keep trying older days
            last_err = f"{day}: {exc}"
    raise SystemExit(
        f"No reachable Protomaps daily build in the last {days_back} days "
        f"(last error {last_err}). Pass --source with your own .pmtiles URL."
    )


def parse_bbox(s: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in s.split(",")]
    if len(parts) != 4:
        raise SystemExit("--bbox must be 'west,south,east,north' (degrees)")
    bbox = tuple(float(p) for p in parts)  # type: ignore[assignment]
    if not validate_bbox(bbox):
        raise SystemExit(f"invalid bbox {bbox}: need west<east, south<north, in range")
    return bbox


def main() -> int:
    ap = argparse.ArgumentParser(description="Download an Enigma map region package.")
    ap.add_argument("--name", required=True, help="Region name shown in the app.")
    ap.add_argument("--bbox", required=True, help="west,south,east,north (degrees).")
    ap.add_argument("--min-zoom", type=int, default=0)
    ap.add_argument("--max-zoom", type=int, default=14)
    ap.add_argument(
        "--source",
        default="",
        help="PMTiles archive URL (default: latest Protomaps daily build).",
    )
    ap.add_argument(
        "--out",
        default=str(Path.home() / "enigma-maps"),
        help="Output folder (created if missing).",
    )
    args = ap.parse_args()

    bbox = parse_bbox(args.bbox)
    if args.min_zoom > args.max_zoom:
        raise SystemExit("--min-zoom must be <= --max-zoom")

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    source = args.source or resolve_latest_protomaps()
    print(f"Source : {source}")
    header = source_info(HttpRangeSource(source, timeout=30))
    src_min, src_max = header["min_zoom"], header["max_zoom"]
    max_zoom = min(args.max_zoom, src_max)
    min_zoom = max(args.min_zoom, src_min)
    tiles = bbox_tile_count(bbox, min_zoom, max_zoom)
    print(f"Area   : {bbox}  z{min_zoom}-z{max_zoom}  (~{tiles:,} tiles)")

    archive = out_dir / f"{safe_filename(args.name)}.pmtiles"
    reads = CachingSource(HttpRangeSource(source, timeout=30))

    # extract() calls progress(done, total) once per tile; drive tqdm by the
    # delta. Created lazily on the first tick so total always matches extract's
    # own count. `disable=None` auto-silences the bar when stdout is redirected
    # (a log file), so piped runs stay clean.
    bar = tqdm(total=tiles, unit="tile", desc="Extracting", disable=None)

    def on_progress(done: int, _total: int) -> None:
        bar.update(done - bar.n)

    try:
        stats = extract(
            reads, archive, bbox, min_zoom, max_zoom,
            progress=on_progress, metadata_name=args.name,
        )
    except KeyboardInterrupt:
        bar.close()
        archive.unlink(missing_ok=True)
        print("Cancelled — partial file removed.")
        return 130
    bar.close()

    manifest = build_manifest(archive, args.name, bbox, min_zoom, max_zoom, source)
    sidecar = write_sidecar(archive, manifest)
    size = archive.stat().st_size
    print(
        f"Done   : {stats['tiles']:,} tiles "
        f"({stats['skipped']:,} empty skipped), {human_bytes(size)}"
    )
    print(f"  → {archive}")
    print(f"  → {sidecar}")
    print("Copy BOTH files to the device, then Enigma → Map → Regions → Import "
          "the .pmtiles (the manifest is picked up automatically).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
