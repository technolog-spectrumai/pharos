"""PMTiles sources + region extraction (the tool's core, UI-free).

A "source" is what `pmtiles.reader.Reader` wants: a `get_bytes(offset, length)`
callable. Three are provided — local file, HTTP with Range requests, and an
LRU-caching wrapper (the python Reader re-walks the directory tree from byte 0
for EVERY tile, so uncached remote extraction would cost 2-3 range requests per
tile; with the cache it's one request per tile + a handful for directories).

`extract()` copies the STORED tile bytes (no recompression — `Reader.get`
returns them as stored, per the step-0 spike) into a new archive whose header
carries the same tile_type/tile_compression, then the caller manifests it.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Callable, Optional

import requests
from pmtiles.reader import Reader
from pmtiles.tile import tileid_to_zxy, zxy_to_tileid
from pmtiles.writer import Writer

from tile_math import iter_bbox_tiles

GetBytes = Callable[[int, int], bytes]

# 16 KiB: header (127 B) + root directory live in the first chunk of every
# spec-conforming archive, so directory walks hit the cache immediately.
_FIRST_CHUNK = 16_384


class ExtractCancelled(Exception):
    """Raised out of extract() when the caller's cancel event fires."""


class FileSource:
    """get_bytes over a local .pmtiles file (also handy in tests)."""

    def __init__(self, path: Path) -> None:
        self._f = open(path, "rb")

    def __call__(self, offset: int, length: int) -> bytes:
        self._f.seek(offset)
        return self._f.read(length)

    def close(self) -> None:
        self._f.close()


class HttpRangeSource:
    """get_bytes over HTTP Range requests (requests.Session, honest UA).

    Transient failures (timeouts, connection resets, 5xx) are retried with
    backoff — a multi-thousand-tile extraction must survive one network hiccup
    (a real planet-build run died on exactly this). Raises RuntimeError when
    the server ignores Range (a 200 with the full planet body must never be
    silently accepted)."""

    RETRIES = 3
    BACKOFF_SECS = (1.0, 4.0, 10.0)

    def __init__(
        self,
        url: str,
        *,
        timeout: float = 30.0,
        user_agent: str = "enigma-map-packager/1.0",
        session: Optional[requests.Session] = None,
    ) -> None:
        self.url = url
        self.timeout = timeout
        self._session = session or requests.Session()
        self._session.headers["User-Agent"] = user_agent

    def __call__(self, offset: int, length: int) -> bytes:
        last_error: Exception | None = None
        for attempt in range(self.RETRIES + 1):
            if attempt > 0:
                time.sleep(self.BACKOFF_SECS[min(attempt - 1, len(self.BACKOFF_SECS) - 1)])
            try:
                resp = self._session.get(
                    self.url,
                    headers={"Range": f"bytes={offset}-{offset + length - 1}"},
                    timeout=self.timeout,
                )
            except (requests.Timeout, requests.ConnectionError) as exc:
                last_error = exc
                continue
            if resp.status_code >= 500:
                last_error = RuntimeError(f"HTTP {resp.status_code}")
                continue
            resp.raise_for_status()
            if resp.status_code != 206:
                raise RuntimeError(
                    f"server does not support Range requests (HTTP {resp.status_code})"
                )
            return resp.content
        raise RuntimeError(
            f"range request failed after {self.RETRIES + 1} attempts: {last_error}"
        )

    def close(self) -> None:
        self._session.close()


class CachingSource:
    """LRU cache over any get_bytes source, keyed by (offset, length).

    Only responses up to `max_entry` bytes are cached (directories are small
    and re-read constantly; big tile reads are one-shot), bounded by
    `max_bytes` total."""

    def __init__(
        self, inner: GetBytes, *, max_entry: int = 1 << 20, max_bytes: int = 64 << 20
    ) -> None:
        self._inner = inner
        self._max_entry = max_entry
        self._max_bytes = max_bytes
        self._cache: OrderedDict[tuple[int, int], bytes] = OrderedDict()
        self._cached_bytes = 0
        self.misses = 0  # exposed for tests + the UI's request counter

    def __call__(self, offset: int, length: int) -> bytes:
        key = (offset, length)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        data = self._inner(offset, length)
        self.misses += 1
        if len(data) <= self._max_entry:
            self._cache[key] = data
            self._cached_bytes += len(data)
            while self._cached_bytes > self._max_bytes:
                _, evicted = self._cache.popitem(last=False)
                self._cached_bytes -= len(evicted)
        return data


