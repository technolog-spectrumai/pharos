# Enigma26 — todo

Stages and their steps. `[x]` done and verified, `[~]` partly done, `[ ]` not
started. How things work is in [technology.md](technology.md).

## Stage 1 — Maps

- [x] **1.1 Move maps out to Morion.** The Map tab, `maps.rs`, the `maps`
      feature, the map libraries and `tools/map_packager` are gone from this
      repo; a map share in a room's history shows as a card that cannot be
      opened. What was done and what stays: technology.md §16.

## Open, outside the stages

Kept from before the stages, one line each; the detail is in technology.md
(§13, §16, §20.6) and in this file's history.

- [ ] Pins in existing profiles (`map:pins`) have no way out of the vault; an
      export to `.geojson` would carry them to Morion. Decide if it is needed.
- [ ] Region files stay on disk in a profile that used maps
      (`profiles/<p>/maps/*.pmtiles`); they open in Morion as they are.
- [ ] `WEBKIT_DISABLE_DMABUF_RENDERER=1` (`main.rs`) was for the map canvas;
      removing it wants a look on an NVIDIA / hybrid-GPU machine.
- [ ] Three Playwright smoke tests fail (DHT toggle, "find people", Create).
- [ ] CI is unverified and cannot fetch the Rutile submodule yet.
- [ ] Push order: Rutile first, then this repo.
- [ ] Version is duplicated in `Cargo.toml` and three `package.json` files.
- [ ] Thin DHT wrappers and cards still ship in a build without `dht`.
- [ ] Undecided: per-preset setting defaults; an entry-level preset; making
      Tor and the other always-on features optional; telling a sender that a
      peer's build lacks a feature; showing the preset in the UI.
