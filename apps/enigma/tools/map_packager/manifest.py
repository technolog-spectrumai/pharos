"""Region package manifests — the exact `MapRegionManifest` wire shape the
Enigma app verifies on import (src-tauri/src/maps.rs `validate_manifest`).

A package is `<name>.pmtiles` + `<name>.manifest.json` side by side; the app's
file picker auto-detects the sidecar and then re-verifies BLAKE3 + every field
itself, so nothing here is trusted — it just has to be RIGHT.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

import blake3

from tile_math import ZOOM_MAX, validate_bbox

NAME_MAX_LEN = 120
SOURCE_URL_MAX_LEN = 2048
MANIFEST_VERSION = 1

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


@dataclass
class RegionManifest:
    id: str
    name: str
    bbox: tuple[float, float, float, float]  # [west, south, east, north]
    min_zoom: int
    max_zoom: int
    size: int
    blake3: str
    source_url: str
    version: int = MANIFEST_VERSION

    def validate(self) -> None:
        """Mirror of the app's manifest matrix — raises ValueError on the first
        violation (same order as maps.rs so failures read the same)."""
        if not self.id or len(self.id) > 64:
            raise ValueError("manifest: bad id")
        if not self.name.strip() or len(self.name) > NAME_MAX_LEN:
            raise ValueError("manifest: bad name")
        if not validate_bbox(self.bbox):
            raise ValueError("manifest: bad bbox")
        if self.min_zoom > self.max_zoom or self.max_zoom > ZOOM_MAX:
            raise ValueError("manifest: bad zoom range")
        if self.size <= 0:
            raise ValueError("manifest: bad size")
        if not _HEX64.match(self.blake3):
            raise ValueError("manifest: bad blake3")
        if len(self.source_url) > SOURCE_URL_MAX_LEN:
            raise ValueError("manifest: bad sourceUrl")
        if self.version != MANIFEST_VERSION:
            raise ValueError("manifest: unsupported version")

    def to_wire(self) -> dict:
        """camelCase JSON object exactly as the app deserializes it."""
        return {
            "id": self.id,
            "name": self.name,
            "bbox": list(self.bbox),
            "minZoom": self.min_zoom,
            "maxZoom": self.max_zoom,
            "size": self.size,
            "blake3": self.blake3,
            "sourceUrl": self.source_url,
            "version": self.version,
        }

    @classmethod
    def from_wire(cls, obj: dict) -> "RegionManifest":
        return cls(
            id=obj["id"],
            name=obj["name"],
            bbox=tuple(obj["bbox"]),
            min_zoom=obj["minZoom"],
            max_zoom=obj["maxZoom"],
            size=obj["size"],
            blake3=obj["blake3"],
            source_url=obj["sourceUrl"],
            version=obj["version"],
        )


def blake3_file(path: Path) -> tuple[str, int]:
    """(lowercase-hex BLAKE3, byte size) of a file, streamed in 1 MiB chunks —
    the same content address the app computes."""
    hasher = blake3.blake3()
    size = 0
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            hasher.update(chunk)
            size += len(chunk)
    return hasher.hexdigest(), size


def build_manifest(
    archive: Path,
    name: str,
    bbox: tuple[float, float, float, float],
    min_zoom: int,
    max_zoom: int,
    source_url: str,
) -> RegionManifest:
    """Manifest for a freshly written archive (hashes the file; validates)."""
    digest, size = blake3_file(archive)
    manifest = RegionManifest(
        id=str(uuid.uuid4()),
        name=name.strip()[:NAME_MAX_LEN],
        bbox=bbox,
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        size=size,
        blake3=digest,
        source_url=source_url.strip()[:SOURCE_URL_MAX_LEN],
    )
    manifest.validate()
    return manifest


def write_sidecar(archive: Path, manifest: RegionManifest) -> Path:
    """Write `<stem>.manifest.json` next to the archive (the app auto-detects
    exactly this name on import)."""
    sidecar = archive.with_suffix(".manifest.json")
    sidecar.write_text(json.dumps(manifest.to_wire(), indent=2), encoding="utf-8")
    return sidecar