def source_info(get_bytes: GetBytes) -> dict:
    """The source archive's header dict (zoom range, bbox, compression, type)."""
    return Reader(get_bytes).header()


def extract(
    get_bytes: GetBytes,
    out_path: Path,
    bbox: tuple[float, float, float, float],
    min_zoom: int,
    max_zoom: int,
    *,
    progress: Optional[Callable[[int, int], None]] = None,
    cancel: Optional[threading.Event] = None,
    metadata_name: str = "region",
) -> dict:
    """Copy every bbox tile in [min_zoom, max_zoom] into a new PMTiles archive.

    Writes to `out_path` (caller deletes it on error/cancel). Tiles missing in
    the source (pruned ocean etc.) are skipped but still counted for progress.
    Returns {"tiles": written, "skipped": missing, "requests": upstream_reads}.
    """
    reader = Reader(get_bytes)
    header = reader.header()
    src_min, src_max = header["min_zoom"], header["max_zoom"]
    if min_zoom < src_min or max_zoom > src_max:
        raise ValueError(
            f"zoom range z{min_zoom}-z{max_zoom} outside the source's z{src_min}-z{src_max}"
        )
    src_meta = reader.metadata() or {}

    # Spec: entries must be written in ascending tileid order. zoom-major
    # iteration is already globally ascending across zooms; sort within each
    # zoom level (Hilbert order differs from row-major).
    ids: list[int] = []
    current_z: Optional[int] = None
    zoom_ids: list[int] = []
    for z, x, y in iter_bbox_tiles(bbox, min_zoom, max_zoom):
        if z != current_z:
            ids.extend(sorted(zoom_ids))
            zoom_ids = []
            current_z = z
        zoom_ids.append(zxy_to_tileid(z, x, y))
    ids.extend(sorted(zoom_ids))

    total = len(ids)
    written = 0
    skipped = 0
    misses_before = get_bytes.misses if isinstance(get_bytes, CachingSource) else 0

    with open(out_path, "wb") as f:
        writer = Writer(f)
        for done, tileid in enumerate(ids, start=1):
            if cancel is not None and cancel.is_set():
                raise ExtractCancelled()
            z, x, y = tileid_to_zxy(tileid)
            data = reader.get(z, x, y)  # stored bytes (still compressed)
            if data:
                writer.write_tile(tileid, data)
                written += 1
            else:
                skipped += 1
            if progress is not None:
                progress(done, total)

        west, south, east, north = bbox
        out_header = {
            "version": 3,
            "tile_type": header["tile_type"],
            "tile_compression": header["tile_compression"],
            "min_lon_e7": int(west * 1e7),
            "min_lat_e7": int(south * 1e7),
            "max_lon_e7": int(east * 1e7),
            "max_lat_e7": int(north * 1e7),
            "center_zoom": min_zoom,
            "center_lon_e7": int((west + east) / 2 * 1e7),
            "center_lat_e7": int((south + north) / 2 * 1e7),
        }
        out_meta = {"name": metadata_name, "generator": "enigma map_packager"}
        # vector_layers is what styling/inspection tools read — carry it over.
        if "vector_layers" in src_meta:
            out_meta["vector_layers"] = src_meta["vector_layers"]
        writer.finalize(out_header, out_meta)

    requests_made = (
        get_bytes.misses - misses_before if isinstance(get_bytes, CachingSource) else -1
    )
    return {"tiles": written, "skipped": skipped, "requests": requests_made}
