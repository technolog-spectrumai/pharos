# Proteus

The optional Pharos helper: an onion-only mailbox (M3), directory (D5) and
pairing drop-off, small enough for a Raspberry Pi. Enigma works without it.

- Running it: [docs/raspberry-pi.md](docs/raspberry-pi.md)
- Encrypting its disk: [docs/disk-encryption.md](docs/disk-encryption.md)
- The API: the table at the top of [src/api.rs](src/api.rs); the protocol: [../PROTOCOL.md](../PROTOCOL.md)
- **Connecting Enigma:** open `http://<its onion>/` in Tor Browser. The page
  shows its code as a QR image and as text, with both to download; in Enigma,
  under Friends → ⚙ You and your Proteus, scan the QR or paste the text. On
  the Pi itself, `proteus code` prints the same code and QR
  (`--png qr.png` writes the image). `name:` and `page:` in the config set
  what it is called and whether the page is served.

```sh
proteus init   -c config.yaml     # master key and data folder
proteus check  -c config.yaml     # key permissions, disk encryption
proteus serve  -c config.yaml     # on an onion service
proteus status -c config.yaml     # row counts, onion address
proteus backup -c config.yaml OUT # a consistent copy of the database
proteus code   -c config.yaml     # its code for Enigma, as text and a QR (--png FILE for an image)
```
