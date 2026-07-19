"""Town-name → bbox lookup via Nominatim (jsonv2), UI-free.

One explicit, user-triggered request per lookup — the endpoint is editable in
the UI (self-hosted Nominatim works unchanged) and the UA is honest, per the
public instance's usage policy. Results carry the display name so the user
picks the right "Poznań" before any bbox is filled in.
"""
from __future__ import annotations

from dataclasses import dataclass

import requests

from utils import USER_AGENT

DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org"


@dataclass
class TownHit:
    display_name: str
    bbox: tuple[float, float, float, float]  # [west, south, east, north]


def search_town(
    query: str,
    *,
    endpoint: str = DEFAULT_ENDPOINT,
    limit: int = 5,
    timeout: float = 15.0,
) -> list[TownHit]:
    """Best-effort town lookup; raises requests errors for the UI to surface."""
    resp = requests.get(
        f"{endpoint.rstrip('/')}/search",
        params={"q": query, "format": "jsonv2", "limit": str(limit)},
        headers={"User-Agent": USER_AGENT},
        timeout=timeout,
    )
    resp.raise_for_status()
    hits: list[TownHit] = []
    for item in resp.json():
        try:
            # Nominatim order: [south, north, west, east] (strings).
            south, north, west, east = (float(v) for v in item["boundingbox"])
        except (KeyError, TypeError, ValueError):
            continue
        if west < east and south < north:
            hits.append(TownHit(item.get("display_name", query), (west, south, east, north)))
    return hits
