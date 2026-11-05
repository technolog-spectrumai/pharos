# Proteus

The optional Pharos helper: an onion-only mailbox (M3), directory (D5) and
pairing drop-off, small enough for a Raspberry Pi. Nautes works without it.

- Running it: [docs/raspberry-pi.md](docs/raspberry-pi.md)
- Encrypting its disk: [docs/disk-encryption.md](docs/disk-encryption.md)
- The API: the table at the top of [src/api.rs](src/api.rs); the protocol: [../PROTOCOL.md](../PROTOCOL.md)

```sh
proteus init   -c config.yaml     # master key and data folder
proteus check  -c config.yaml     # key permissions, disk encryption
proteus serve  -c config.yaml     # on an onion service
proteus status -c config.yaml     # row counts, onion address
proteus backup -c config.yaml OUT # a consistent copy of the database
```
