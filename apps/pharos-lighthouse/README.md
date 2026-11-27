# Pharos Lighthouse

The Beacon app ("Lighthouse" in its UI; the protocol and the server are still called Beacon): a window to run and manage a Beacon (`beacon/`) on a desktop or a Raspberry Pi
with a screen. **Linux only (desktop or Raspberry Pi)**: on other systems the
binary builds (so the workspace does) but only says so and exits. Same look as `apps/enigma27` (its `ui/theme.slint` is imported). Theme choice: `~/.config/pharos-lighthouse/theme` (the old `enigma-beacon` file is read if the new one is missing; the same for `config.yaml`).

The UI is a `LighthouseView` driven by the `Lh` global; `src/glue.rs` (the window glue) is also compiled into `apps/enigma27-combo`, which shows the same view next to the client.

    cargo run -p pharos-lighthouse                     # the Beacon of /etc/beacon/config.yaml, or ~/.config/pharos-lighthouse/
    cargo run -p pharos-lighthouse -- -c config.yaml   # another config (the `beacon` CLI reads the same file)
    cargo run -p pharos-lighthouse -- --tcp 127.0.0.1:8080   # loopback instead of Tor (development)
    cargo run -p pharos-lighthouse -- --demo           # fake clients and rooms (screenshots)

Screens: Overview (start/stop switch, state, onion, Beacon code as a QR, uptime,
Tor), Clients (device ids, online, last seen, rooms, queued; "Only my phones" and
the allowed list, as `beacon allow/deny/clients`), Rooms (route ids, local online,
linked Beacons, queues), Settings (name, data folder, master key, disk-encryption
check, limits, backup, page), Log. Counts and ids only.

Logic is in `src/model.rs` (no UI), on `beacon::runner` (start/stop a Beacon from
code) and `beacon_node::relay::Relay::{stats, events_since}`.

## Raspberry Pi without a desktop

Build with the KMS backend; it draws straight to the display and reads touch /
keyboard through libinput:

    sudo apt install libudev-dev libinput-dev libgbm-dev libdrm-dev libxkbcommon-dev
    cargo build --release -p pharos-lighthouse --features linuxkms
    SLINT_BACKEND=linuxkms-femtovg ./target/release/pharos-lighthouse

Run it as the user that owns the data folder (in groups `video` and `input`).
The layout fits an 800×480 screen (`docs/screens/lighthouse/pi-800x480.png`).

## Screenshots

    cargo run -p pharos-lighthouse --example lighthouse-screens   # → docs/screens/lighthouse/
