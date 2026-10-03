# Enigma26 — todo

Open work and unresolved decisions. `[x]` done and verified, `[~]` partly done,
`[ ]` not started. How things work is in [technology.md](technology.md); this
file is only what is left to do or decide.

## Feature allowlists instead of editions (2026-10-03)

- [x] **Build driver (Rutile).** `features: [...]` per app replaces `edition`;
      an unknown id, a feature listed twice, a missing requirement or a missing
      `features` key is refused before anything runs. A positional `*.yaml`
      argument selects the config; `--config` still works.
- [x] **Rust: omitted features are not compiled.** Eight Cargo features;
      `pmtiles`, `mainline` and `rustfft` are optional dependencies; the
      modules, commands, managed state and network protocols of an omitted
      feature are behind `#[cfg(feature)]`. Checked: the crate builds
      warning-free with no features, with each feature alone, with Standard's
      set and with Professional's; a Standard build links none of the three
      crates and its binary contains no `map_*`, `vox_*` or `dht_*` command.
- [~] **Frontend: omitted features are not bundled.** Done for the code that
      matters: the feature views (lazy routes registered only when compiled
      in), the tab list, `useVoxCall` / `useRoomInvites` / `useMeetings`, the
      key-ring panel and the PIN keypad. A Standard bundle has no `maplibre-gl`
      and no call or map-view code (5.3 MB against Professional's 6.5 MB).
      **Not done:** thin command wrappers in shared modules (rakotis' `dht*`
      helpers, the map store) and the inline DHT / maps cards inside the
      Settings and Contacts views still ship in a build without those features.
      They are dead at run time. Removing them means splitting those cards into
      components of their own and moving the wrappers behind them.
- [x] **`build_config.yaml` reduced** to crypto, protocol constants, setting
      defaults/bounds and new-profile toggle defaults (`features:` renamed
      `defaults:`). Editions, the `configs/` directory, the per-edition Tauri
      overlays, `scripts/edition_conf.sh` and `ENIGMA_EDITION` are gone;
      identity and version are read from `tauri.conf.json`.
- [x] **Presets.** `pro.yaml` (all eight features) and `std.yaml`
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
      crate, and that a Standard bundle omits calls and maps.
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
  member is on Standard: a call is refused at protocol negotiation, a meeting or
  a shared map is silently dropped. Decide whether the sender should be told.
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
