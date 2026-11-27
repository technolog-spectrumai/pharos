//! The lock gate around the app: which profile, its vault (create a passphrase / unlock /
//! PIN), the [`Core`] while unlocked, the idle auto-lock and lock-on-hide, profile
//! switching. A front end shows the Welcome screen while [`Session::gate`] is not
//! [`Gate::Open`], and the app (`core()`) when it is.

use protasius::KdfParams;

use crate::core::Core;
use crate::real::{Net, RealBackend};
use crate::vault::{Idle, IdleLock, Opened, Profiles, Vault};

/// Idle lock default (minutes), as the Tauri build_config.
pub const IDLE_DEFAULT_MINS: u64 = 15;

/// What the front end shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// First run of this profile: choose a passphrase.
    Create,
    /// Locked: passphrase (or PIN, when enrolled).
    Unlock,
    /// The app.
    Open,
}

/// One profile's session.
pub struct Session {
    profiles: Profiles,
    net: Net,
    kdf: KdfParams,
    vault: Vault,
    core: Option<Core>,
    idle: IdleLock,
    /// Last error (wrong passphrase, ...), for the gate.
    pub error: String,
}

impl Session {
    /// The active profile under `profiles`, locked.
    ///
    /// # Errors
    /// The store would not open.
    pub fn new(profiles: Profiles, net: Net, kdf: KdfParams) -> Result<Self, String> {
        let vault = Vault::open(&profiles, &profiles.active(), kdf.clone())?;
        Ok(Self { profiles, net, kdf, vault, core: None, idle: IdleLock::new(0, 0), error: String::new() })
    }

    /// Where we are.
    #[must_use]
    pub fn gate(&self) -> Gate {
        if self.core.is_some() {
            Gate::Open
        } else if self.vault.exists() {
            Gate::Unlock
        } else {
            Gate::Create
        }
    }

    /// The vault.
    #[must_use]
    pub fn vault(&self) -> &Vault {
        &self.vault
    }
    /// The profiles.
    #[must_use]
    pub fn profiles(&self) -> &Profiles {
        &self.profiles
    }
    /// The app, while open.
    #[must_use]
    pub fn core(&self) -> Option<&Core> {
        self.core.as_ref()
    }
    /// The app, while open.
    pub fn core_mut(&mut self) -> Option<&mut Core> {
        self.core.as_mut()
    }

    fn open(&mut self, now_ms: u64) -> Result<(), String> {
        let name = self.vault.setting("nickname").or_else(|| self.vault.tauri_nickname()).unwrap_or_else(|| "Me".into());
        let b = RealBackend::new(self.vault.clone(), self.net.clone())?;
        self.core = Some(Core::new(Box::new(b), &name));
        self.idle = IdleLock::new(self.idle_mins(), now_ms);
        self.error.clear();
        if !self.profiles.base.join("enigma-slint.json").exists() {
            let _ = self.profiles.set_active(&self.vault.profile().to_string());
        }
        Ok(())
    }

    /// First run: create the vault with `passphrase` (twice, to catch a typo) and open.
    ///
    /// # Errors
    /// Mismatch, too short, or the store's.
    pub fn create(&mut self, passphrase: &str, again: &str, now_ms: u64) -> Result<(), String> {
        let r = (|| {
            if passphrase != again {
                return Err("the two passphrases differ".to_string());
            }
            if passphrase.chars().count() < 8 {
                return Err("use at least 8 characters".to_string());
            }
            self.vault.create(passphrase)?;
            self.open(now_ms)
        })();
        self.err(r)
    }

    fn err<T>(&mut self, r: Result<T, String>) -> Result<T, String> {
        if let Err(e) = &r {
            self.error.clone_from(e);
        }
        r
    }

    fn opened(&mut self, r: Result<Opened, String>, now_ms: u64) -> Result<(), String> {
        let r = r.and_then(|_| self.open(now_ms));
        self.err(r)
    }

    /// Unlock (the panic code wipes and opens an empty app, indistinguishably).
    ///
    /// # Errors
    /// Wrong passphrase.
    pub fn unlock(&mut self, passphrase: &str, now_ms: u64) -> Result<(), String> {
        let r = self.vault.unlock(passphrase);
        self.opened(r, now_ms)
    }

    /// Unlock with the PIN.
    ///
    /// # Errors
    /// Wrong PIN.
    pub fn pin_unlock(&mut self, pin: &str, now_ms: u64) -> Result<(), String> {
        let r = self.vault.pin_unlock(pin);
        self.opened(r, now_ms)
    }

    /// Lock now: the app (its client link) stops, the key leaves memory.
    pub fn lock(&mut self) {
        self.core = None;
        self.vault.lock();
    }

