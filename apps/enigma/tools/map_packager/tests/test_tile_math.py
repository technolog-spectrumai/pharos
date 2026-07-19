"""tile_math must agree with the app's maps.rs/mapModel.ts implementations —
the fixed points below are the same ones asserted in the Rust tests."""
import pytest

from tile_math import (
    bbox_tile_count,
    bbox_tile_range,
    iter_bbox_tiles,
    lon_lat_to_tile,
    validate_bbox,
)

POZNAN = (16.8, 52.3, 17.1, 52.5)


def test_fixed_points_match_the_app():
    assert lon_lat_to_tile(0.0, 0.0, 0) == (0, 0)
    assert lon_lat_to_tile(0.0, 0.0, 1) == (1, 1)
    assert lon_lat_to_tile(-180.0, 85.0, 2) == (0, 0)
    # Poznań at z10 — the exact tile asserted in maps.rs.
    assert lon_lat_to_tile(16.9, 52.4, 10) == (560, 336)


def test_bbox_ranges_and_counts():
    x_min, x_max, y_min, y_max = bbox_tile_range(POZNAN, 10)
    assert x_min <= x_max and y_min <= y_max
    assert bbox_tile_count(POZNAN, 0, 0) == 1
    assert bbox_tile_count(POZNAN, 0, 12) > bbox_tile_count(POZNAN, 0, 8)
    # Every tile the iterator yields is inside the advertised range.
    tiles = list(iter_bbox_tiles(POZNAN, 8, 10))
    assert len(tiles) == bbox_tile_count(POZNAN, 8, 10)
    assert all(z in (8, 9, 10) for z, _, _ in tiles)


def test_poles_clamp_to_mercator_square():
    n = 1 << 5
    assert lon_lat_to_tile(0.0, 90.0, 5)[1] == 0
    assert lon_lat_to_tile(0.0, -90.0, 5)[1] == n - 1


@pytest.mark.parametrize(
    "bbox,ok",
    [
        (POZNAN, True),
        ((-180.0, -85.0, 180.0, 85.0), True),
        ((17.1, 52.3, 16.8, 52.5), False),  # west >= east
        ((16.8, 52.5, 17.1, 52.3), False),  # south >= north
        ((181.0, 0.0, 182.0, 1.0), False),  # out of range
        ((170.0, 0.0, -170.0, 1.0), False),  # antimeridian crossing
    ],
)
def test_validate_bbox(bbox, ok):
    assert validate_bbox(bbox) is ok
