//! Enigma27 Combo: Enigma27 (the client) and Pharos Lighthouse (its Beacon) in one window.
//!
//! - **UI**: `ui/combo.slint` inherits Enigma27's `AppWindow` and lays pharos-lighthouse's
//!   `LighthouseView` over the client area; a rail on the left switches sections. Both
//!   apps' window glue (`apps/enigma27/src/glue.rs`, `apps/pharos-lighthouse/src/glue.rs`)
//!   is compiled here again, on this crate's Slint types ([`client`], [`lighthouse`]).
//! - **Lighthouse**: pharos-lighthouse's [`Model`]: a beacon-node `Relay` with the sealed
//!   SQLite queue on its own onion (pharos-tor); friends' phones reach it over Tor.
//! - **Client**: a real Enigma27 [`Session`] whose network is [`Net::Local`] through a
//!   [`RelaySlot`]: it dials the running relay in-process (no Tor hop to itself). When the
//!   Lighthouse is off, dials fail, the client keeps its vault and rooms and shows
//!   [`OFF_NOTICE`]; when it is back, the client re-attaches by itself.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use beacon_node::link::{BoxRead, BoxWrite, Dialer};
use beacon_node::relay::{Directory, Relay};
use beacon_node::BoxFuture;
use enigma27::Host;
use enigma_app::real::Net;
use enigma_app::session::Session;
use enigma_app::vault::{KdfParams, Profiles};
use pharos_lighthouse::model::Model;
use slint::ComponentHandle;

slint::include_modules!();

/// Enigma27's window glue on the combo window.
pub mod client {
    pub use super::{ComboWindow as AppWindow, FileItem, FriendItem, InfoItem, InviteItem, MessageItem, Page, PersonItem, RoomItem, Texts};
    pub use enigma27::{audio, data_url_image, hhmm, now_ms, qr_image, rgb, Host, Shared};
    include!("../../enigma27/src/glue.rs");
}

/// Pharos Lighthouse's window glue on the combo window (the `Lh` global).
pub mod lighthouse {
    pub use super::{ComboWindow as AppWindow, Lh, LhClient, LhLog, LhRoom};
    #[allow(unused_imports)]
    pub use pharos_lighthouse::{load_theme, model, qr_image, save_theme};
    include!("../../pharos-lighthouse/src/glue.rs");
}

/// Shown above the client while the Lighthouse is off.
pub const OFF_NOTICE: &str = "Your Lighthouse is off: your chats stay readable; new messages wait until you turn it on (Lighthouse → Overview).";

/// The running relay (and the runtime it lives on), for the client to dial in-process.
#[derive(Clone, Default)]
pub struct RelaySlot(Arc<Mutex<Option<(Arc<Relay>, tokio::runtime::Handle)>>>);

