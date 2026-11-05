# Pharos

A lighthouse in the dark: short messages between friends over Tor, end to end
encrypted, with no company server in the middle.

- **Nautes** — the client (Rust, Tauri 2): pair with a friend once, then
  write to them. Messages travel over Tor onion services, sealed with MLS.
- **Proteus** — the always-on helper you run yourself, sized for a Raspberry
  Pi (Rust, axum, an onion service only): it keeps sealed messages for friends
  who are offline and a sealed directory of where to find people. It never
  holds a key that opens a message.

Forked from Enigma (technolog-spectrumai/belisario, `apps/enigma`) with its
history, and cut down to this one purpose. The plan is in [todo.md](todo.md)
(short) and [work.md](work.md) (with notes). Nothing is built yet.
