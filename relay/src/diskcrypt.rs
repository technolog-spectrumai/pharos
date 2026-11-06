//! 3.7: is the data folder on an encrypted disk? (From Zirkelite's src/diskcrypt.rs.)
//!
//! Relay seals what it stores with its master key, but the key often sits on
//! the same disk, so the disk itself should be encrypted too. Relay
//! cannot encrypt it; it can say when it is not. `relay check` prints
//! the verdict and `serve` logs a warning for anything but "encrypted".
//!
//! Linux only: the folder's filesystem is found in `/proc/self/mountinfo`
//! (the longest mount point that contains it), and its block device in
//! `/sys/dev/block/<major:minor>`. A device-mapper device whose `dm/uuid`
//! begins `CRYPT-` is dm-crypt (LUKS, plain); the devices under it
//! (`slaves/`) are followed too, so LVM on LUKS counts. Anything else on a
//! block device is "not encrypted"; a filesystem without a block device
//! (tmpfs, overlay, a network share, ZFS) is "unknown". See
//! docs/disk-encryption.md for setting one up.

use std::fs;
use std::path::{Path, PathBuf};

/// What was found out about the folder's disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// On dm-crypt (directly, or under device-mapper layers such as LVM).
    Encrypted { mount: PathBuf, device: String },
    /// On a block device with no dm-crypt layer.
    NotEncrypted { mount: PathBuf, device: String },
    /// No block device to look at, or nothing to read (not Linux).
    Unknown { reason: String },
}

impl Verdict {
    /// One line for `check` and the log.
    pub fn describe(&self) -> String {
        match self {
            Verdict::Encrypted { mount, device } => format!(
                "the data folder is on an encrypted disk ({device}, mounted at {})",
                mount.display()
            ),
            Verdict::NotEncrypted { mount, device } => format!(
                "the data folder is NOT on an encrypted disk ({device}, mounted at {}): a stolen \
                 disk gives away what is not sealed; see docs/disk-encryption.md",
                mount.display()
            ),
            Verdict::Unknown { reason } => format!(
                "whether the data folder's disk is encrypted is unknown ({reason}); see \
                 docs/disk-encryption.md"
            ),
        }
    }

    pub fn is_encrypted(&self) -> bool {
        matches!(self, Verdict::Encrypted { .. })
    }
}

/// The verdict for `folder` on this machine.
pub fn check(folder: &Path) -> Verdict {
    check_in(folder, Path::new("/proc/self/mountinfo"), Path::new("/sys"))
}

/// The verdict with the mount table and sysfs read from elsewhere (tests).
pub fn check_in(folder: &Path, mountinfo: &Path, sys: &Path) -> Verdict {
    let folder = match fs::canonicalize(folder) {
        Ok(p) => p,
        Err(e) => {
            return Verdict::Unknown {
                reason: format!("{}: {e}", folder.display()),
            }
        }
    };
    let table = match fs::read_to_string(mountinfo) {
        Ok(t) => t,
        Err(_) => {
            return Verdict::Unknown {
                reason: "no mount table to read (not Linux?)".into(),
            }
        }
    };
    let Some(mount) = mount_of(&folder, &table) else {
        return Verdict::Unknown {
            reason: "the folder is in no listed mount".into(),
        };
    };
    let block = sys.join("dev/block").join(&mount.dev);
    if !block.exists() {
        return Verdict::Unknown {
            reason: format!(
                "{} is a {} filesystem with no block device to look at",
                mount.point.display(),
                mount.fstype
            ),
        };
    }
    let device = fs::canonicalize(&block)
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| mount.dev.clone());
    if crypt_below(&block, 0) {
        Verdict::Encrypted {
            mount: mount.point,
            device,
        }
    } else {
        Verdict::NotEncrypted {
            mount: mount.point,
            device,
        }
    }
}

struct Mount {
    dev: String,
    point: PathBuf,
    fstype: String,
}

/// The mount that holds `folder`: the longest mount point it is under.
fn mount_of(folder: &Path, table: &str) -> Option<Mount> {
    let mut best: Option<Mount> = None;
    for line in table.lines() {
        // id parent major:minor root mount-point options [optional...] - fstype source super
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let fields: Vec<&str> = left.split(' ').collect();
        if fields.len() < 5 {
            continue;
        }
        let point = PathBuf::from(unescape(fields[4]));
        if !folder.starts_with(&point) {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|b| point.as_os_str().len() >= b.point.as_os_str().len())
        {
            best = Some(Mount {
                dev: fields[2].to_string(),
                point,
                fstype: right.split(' ').next().unwrap_or("").to_string(),
            });
        }
    }
    best
}

