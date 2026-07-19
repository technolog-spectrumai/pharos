// Lightweight stand-in for maplibre-gl so tests never spin up the real map
// (it needs WebGL, which jsdom doesn't provide). Components under test exercise
// their own logic against these inert shells.
class StubMap {
  on(_event: string, _fn: unknown) { return this; }
  off() { return this; }
  remove() {}
  addSource() {}
  addLayer() {}
  getSource() { return undefined; }
  getBounds() {
    return { getWest: () => 0, getSouth: () => 0, getEast: () => 1, getNorth: () => 1 };
  }
  getZoom() { return 2; }
  flyTo() {}
  fitBounds() {}
}

class StubMarker {
  setLngLat() { return this; }
  addTo() { return this; }
  remove() {}
}

export default {
  Map: StubMap,
  Marker: StubMarker,
  addProtocol() {},
  removeProtocol() {},
};
