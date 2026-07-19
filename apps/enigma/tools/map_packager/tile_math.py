"""Web-Mercator tile math — pure, no deps.

Mirrors the app's `maps.rs` / rakotis `mapModel.ts` implementations so a bbox
entered here covers exactly the tiles the app will look up when rendering.
bbox convention everywhere: [west, south, east, north] in degrees.
"""
from __future__ import annotations

import math
from typing import Iterator

MERCATOR_MAX_LAT = 85.05112878
ZOOM_MAX = 22


def validate_bbox(bbox: tuple[float, float, float, float]) -> bool:
    """Same acceptance rule as the app: in-range, west<east, south<north
    (antimeridian-crossing boxes are rejected)."""
    west, south, east, north = bbox
    return (
        -180.0 <= west <= 180.0
        and -180.0 <= east <= 180.0
        and -90.0 <= south <= 90.0
        and -90.0 <= north <= 90.0
        and west < east
        and south < north
    )


def lon_lat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    """XYZ tile containing (lon, lat) at zoom z (clamped to the Mercator square)."""
    n = 1 << z
    lat = max(-MERCATOR_MAX_LAT, min(MERCATOR_MAX_LAT, lat))
    lat_rad = math.radians(lat)
    x = math.floor((lon + 180.0) / 360.0 * n)
    y = math.floor((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def bbox_tile_range(
    bbox: tuple[float, float, float, float], z: int
) -> tuple[int, int, int, int]:
    """Inclusive (x_min, x_max, y_min, y_max) covering bbox at zoom z."""
    west, south, east, north = bbox
    x_min, y_min = lon_lat_to_tile(west, north, z)  # NW corner
    x_max, y_max = lon_lat_to_tile(east, south, z)  # SE corner
    return x_min, x_max, y_min, y_max


def bbox_tile_count(
    bbox: tuple[float, float, float, float], min_zoom: int, max_zoom: int
) -> int:
    """Total tiles covering bbox for every zoom in [min_zoom, max_zoom]."""
    count = 0
    for z in range(min_zoom, max_zoom + 1):
        x_min, x_max, y_min, y_max = bbox_tile_range(bbox, z)
        count += (x_max - x_min + 1) * (y_max - y_min + 1)
    return count


def iter_bbox_tiles(
    bbox: tuple[float, float, float, float], min_zoom: int, max_zoom: int
) -> Iterator[tuple[int, int, int]]:
    """Yield every (z, x, y) covering bbox, zoom-major (ascending z)."""
    for z in range(min_zoom, max_zoom + 1):
        x_min, x_max, y_min, y_max = bbox_tile_range(bbox, z)
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                yield z, x, y
