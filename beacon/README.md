# Beacon

The optional Pharos helper: an onion-only mailbox (M3), directory (D5) and
pairing drop-off, small enough for a Raspberry Pi. Formerly called Relay (and
Proteus before that); renamed only, its protocol is unchanged.

**Beacon and Enigma27.** Beacon serves the older Pharos friend protocol
([../PROTOCOL.md](../PROTOCOL.md), Part B), which the friend client spoke.
Enigma27, the client Pharos ships now, does not use it: it is kept for a later
room mailbox. Enigma27 works without it and does not talk to it yet.

- Running it: [docs/raspberry-pi.md](docs/raspberry-pi.md)
- Encrypting its disk: [docs/disk-encryption.md](docs/disk-encryption.md)
- The API: the table at the top of [src/api.rs](src/api.rs); the protocol: [../PROTOCOL.md](../PROTOCOL.md), Part B
- **Its code:** open `http://<its onion>/` in Tor Browser. The page shows its
  code as a QR image and as text, with both to download. On the Pi itself,
  `beacon code` prints the same code and QR (`--png qr.png` writes the image).
  `name:` and `page:` in the config set what it is called and whether the page
  is served. (Enigma27 has no place to enter it yet.)
- **Building:** `./build.sh beacon [pi|all]` from the repo root (`beacon/build.sh`):
  a release binary and a `.deb` in `dist/beacon/<arch>/`, with `SHA256SUMS` and
  `build.json`.

```sh
beacon init   -c config.yaml     # master key and data folder
beacon check  -c config.yaml     # key permissions, disk encryption
beacon serve  -c config.yaml     # on an onion service
beacon status -c config.yaml     # row counts, onion address
beacon backup -c config.yaml OUT # a consistent copy of the database
beacon code   -c config.yaml     # its code for Enigma, as text and a QR (--png FILE for an image)
```
