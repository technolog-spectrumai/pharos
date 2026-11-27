//! What the engine shows the UI: messages, roster rows, statuses, notices, events.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The room's encryption state (`MlsStatus` in TS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MlsStatus {
    /// No room, or not started.
    Idle,
    /// Starting (or taking up an invitation's session).
    Initializing,
    /// Our key package is out; waiting for a group.
    KeyExchange,
    /// Encrypted: sending is allowed.
    Ready,
    /// A step failed; reopening retries.
    Error,
}

/// A room's link state (`WsStatus` in TS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    /// Before the room's onion is up.
    Connecting,
    /// At least one other member is linked.
    Connected,
    /// Nobody else is linked.
    Waiting,
    /// The room is closed.
    Disconnected,
    /// The transport failed.
    Error,
}

/// A translatable system notice: the catalog key, the English text (params filled in),
/// and the params for a translator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notice {
    /// i18n key (`chat.sys.*`, rakotis' `i18n/chatText.ts` catalog).
    pub key: String,
    /// The English fallback with the params filled in.
    pub text: String,
    /// `{name}` parameters.
    pub params: Vec<(String, String)>,
    /// An error notice (`system_error`) rather than information.
    pub error: bool,
}

impl Notice {
    /// A notice from its key, English template and params.
    #[must_use]
    pub fn new(key: &str, fallback: &str, params: &[(&str, &str)], error: bool) -> Self {
        let mut text = fallback.to_string();
        for (k, v) in params {
            text = text.replace(&format!("{{{k}}}"), v);
        }
        Self { key: key.into(), text, params: params.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(), error }
    }
}

/// What a timeline row is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// A text (TS `mls_app`).
    Text,
    /// An image (data URL in `image_data`).
    Image,
    /// A voice message (data URL in `audio_data`).
    Voice,
    /// A map share from an older build: a card saying it cannot be shown.
    MapShare(String),
    /// "arrived before encryption was ready" (never persisted).
    Placeholder,
    /// A system notice (`notice` is set).
    System,
}

/// One timeline row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    /// Sender-minted id (inside the encryption): the dedupe key.
    pub id: String,
    /// What it is.
    pub kind: MessageKind,
    /// The sender's display name ("System" for notices).
    pub user: String,
    /// The sender's device id, when known.
    pub device_id: Option<String>,
    /// Text (empty for media).
    pub content: String,
    /// An image's data URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_data: Option<String>,
    /// A voice message's data URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_data: Option<String>,
    /// Ours (or our device's).
    pub is_self: bool,
    /// It came sealed.
    pub encrypted: bool,
    /// When (ms since the epoch).
    pub ts: u64,
    /// It came through the Beacon mailbox.
    #[serde(default)]
    pub via_mailbox: bool,
    /// The notice, for a system row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<Notice>,
}

impl Message {
    /// Whether a person wrote it (what the log keeps).
    #[must_use]
    pub fn is_human(&self) -> bool {
        !matches!(self.kind, MessageKind::System | MessageKind::Placeholder)
    }
}

/// One roster row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Participant {
    /// The member's device id (MLS identity).
    pub id: String,
    /// From its presence, else `Member xxxxxx` for a 64-hex id.
    pub name: String,
    /// Avatar data URL ("" = none).
    pub avatar: String,
    /// Its onion is linked to us right now.
    pub linked: bool,
    /// This device.
    pub is_self: bool,
}

/// A room this device belongs to (`P2pRoomEntry`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomEntry {
    /// The slug.
    pub room: String,
    /// The name.
    pub name: String,
    /// The other members' onions, as last learned.
    #[serde(default)]
    pub peers: Vec<String>,
    /// We created it.
    #[serde(default)]
    pub host: bool,
    /// Our onion for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onion: Option<String>,
    /// The room's Beacon onion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beacon: Option<String>,
}

/// What an inviter hands a redeemer (`admitInvited`'s result).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    /// The Welcome, base64.
    pub welcome: String,
    /// The room's name.
    pub room_name: String,
    /// Members' onions to link to, the inviter's first.
    pub peers: Vec<String>,
}

/// What the UI consumes ([`crate::Engine::drain_events`]).
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// A row was appended to the timeline (notices come as [`Event::Notice`]).
    MessageAdded(Message),
    /// A system notice was appended to the timeline.
    Notice(Notice),
    /// The timeline was replaced (room change, reset, restore): re-read `messages()`.
    TimelineReset,
    /// The roster changed.
    RosterChanged(Vec<Participant>),
    /// The encryption state changed.
    MlsStatusChanged(MlsStatus),
    /// The link state changed.
    LinkStatusChanged(LinkStatus),
    /// The saved rooms changed.
    RoomsChanged,
    /// The current room changed (`None`: no room open).
    RoomChanged(Option<String>),
    /// The host deleted the room; it was wiped here.
    RoomClosed(String),
    /// A control family the engine does not render (`sync_`, `file_` (file_offer/file_accept),
    /// `meeting_`, `vox_`, `dlink_`, `plink_`): for the app's handlers.
    Sync {
        /// The inner type.
        kind: String,
        /// The inner payload.
        payload: Value,
        /// The sender's name.
        sender: String,
    },
    /// An action failed (TS `error`).
    Error(String),
}
