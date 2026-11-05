# Putting Proteus' data on an encrypted disk

(Adapted from Zirkelite's guide.) Proteus seals everything it stores with its
master key, but on a Pi the key usually sits on the same SD card as the data.
Whoever takes the card takes both — unless the card is encrypted. Proteus
cannot do that for you; it checks and says so:

```
$ proteus check -c /etc/proteus/config.yaml
disk: the data folder is NOT on an encrypted disk (mmcblk0p2, mounted at /): …
```

- **Encrypted**: the data folder's filesystem is on dm-crypt (LUKS or plain),
  directly or under device-mapper layers such as LVM.
- **Not encrypted**: on a disk or partition with no dm-crypt layer.
- **Unknown**: no block device to look at (tmpfs, overlay, a network share, ZFS).

## A USB disk or a second partition (LUKS2)

The device's contents are destroyed. Replace `/dev/sdX` (`lsblk` lists them).

```sh
sudo apt install cryptsetup
sudo cryptsetup luksFormat --type luks2 /dev/sdX
sudo cryptsetup open /dev/sdX proteus-data
sudo mkfs.ext4 /dev/mapper/proteus-data
sudo mount /dev/mapper/proteus-data /var/lib/proteus
sudo chown proteus:proteus /var/lib/proteus && sudo chmod 700 /var/lib/proteus
```

On a Pi without AES instructions (Pi 3, 4, Zero 2 W), Adiantum is much faster
than AES: `sudo cryptsetup luksFormat --type luks2 --cipher xchacha12,aes-adiantum-plain64 /dev/sdX`.
The Pi 5 has AES and can use the default.

Move the master key onto the encrypted disk too, and point `master_key:` at it
(e.g. `/var/lib/proteus/master.key`; the service can already read its data folder).

### Unlocking at boot

- **Typed at boot** (a keyboard or serial console): in `/etc/crypttab`
  `proteus-data UUID=<uuid> none luks`, and in `/etc/fstab`
  `/dev/mapper/proteus-data /var/lib/proteus ext4 defaults,nofail 0 2`.
- **Unattended** with a key file on a second USB stick you keep apart from the
  Pi: `proteus-data UUID=<uuid> /dev/disk/by-label/KEY:/proteus.key luks`.
  A Pi has no TPM; a key file next to the disk protects nothing.

`proteus.service` has `RequiresMountsFor=/var/lib/proteus`, so it waits for the mount.

## The whole SD card

Raspberry Pi OS does not offer full-disk encryption at install. It can be
done (an initramfs with cryptsetup, unlocking over SSH with dropbear), but it
is more work than a separate data disk and is out of scope here.
