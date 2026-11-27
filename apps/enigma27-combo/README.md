# enigma27-combo (Enigma27 Combo)

Enigma27 (the client) and Pharos Lighthouse (its Beacon) in one window, for a Linux PC
that is both your chat app and your Lighthouse. **Linux only** (Ubuntu first); elsewhere
the binary builds but only says so.

    cargo run -p enigma27-combo                  # Lighthouse on its own onion (Tor) + the client
    cargo run -p enigma27-combo -- --demo        # demo client (Ann) + demo Lighthouse (screenshots)
    cargo run -p enigma27-combo -- --data DIR    # the client's profiles elsewhere (default ~/.local/share/enigma27-combo)
    cargo run -p enigma27-combo -- -c cfg.yaml   # another Lighthouse config (default ~/.config/enigma27-combo/lighthouse/)
    ./build.sh combo                             # release binary + .deb in dist/enigma27-combo/

Left rail: Enigma27 (Chats / Friends / Settings) and Lighthouse (Overview / Clients /
Rooms / Settings / Log).

## How it fits together

- **Lighthouse**: pharos-lighthouse's `Model` (beacon-node `Relay`, the sealed
  `relay.sqlite` queue, its own onion through pharos-tor). Friends' phones reach it over Tor.
- **Client**: a real Enigma27 session (vault, lock gate) on `Net::Local(RelaySlot)`: it
  dials the running relay in-process, no Tor hop to itself; the Lighthouse's onion is set
  as Your Beacon once unlocked.
- **Stop / start**: stopping the Lighthouse stops the relay (`Relay::stop` also refuses new
  links); the client keeps its vault and rooms, shows "Your Lighthouse is off" and stays
  readable; on start it re-attaches by itself.
- **UI, no copies**: `build.rs` makes the window from `apps/enigma27/ui/app.slint` at
  build time (renamed `ComboWindow`, so it keeps Enigma27's Rust API; Slint's API for a
  component that *inherits* another would not) and adds `ui/window-body.slint.in` (the
  rail and pharos-lighthouse's `LighthouseView`, imported). The window glue of both apps
  (`apps/enigma27/src/glue.rs`, `apps/pharos-lighthouse/src/glue.rs`) is `include!`d into
  `client` and `lighthouse` modules, compiled on this crate's Slint types.

## Tests and screens

    cargo test -p enigma27-combo        # in-process Lighthouse, own client + a second client talk, stop/start keeps rooms
    cargo run -p enigma27-combo --example combo-screens   # → docs/screens/combo/ (2x)
