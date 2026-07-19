"""Manifest shape + validation must mirror the app's maps.rs matrix — the app
re-verifies everything on import, so any drift here = rejected packages."""
import json

import pytest

from manifest import RegionManifest, blake3_file, build_manifest, write_sidecar

BBOX = (16.8, 52.3, 17.1, 52.5)


def make(**overrides) -> RegionManifest:
    fields = dict(
        id="pkg-1",
        name="Poznań centrum",
        bbox=BBOX,
        min_zoom=0,
        max_zoom=12,
        size=4096,
        blake3="a" * 64,
        source_url="https://example.org/planet.pmtiles",
    )
    fields.update(overrides)
    return RegionManifest(**fields)


def test_wire_shape_is_camel_case_and_round_trips():
    wire = make().to_wire()
    assert set(wire) == {
        "id", "name", "bbox", "minZoom", "maxZoom", "size", "blake3", "sourceUrl", "version",
    }
    assert RegionManifest.from_wire(wire) == make()


@pytest.mark.parametrize(
    "overrides",
    [
        {"id": ""},
        {"id": "x" * 65},
        {"name": "  "},
        {"name": "x" * 121},
        {"bbox": (17.1, 52.3, 16.8, 52.5)},
        {"min_zoom": 13},              # min > max
        {"max_zoom": 23},              # over ZOOM_MAX
        {"size": 0},
        {"blake3": "A" * 64},          # uppercase = not the app's hex
        {"blake3": "a" * 63},
        {"source_url": "u" * 2049},
        {"version": 2},
    ],
)
def test_validation_rejects_the_apps_matrix(overrides):
    with pytest.raises(ValueError):
        make(**overrides).validate()


def test_blake3_file_streams_and_sizes(tmp_path):
    p = tmp_path / "blob.bin"
    p.write_bytes(b"enigma" * 1000)
    digest, size = blake3_file(p)
    assert size == 6000
    assert len(digest) == 64 and digest == digest.lower()
    # Stable: same content, same address.
    assert blake3_file(p)[0] == digest


def test_build_manifest_and_sidecar(tmp_path):
    archive = tmp_path / "Poznań centrum.pmtiles"
    archive.write_bytes(b"pmtiles-blob")
    m = build_manifest(archive, "  Poznań centrum  ", BBOX, 0, 12, "https://example.org/p.pmtiles")
    assert m.name == "Poznań centrum"
    assert m.size == archive.stat().st_size
    sidecar = write_sidecar(archive, m)
    # The exact name the app auto-detects next to the archive.
    assert sidecar.name == "Poznań centrum.manifest.json"
    assert json.loads(sidecar.read_text(encoding="utf-8"))["blake3"] == m.blake3
