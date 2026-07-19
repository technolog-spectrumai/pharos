"""Extraction round-trip over file + HTTP-range sources, caching, cancel."""
import gzip
import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from pmtiles.reader import MmapSource, Reader
from pmtiles.tile import Compression, TileType, zxy_to_tileid

import pm_source
from manifest import build_manifest
from pm_source import (
    CachingSource,
    ExtractCancelled,
    FileSource,
    HttpRangeSource,
    extract,
)
from pmtiles.writer import Writer

WORLD = (-180.0, -85.0, 180.0, 85.0)


@pytest.fixture()
def source_archive(tmp_path):
    """A tiny z0-z2 'planet': every tile present, content = its zxy string."""
    path = tmp_path / "planet.pmtiles"
    entries = []
    for z in range(3):
        for x in range(1 << z):
            for y in range(1 << z):
                entries.append((zxy_to_tileid(z, x, y), f"{z}/{x}/{y}".encode()))
    with open(path, "wb") as f:
        w = Writer(f)
        for tileid, data in sorted(entries):
            w.write_tile(tileid, gzip.compress(data))
        w.finalize(
            {
                "version": 3,
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_lon_e7": int(-180 * 1e7),
                "min_lat_e7": int(-85 * 1e7),
                "max_lon_e7": int(180 * 1e7),
                "max_lat_e7": int(85 * 1e7),
                "center_zoom": 0,
                "center_lon_e7": 0,
                "center_lat_e7": 0,
            },
            {"name": "planet", "vector_layers": [{"id": "places"}]},
        )
    return path


def test_extract_world_roundtrip(tmp_path, source_archive):
    out = tmp_path / "world.pmtiles"
    seen = []
    stats = extract(
        FileSource(source_archive), out, WORLD, 0, 1,
        progress=lambda done, total: seen.append((done, total)),
        metadata_name="world",
    )
    assert stats == {"tiles": 5, "skipped": 0, "requests": -1}
    assert seen[-1] == (5, 5)

    with open(out, "rb") as f:
        r = Reader(MmapSource(f))
        h = r.header()
        assert (h["min_zoom"], h["max_zoom"]) == (0, 1)
        assert h["tile_compression"] == Compression.GZIP
        assert gzip.decompress(r.get(1, 1, 0)) == b"1/1/0"
        assert r.get(2, 0, 0) is None  # z2 not requested
        meta = r.metadata()
        assert meta["generator"] == "enigma map_packager"
        assert meta["vector_layers"] == [{"id": "places"}]  # carried over

    # The package manifests + validates like the app expects.
    m = build_manifest(out, "world", WORLD, 0, 1, "https://example.org/planet.pmtiles")
    assert m.size == out.stat().st_size


def test_extract_subregion_skips_out_of_bbox(tmp_path, source_archive):
    # An eastern-hemisphere bbox at z2 covers a 2x2 block (x 2-3, y 0-1),
    # not all 16 tiles.
    out = tmp_path / "sub.pmtiles"
    stats = extract(FileSource(source_archive), out, (1.0, 1.0, 91.0, 84.0), 2, 2)
    assert stats["tiles"] == 4
    with open(out, "rb") as f:
        r = Reader(MmapSource(f))
        assert gzip.decompress(r.get(2, 2, 1)) == b"2/2/1"
        assert r.get(2, 0, 0) is None


def test_extract_rejects_zoom_outside_source(tmp_path, source_archive):
    with pytest.raises(ValueError, match="outside the source"):
        extract(FileSource(source_archive), tmp_path / "x.pmtiles", WORLD, 0, 9)


def test_extract_cancel_raises(tmp_path, source_archive):
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(ExtractCancelled):
        extract(FileSource(source_archive), tmp_path / "x.pmtiles", WORLD, 0, 2, cancel=cancel)


class _RangeHandler(BaseHTTPRequestHandler):
    blob: bytes = b""
    range_denied = False

    def do_GET(self):  # noqa: N802 (http.server API)
        if self.range_denied or "Range" not in self.headers:
            self.send_response(200)
            self.send_header("Content-Length", str(len(self.blob)))
            self.end_headers()
            self.wfile.write(self.blob)
            return
        spec = self.headers["Range"].removeprefix("bytes=")
        start_s, end_s = spec.split("-")
        start, end = int(start_s), min(int(end_s), len(self.blob) - 1)
        chunk = self.blob[start : end + 1]
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {start}-{end}/{len(self.blob)}")
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        self.wfile.write(chunk)

    def log_message(self, *args):  # keep pytest output clean
        pass


@pytest.fixture()
def range_server(source_archive):
    _RangeHandler.blob = source_archive.read_bytes()
    _RangeHandler.range_denied = False
    server = ThreadingHTTPServer(("127.0.0.1", 0), _RangeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/planet.pmtiles"
    server.shutdown()


def test_http_range_source_extracts(tmp_path, range_server):
    out = tmp_path / "http.pmtiles"
    src = CachingSource(HttpRangeSource(range_server))
    stats = extract(src, out, WORLD, 0, 2, metadata_name="via-http")
    assert stats["tiles"] == 21
    # The cache keeps directory re-reads off the wire: far fewer upstream
    # requests than the 21 tiles x 2-3 reads an uncached Reader would issue.
    assert 0 < stats["requests"] <= 25
    with open(out, "rb") as f:
        assert gzip.decompress(Reader(MmapSource(f)).get(2, 3, 3)) == b"2/3/3"


def test_http_source_refuses_full_body_fallback(range_server):
    _RangeHandler.range_denied = True
    with pytest.raises(RuntimeError, match="Range"):
        HttpRangeSource(range_server)(0, 16384)


def test_caching_source_counts_misses():
    calls = []

    def inner(offset, length):
        calls.append((offset, length))
        return bytes(length)

    src = CachingSource(inner)
    src(0, 100); src(0, 100); src(0, 100)
    src(5, 10)
    assert src.misses == 2
    assert len(calls) == 2


def test_http_source_retries_transient_failures(monkeypatch):
    """One timeout + one 503 must not kill a run; the third attempt succeeds."""
    import requests as requests_mod

    class _Resp:
        def __init__(self, status, content=b""):
            self.status_code = status
            self.content = content

        def raise_for_status(self):
            pass

    class _FlakySession:
        def __init__(self):
            self.calls = 0
            self.headers = {}

        def get(self, url, headers=None, timeout=None):
            self.calls += 1
            if self.calls == 1:
                raise requests_mod.Timeout("read timed out")
            if self.calls == 2:
                return _Resp(503)
            return _Resp(206, b"tile-bytes")

    monkeypatch.setattr(pm_source.time, "sleep", lambda _s: None)
    session = _FlakySession()
    src = HttpRangeSource("https://example.org/p.pmtiles", session=session)
    assert src(0, 10) == b"tile-bytes"
    assert session.calls == 3


def test_http_source_gives_up_after_retries(monkeypatch):
    import requests as requests_mod

    class _DeadSession:
        headers = {}

        def get(self, url, headers=None, timeout=None):
            raise requests_mod.ConnectionError("refused")

    monkeypatch.setattr(pm_source.time, "sleep", lambda _s: None)
    src = HttpRangeSource("https://example.org/p.pmtiles", session=_DeadSession())
    with pytest.raises(RuntimeError, match="after 4 attempts"):
        src(0, 10)
