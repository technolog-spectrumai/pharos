# Enigma Beacon

A window to run and manage a Beacon (`beacon/`) on a desktop or a Raspberry Pi
with a screen. **Linux only (desktop or Raspberry Pi)**: on other systems the
binary builds (so the workspace does) but only says so and exits. Same look as `apps/enigma27` (theme and widgets copied).

    cargo run -p enigma-beacon                     # the Beacon of /etc/beacon/config.yaml, or ~/.config/enigma-beacon/
    cargo run -p enigma-beacon -- -c config.yaml   # another config (the `beacon` CLI reads the same file)
    cargo run -p enigma-beacon -- --tcp 127.0.0.1:8080   # loopback instead of Tor (development)
    cargo run -p enigma-beacon -- --demo           # fake clients and rooms (screenshots)

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
    cargo build --release -p enigma-beacon --features linuxkms
    SLINT_BACKEND=linuxkms-femtovg ./target/release/enigma-beacon

Run it as the user that owns the data folder (in groups `video` and `input`).
The layout fits an 800×480 screen (`docs/screens/beacon-app/pi-800x480.png`).

## Screenshots

    cargo run -p enigma-beacon --example beacon-screens   # → docs/screens/beacon-app/