    /// Idle minutes (setting `idle_lock_mins`, as the Tauri app; 0 = never).
    #[must_use]
    pub fn idle_mins(&self) -> u64 {
        if !self.vault.is_unlocked() {
            return IDLE_DEFAULT_MINS;
        }
        self.vault.setting("idle_lock_mins").and_then(|s| s.parse().ok()).unwrap_or(IDLE_DEFAULT_MINS)
    }
    /// Set them (0..=120).
    pub fn set_idle_mins(&mut self, mins: u64, now_ms: u64) {
        let m = mins.min(120);
        self.vault.set_setting("idle_lock_mins", &m.to_string());
        self.idle = IdleLock::new(m, now_ms);
    }
    /// Lock when the window is hidden / minimised.
    #[must_use]
    pub fn lock_on_hide(&self) -> bool {
        self.vault.is_unlocked() && self.vault.setting("lock_on_hide").as_deref() == Some("1")
    }
    /// Set it.
    pub fn set_lock_on_hide(&mut self, on: bool) {
        self.vault.set_setting("lock_on_hide", if on { "1" } else { "0" });
    }

    /// User activity.
    pub fn touch(&mut self, now_ms: u64) {
        self.idle.touch(now_ms);
    }

    /// Time passes: the app ticks; the idle lock and lock-on-hide may lock. Returns the
    /// idle state (for the warning).
    pub fn tick(&mut self, now_ms: u64, viewing: bool, hidden: bool) -> Idle {
        let Some(c) = self.core.as_mut() else { return Idle::Active };
        c.tick(viewing);
        if hidden && self.lock_on_hide() {
            self.lock();
            return Idle::Lock;
        }
        let s = self.idle.state(now_ms);
        if s == Idle::Lock {
            self.lock();
        }
        s
    }

    /// Switch to (or create) another profile: this one locks first; the PIN is forgotten.
    ///
    /// # Errors
    /// A bad name, or the store's.
    pub fn switch_profile(&mut self, name: &str) -> Result<(), String> {
        self.lock();
        self.vault.pin_clear();
        self.profiles.set_active(name)?;
        self.vault = Vault::open(&self.profiles, &self.profiles.active(), self.kdf.clone())?;
        self.error.clear();
        Ok(())
    }

    /// Change the passphrase (twice, to catch a typo).
    ///
    /// # Errors
    /// Wrong current one, mismatch, too short.
    pub fn change_passphrase(&mut self, current: &str, new: &str, again: &str) -> Result<(), String> {
        let r = if new != again {
            Err("the two passphrases differ".to_string())
        } else if new.chars().count() < 8 {
            Err("use at least 8 characters".to_string())
        } else {
            self.vault.change_passphrase(current, new)
        };
        self.err(r)
    }

    /// Whether this profile came from the Tauri app (its vault is there but this app has
    /// never chosen a profile): the lock screen says so; the passphrase is the same.
    #[must_use]
    pub fn from_tauri(&self) -> bool {
        self.vault.exists() && !self.profiles.base.join("enigma-slint.json").exists()
    }

    /// The app leaves the session (a front end that runs it on its own, e.g. the console);
    /// [`Session::lock`] still locks the vault.
    pub fn take_core(&mut self) -> Option<Core> {
        self.core.take()
    }

    /// Erase this profile (danger zone): everything in it, back to Create.
    ///
    /// # Errors
    /// The store's.
    pub fn erase_profile(&mut self) -> Result<(), String> {
        self.core = None;
        self.vault.erase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::test_kdf;
    use beacon_node::relay::Directory;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("enigma-session-{}", hex::encode(rand_bytes())));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn rand_bytes() -> [u8; 8] {
        use rand_core::RngCore;
        let mut b = [0u8; 8];
        rand_core::OsRng.fill_bytes(&mut b);
        b
    }

    #[test]
    fn gate_create_lock_unlock_idle_and_hide() {
        let base = tmp();
        let mut s = Session::new(Profiles::new(base.clone()), Net::Test(std::sync::Arc::new(Directory::default())), test_kdf()).unwrap();
        assert_eq!(s.gate(), Gate::Create);
        assert!(s.create("password1", "password2", 0).is_err());
        assert!(s.create("short", "short", 0).is_err());
        s.create("password1", "password1", 0).unwrap();
        assert_eq!(s.gate(), Gate::Open);
        s.core_mut().unwrap().set_user_name("Zed");
        s.set_idle_mins(1, 0);
        assert_eq!(s.tick(41_000, true, false), Idle::Warn(19));
        s.touch(41_000);
        assert_eq!(s.tick(42_000, true, false), Idle::Active);
        assert_eq!(s.tick(101_000, true, false), Idle::Lock);
        assert_eq!(s.gate(), Gate::Unlock);
        assert!(s.unlock("nope", 0).is_err());
        assert_eq!(s.error, "wrong passphrase");
        s.unlock("password1", 200_000).unwrap();
        assert_eq!(s.core().unwrap().user_name, "Zed", "the nickname is kept in the vault");
        s.set_lock_on_hide(true);
        s.tick(200_100, true, true);
        assert_eq!(s.gate(), Gate::Unlock);
        s.switch_profile("work").unwrap();
        assert_eq!(s.gate(), Gate::Create);
        assert_eq!(s.profiles().active(), "work");
        s.switch_profile("default").unwrap();
        assert_eq!(s.gate(), Gate::Unlock);
        s.unlock("password1", 0).unwrap();
        s.erase_profile().unwrap();
        assert_eq!(s.gate(), Gate::Create);
        let _ = std::fs::remove_dir_all(base);
    }
}
