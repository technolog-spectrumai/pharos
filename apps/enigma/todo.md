# Enigma26 — todo

Open work and unresolved decisions. `[x]` done and verified, `[~]` partly done,
`[ ]` not started. How things work is in [technology.md](technology.md); this
file is only what is left to do or decide.

## Maps moved to Morion (2026-10-03)

- [x] **The Map tab is gone from the app**, with everything behind it: the
      `maps` build feature, `maps.rs` and its commands, the `pmtiles` crate,
      `maplibre-gl`, the bundled glyphs and sprites, the map model in rakotis,
      the storage-limit setting, the `data.delete.maps` HP credit, and
      `tools/map_packager` (now in Morion's repository). Professional lists
      seven features. Checked: the crate builds warning-free with no features,
      with Standard's and with Professional's; `./tests.sh` passes its 13
      non-browser steps, one of which now fails if a map library or a map
      command turns up in any bundle.
- [x] **Map shares are kept as cards that say they cannot be shown** — in a
      stored history, or from a peer on an older build. Their payload is not
      read or stored. Tested in rakotis (`chatHistoryModel.test.ts`) and in the
      bubble.
- [x] **The geolocation guard survived the move**: it was among the Map tab's
      browser tests and is its own spec now (`tests/e2e/noGeolocation.spec.ts`).
- [ ] **Pins in existing profiles have no way out.** A profile that used the
      Map tab still holds its pins (`map:pins`) and region list (`map:regions`)
      in the sealed store, and nothing shows them any more. Morion reads pins
      as GeoJSON; a one-off "export my map pins" here — read the list, write a
      `.geojson` — would carry them over. Not built: decide whether anyone has
      pins worth keeping before it is.
- [ ] **Region files are left on disk** in such a profile
      (`profiles/<p>/maps/<blake3>.pmtiles`, up to the old storage limit —
      512 MB by default). They are ordinary PMTiles files and open in Morion
      as they are, which is the reason nothing deletes them. Only a full data
      wipe removes them. Decide: leave them, or offer to move or delete them.
- [ ] **`WEBKIT_DISABLE_DMABUF_RENDERER=1` is still set** (`main.rs`). It was
      for the map's WebGL canvas, the app's only one. Removing it is probably
      right and changes how the whole window is composited on NVIDIA and
      hybrid-GPU Linux, so it wants a look on such a machine first.

## Feature allowlists instead of editions (2026-10-03)

- [x] **Build driver (Rutile).** `features: [...]` per app replaces `edition`;
      an unknown id, a feature listed twice, a missing requirement or a missing
      `features` key is refused before anything runs. A positional `*.yaml`
      argument selects the config; `--config` still works.
- [x] **Rust: omitted features are not compiled.** Eight Cargo features at
      the time (seven since maps left — above); `mainline` and `rustfft` are
      optional dependencies; the
      modules, commands, managed state and network protocols of an omitted
      feature are behind `#[cfg(feature)]`. Checked: the crate builds
      warning-free with no features, with each feature alone, with Standard's
      set and with Professional's; a Standard build links neither crate and
      its binary contains no `vox_*` or `dht_*` command.
- [~] **Frontend: omitted features are not bundled.** Done for the code that
      matters: the feature views (lazy routes registered only when compiled
      in), the tab list, `useVoxCall` / `useRoomInvites` / `useMeetings`, the
      key-ring panel and the PIN keypad. A Standard bundle has no call code.
      **Not done:** thin command wrappers in shared modules (rakotis' `dht*`
      helpers) and the inline DHT cards inside the Settings and Contacts views
      still ship in a build without that feature.
      They are dead at run time. Removing them means splitting those cards into
      components of their own and moving the wrappers behind them.
- [x] **`build_config.yaml` reduced** to crypto, protocol constants, setting
      defaults/bounds and new-profile toggle defaults (`features:` renamed
      `defaults:`). Editions, the `configs/` directory, the per-edition Tauri
      overlays, `scripts/edition_conf.sh` and `ENIGMA_EDITION` are gone;
      identity and version are read from `tauri.conf.json`.
- [x] **Presets.** `pro.yaml` (every feature — seven now) and `std.yaml`
      (`hosted_relays`, `contacts`, `keyring`, `pin_unlock`). `./build.sh`
      builds Professional, `./build.sh std.yaml` Standard. A debug `.deb` was
      built from each.
- [x] **One dev runner.** `./run_dev.sh --dual` replaces `run2.sh`;
      `./run_dev.sh std.yaml` runs another preset. Checked: a single
      Professional run, a single Standard run, and `--dual` (two instances,
      separate profiles / identities / build dirs, one Vite server) all came
      up, and stopping `--dual` left no app, cargo, Vite or npm process.
- [x] **`tests.sh`, README, technology.md** updated; `tests.sh` gained steps
      that check the feature sets compile, that Standard links no optional
      crate, and that a Standard bundle omits calls.
- [~] **CI** (`.gitlab-ci.yml`) updated to build Professional and to check the
      crate with no features and with all of them — **not run**: nothing here
      can execute GitLab CI, and the runner still needs credentials for the
      Rutile submodule (below). It does not check Standard's exact list; the
      image has no node to read the preset with.

## Unresolved decisions

- **Should a preset be able to change setting defaults or bounds?** Today it
  cannot: they live in `build_config.yaml`, one copy for both presets (chosen
  2026-10-03). If Professional should get, say, a larger default file size,
  `settings.*` is safe to vary per preset; `network.max_frame_bytes` is not —
  peers in one room must agree on it.
- **Is there still an entry-level product?** The Basic edition (contacts,
  calendar and PIN unlock, without relays) went away with editions, and the
  local `custom` config with it. Any list can be built from a new root config;
  none is shipped.
- **Should the always-on features become optional too?** Tor, file transfer,
  per-file locking, invitations, Privacy HP and voice notes are compiled into
  every build. Tor is the heavy one (the `arti` tree). Voice notes are why the
  audio crates stay in a build without `calls`.
- **Cross-preset signalling.** A Professional peer cannot tell that a room
  member is on Standard: a call is refused at protocol negotiation, a meeting
  is silently dropped. Decide whether the sender should be told.
- **Should the app say which preset it is?** Nothing in the UI does, beyond
  which tabs exist.

## Carried over

- [ ] **Three Playwright smoke tests fail** (DHT toggle, "find people", the
      Create button). They predate the repo split and the feature work — the
      tests lag behind UI changes. `./tests.sh e2e` shows them.
- [ ] **CI cannot fetch Rutile yet.** The submodule URL is an SSH one on GitHub
      and this repo's CI is on GitLab; the runner needs a deploy key or a URL
      rewrite before any job can clone.
- [ ] **Push order.** Rutile first, then this repo — the submodule pin names a
      Rutile commit that must exist on its remote.
- [ ] **Version is still duplicated** in `Cargo.toml` and three `package.json`
      files beside its owner, `tauri.conf.json`.
- [ ] **Moving a profile between presets is untested.** The vault format does
      not depend on features, so it should work.