/// mountinfo writes a space, tab, newline and backslash as octal escapes.
fn unescape(s: &str) -> String {
    let mut out = String::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 4 <= b.len() {
            if let Ok(n) = u8::from_str_radix(&s[i + 1..i + 4], 8) {
                out.push(n as char);
                i += 4;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

/// Is `device` (a sysfs block directory) dm-crypt, or built on one?
fn crypt_below(device: &Path, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    let uuid = fs::read_to_string(device.join("dm/uuid")).unwrap_or_default();
    if uuid.starts_with("CRYPT-") {
        return true;
    }
    // A partition's parent is the disk; dm devices list what they sit on.
    let Ok(slaves) = fs::read_dir(device.join("slaves")) else {
        return false;
    };
    slaves.flatten().any(|s| crypt_below(&s.path(), depth + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake /sys and mount table: `/data` on dm-1 (LVM) on dm-0
    /// (LUKS) on sda2; `/plain` on sdb1; `/run` a tmpfs.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sys = root.join("sys");
        let block = sys.join("dev/block");
        fs::create_dir_all(&block).unwrap();
        let devices = sys.join("devices");
        let make = |name: &str, uuid: Option<&str>, slaves: &[&str]| {
            let d = devices.join(name);
            fs::create_dir_all(d.join("slaves")).unwrap();
            if let Some(u) = uuid {
                fs::create_dir_all(d.join("dm")).unwrap();
                fs::write(d.join("dm/uuid"), u).unwrap();
            }
            for s in slaves {
                std::os::unix::fs::symlink(devices.join(s), d.join("slaves").join(s)).unwrap();
            }
            d
        };
        let sda2 = make("sda2", None, &[]);
        let dm0 = make("dm-0", Some("CRYPT-LUKS2-abc-luks"), &["sda2"]);
        let dm1 = make("dm-1", Some("LVM-xyz"), &["dm-0"]);
        let sdb1 = make("sdb1", None, &[]);
        let _ = sda2;
        std::os::unix::fs::symlink(&dm1, block.join("253:1")).unwrap();
        std::os::unix::fs::symlink(&dm0, block.join("253:0")).unwrap();
        std::os::unix::fs::symlink(&sdb1, block.join("8:17")).unwrap();
        for p in ["data/relay", "plain/relay", "run/z", "with space/z"] {
            fs::create_dir_all(root.join(p)).unwrap();
        }
        let r = root.display();
        let table = format!(
            "1 0 8:2 / / rw - ext4 /dev/sda2 rw\n\
             2 1 253:1 / {r}/data rw shared:1 - ext4 /dev/mapper/vg-data rw\n\
             3 1 8:17 / {r}/plain rw - xfs /dev/sdb1 rw\n\
             4 1 0:25 / {r}/run rw - tmpfs tmpfs rw\n\
             5 1 253:0 / {r}/with\\040space rw - ext4 /dev/mapper/luks rw\n"
        );
        let mountinfo = root.join("mountinfo");
        fs::write(&mountinfo, table).unwrap();
        (dir, mountinfo, sys)
    }

    #[test]
    fn luks_under_lvm_is_encrypted() {
        let (dir, mi, sys) = fixture();
        let v = check_in(&dir.path().join("data/relay"), &mi, &sys);
        assert!(v.is_encrypted(), "{v:?}");
        assert!(v.describe().contains("encrypted disk (dm-1"));
    }

    #[test]
    fn a_plain_partition_is_not() {
        let (dir, mi, sys) = fixture();
        let v = check_in(&dir.path().join("plain/relay"), &mi, &sys);
        assert!(
            matches!(v, Verdict::NotEncrypted { ref device, .. } if device == "sdb1"),
            "{v:?}"
        );
        assert!(v.describe().contains("NOT on an encrypted disk"));
    }

    #[test]
    fn tmpfs_and_missing_folders_are_unknown() {
        let (dir, mi, sys) = fixture();
        let v = check_in(&dir.path().join("run/z"), &mi, &sys);
        assert!(
            matches!(v, Verdict::Unknown { ref reason } if reason.contains("tmpfs")),
            "{v:?}"
        );
        let v = check_in(&dir.path().join("no/such"), &mi, &sys);
        assert!(matches!(v, Verdict::Unknown { .. }));
        let v = check_in(dir.path(), &dir.path().join("no-mountinfo"), &sys);
        assert!(matches!(v, Verdict::Unknown { ref reason } if reason.contains("mount table")));
    }

    #[test]
    fn an_escaped_mount_point_is_read() {
        let (dir, mi, sys) = fixture();
        let v = check_in(&dir.path().join("with space/z"), &mi, &sys);
        assert!(v.is_encrypted(), "{v:?}");
    }

    #[test]
    fn this_machine_answers_something() {
        let v = check(Path::new("/"));
        assert!(!v.describe().is_empty());
    }
}