impl RelaySlot {
    /// Follow the model: its relay while it runs, nothing when it is off.
    pub fn follow(&self, m: &Model) {
        let new = m.relay().map(|r| (r, m.handle()));
        let mut cur = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let same = match (&*cur, &new) {
            (Some((a, _)), Some((b, _))) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        if !same {
            *cur = new;
        }
    }
    /// The relay's onion, while it runs.
    #[must_use]
    pub fn onion(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref().map(|(r, _)| r.onion().to_string())
    }
}

impl Dialer for RelaySlot {
    fn dial(&self, onion: &str) -> BoxFuture<anyhow::Result<(BoxRead, BoxWrite)>> {
        let cur = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let onion = onion.to_string();
        Box::pin(async move {
            let Some((relay, rt)) = cur.filter(|(r, _)| !r.is_stopped()) else { anyhow::bail!("Your Lighthouse is off") };
            // The relay's side of the link runs on the relay's runtime (it outlives the
            // client's), as a Beacon in its own process would.
            let d = Directory::default();
            d.add(&relay);
            let f = Dialer::dial(&d, &onion);
            rt.spawn(f).await.map_err(|e| anyhow::anyhow!("{e}"))?
        })
    }
}

/// The client's network: its own Lighthouse, in-process.
#[must_use]
pub fn local_net(slot: &RelaySlot) -> Net {
    Net::Local(Arc::new(slot.clone()))
}

/// The combo's real client on the profiles under `base`, locked (the gate shows).
///
/// # Errors
/// The vault would not open.
pub fn real_host(base: &Path, slot: &RelaySlot, kdf: KdfParams) -> Result<Host, String> {
    Ok(Host::real(Session::new(Profiles::new(base.to_path_buf()), local_net(slot), kdf)?))
}

/// One step: the slot follows the Lighthouse, the unlocked client makes it Your Beacon,
/// and the off notice is shown or hidden. Returns whether the Lighthouse is on.
pub fn sync(ui: &ComboWindow, m: &mut Model, slot: &RelaySlot, host: &mut Host) -> bool {
    slot.follow(m);
    let on = m.is_on();
    if let (Some(onion), None) = (slot.onion(), host.demo.as_ref()) {
        if let Some(c) = host.core_mut() {
            if c.my_beacon().map(|b| b.onion) != Some(onion.clone()) {
                c.set_my_beacon(Some(&onion));
            }
        }
    }
    let notice = if on { "" } else { OFF_NOTICE };
    if ui.get_notice().as_str() != notice {
        ui.set_notice(notice.into());
    }
    on
}

/// Everything the window drives.
pub struct Combo {
    pub ui: ComboWindow,
    pub host: enigma27::Shared,
    pub model: Rc<RefCell<Model>>,
    pub slot: RelaySlot,
}

impl Combo {
    /// The window on a client host and a Lighthouse model (both glues wired).
    ///
    /// # Errors
    /// From Slint.
    pub fn build(host: Host, model: Model, slot: RelaySlot) -> Result<Self, slint::PlatformError> {
        let (ui, host) = client::build(host)?;
        let model = lighthouse::attach(&ui, model);
        // The client's theme wins (the Lighthouse's saved choice was applied first).
        if let Some(c) = host.borrow().core() {
            client::apply_theme(&ui, c);
        }
        let me = Self { ui, host, model, slot };
        me.step();
        Ok(me)
    }

    /// Sync + one client tick + a Lighthouse refresh.
    pub fn step(&self) -> bool {
        let on = sync(&self.ui, &mut self.model.borrow_mut(), &self.slot, &mut self.host.borrow_mut());
        client::tick(&self.ui, &self.host);
        let snap = self.model.borrow_mut().snapshot();
        lighthouse::refresh(&self.ui, &snap);
        on
    }

    /// Run until the window closes; the Lighthouse stops with it.
    ///
    /// # Errors
    /// From Slint.
    pub fn run(self) -> Result<(), slint::PlatformError> {
        let timer = slint::Timer::default();
        let w = self.ui.as_weak();
        let (host, model, slot) = (self.host.clone(), self.model.clone(), self.slot.clone());
        let mut n = 0u32;
        timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(250), move || {
            let Some(ui) = w.upgrade() else { return };
            sync(&ui, &mut model.borrow_mut(), &slot, &mut host.borrow_mut());
            client::tick(&ui, &host);
            n += 1;
            if n % 4 == 0 {
                let snap = model.borrow_mut().snapshot();
                lighthouse::refresh(&ui, &snap);
            }
        });
        self.ui.run()?;
        self.model.borrow_mut().stop();
        Ok(())
    }
}

/// `$XDG_DATA_HOME/enigma27-combo` (or `~/.local/share/enigma27-combo`): the client's
/// profiles (its own device, apart from a standalone Enigma27 on the same machine).
#[must_use]
pub fn client_dir() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir)
        .join("enigma27-combo")
}

/// `$XDG_CONFIG_HOME/enigma27-combo/lighthouse/config.yaml`: the Lighthouse's config (data
/// and master key beside it).
#[must_use]
pub fn lighthouse_config() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(std::env::temp_dir)
        .join("enigma27-combo")
        .join("lighthouse")
        .join("config.yaml")
}
