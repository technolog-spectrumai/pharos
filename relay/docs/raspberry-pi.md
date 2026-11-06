# Relay on a Raspberry Pi

Relay is optional: Enigma works without it, friend to friend. A Relay
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
sudo apt install ./relay_0.1.0-1_arm64.deb
sudo systemctl enable --now relay
sudo -u relay relay status -c /etc/relay/config.yaml   # shows the onion address
```

Or by hand with the binary (`relay` built for `aarch64-unknown-linux-gnu`):

```sh
sudo install -m 755 relay /usr/bin/relay
sudo adduser --system --group --home /var/lib/relay --no-create-home relay
sudo install -d -o relay -g relay -m 0700 /var/lib/relay /etc/relay
sudo install -o relay -g relay -m 0600 packaging/config.yaml /etc/relay/config.yaml
sudo -u relay relay init -c /etc/relay/config.yaml
sudo install -m 644 packaging/relay.service /lib/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now relay
```

Connect Enigma to it. Either open its address in **Tor Browser**
(`http://<onion>/`): its page shows a QR code and the same code as text, with
both to download. Or, on the Pi:

```sh
sudo -u relay relay code -c /etc/relay/config.yaml               # the code, and a QR in the terminal
sudo -u relay relay code -c /etc/relay/config.yaml --png qr.png  # …and as an image
```

In Enigma, open **Friends → ⚙ You and your Relay**, scan the QR (camera
button) or paste the code (a bare `.onion` address works too), and Save:
Enigma checks it can reach the Relay first. The address then goes on the
contact cards you show friends, so they know where your mailbox is.

Set `name:` in the config to what the page and the code should call it
(`Alice's Pi`); `page: false` stops serving the page (the API is unaffected).

## Building it

```sh
sudo apt install gcc-aarch64-linux-gnu
rustup target add aarch64-unknown-linux-gnu
cargo build --release -p relay --target aarch64-unknown-linux-gnu
cargo deb -p relay --target aarch64-unknown-linux-gnu --no-build   # the .deb (cargo install cargo-deb)
```

`.cargo/config.toml` sets the linker. The binary is about 14 MB, stripped.

## At rest

Three layers, as in Zirkel:

1. What Enigma leaves here is sealed end to end before it arrives (MLS, or the
   friendship's directory key). Relay cannot read it.
2. Relay seals it again with its master key (`/etc/relay/master.key`,
   mode 0600, refused otherwise), and stores ids and tokens only as keyed
   hashes. The database alone shows how many rows there are and how big.
3. The disk: `relay check` says whether the data folder is on an encrypted
   disk; `serve` warns at every start if not. See
   [disk-encryption.md](disk-encryption.md).

## Backups

```sh
sudo -u relay relay backup -c /etc/relay/config.yaml /var/lib/relay/backup-$(date +%F).sqlite
```

Back up the database and `master.key` separately: one without the other is
useless, and together they are everything. Losing Relay' data loses only
undelivered messages and directory records; friendships live in Enigma.

## Moving or rebuilding

The onion address is arti's key in `/var/lib/relay/tor-state`. Copy that
folder with the database to keep the address; without it the new Relay gets
a new address and friends need the new one (a new contact card).
