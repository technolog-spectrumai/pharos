# Proteus on a Raspberry Pi

Proteus is optional: Nautes works without it, friend to friend. A Proteus
keeps messages for friends who are offline (the mailbox), lets friends find
each other again after a long time apart (the directory), and accepts a
pairing reply when you cannot scan a second QR code. It has no clearnet port:
it is reached only as an onion service.

## What you need

- A Raspberry Pi 3, 4, 5 or Zero 2 W with **64-bit Raspberry Pi OS
  (Bookworm)** or any arm64 Debian/Ubuntu with glibc 2.34 or newer.
- Network access out (Tor connects outward; nothing needs forwarding on the router).
- Budget: about 60–120 MB of memory (most of it arti's directory and circuits),
  about 30 MB for Tor's directory cache, and the database: at the default
  limits a full mailbox is 500 × 40 KiB ≈ 20 MB, but a real one holds a few
  sealed 1–8 KiB messages for a few days. The writes are small (WAL, one
  fsync per message), so an SD card is fine; a USB disk lasts longer.

## Install

From a release `.deb`:

```sh
sudo apt install ./proteus_0.1.0-1_arm64.deb
sudo systemctl enable --now proteus
sudo -u proteus proteus status -c /etc/proteus/config.yaml   # shows the onion address
```

Or by hand with the binary (`proteus` built for `aarch64-unknown-linux-gnu`):

```sh
sudo install -m 755 proteus /usr/bin/proteus
sudo adduser --system --group --home /var/lib/proteus --no-create-home proteus
sudo install -d -o proteus -g proteus -m 0700 /var/lib/proteus /etc/proteus
sudo install -o proteus -g proteus -m 0600 packaging/config.yaml /etc/proteus/config.yaml
sudo -u proteus proteus init -c /etc/proteus/config.yaml
sudo install -m 644 packaging/proteus.service /lib/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now proteus
```

Put the onion address into Nautes (Settings → Proteus). It goes on the
contact card you show friends, so they know where your mailbox is.

## Building it

```sh
sudo apt install gcc-aarch64-linux-gnu
rustup target add aarch64-unknown-linux-gnu
cargo build --release -p proteus --target aarch64-unknown-linux-gnu
cargo deb -p proteus --target aarch64-unknown-linux-gnu --no-build   # the .deb (cargo install cargo-deb)
```

`.cargo/config.toml` sets the linker. The binary is about 14 MB, stripped.

## At rest

Three layers, as in Zirkel:

1. What Nautes leaves here is sealed end to end before it arrives (MLS, or the
   friendship's directory key). Proteus cannot read it.
2. Proteus seals it again with its master key (`/etc/proteus/master.key`,
   mode 0600, refused otherwise), and stores ids and tokens only as keyed
   hashes. The database alone shows how many rows there are and how big.
3. The disk: `proteus check` says whether the data folder is on an encrypted
   disk; `serve` warns at every start if not. See
   [disk-encryption.md](disk-encryption.md).

## Backups

```sh
sudo -u proteus proteus backup -c /etc/proteus/config.yaml /var/lib/proteus/backup-$(date +%F).sqlite
```

Back up the database and `master.key` separately: one without the other is
useless, and together they are everything. Losing Proteus' data loses only
undelivered messages and directory records; friendships live in Nautes.

## Moving or rebuilding

The onion address is arti's key in `/var/lib/proteus/tor-state`. Copy that
folder with the database to keep the address; without it the new Proteus gets
a new address and friends need the new one (a new contact card).
