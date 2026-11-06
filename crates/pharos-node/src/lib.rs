//! Enigma' engine, without the window (Stage 4). Everything a Pharos client
//! does, over any [`Net`]: arti in the app, an in-process network in tests.
//!
//! - **Pairing (D1)**: [`Node::my_card`] shows a signed card; the friend
//!   [`Node::scan_card`]s it, which starts the friendship's MLS group and
//!   gives a reply — left on our Relay if the card names one, otherwise
//!   shown for us to [`Node::accept_reply`]. [`Node::poll_pairings`] picks
//!   replies up from Relay.
//! - **Direct (D2)**: per friend we host this week's rendezvous onion
//!   ([`Node::refresh_listeners`]) and dial theirs ([`Node::deliver`]). Each
//!   message is one frame (MLS ciphertext of a padded envelope); the receiver
//!   answers each with a sealed acknowledgement.
//! - **Offline (4.4)**: without Relay a message waits in the outbox until a
//!   direct delivery works. With the friend's Relay it is left in their
//!   mailbox ([`Status::OnRelay`]); they fetch it ([`Node::fetch_mailboxes`])
//!   and acknowledge, then it is [`Status::Delivered`].
//! - **Directory (D5)**: [`Node::publish_directory`] files a sealed "my
//!   Relay is now X" record on the Relay addresses friends know;
//!   [`Node::lookup`] follows it.
//!
//! State is one serialisable [`State`]; the app saves [`Node::snapshot`] in its
//! vault whenever an [`Event::Changed`] arrives.

pub mod net;
pub mod relay;

use anyhow::{anyhow, bail, Result};
use net::{BoxIo, Listener, Net};
use pharos_id::{ContactCard, DeviceKey, PairReply};
use pharos_rendezvous::{week_of, Fingerprint, FriendshipSecret};
use pharos_seal::{open_labelled, seal_labelled, Friendship, Opened};
use pharos_wire::{read_frame, write_frame, Body, Envelope, MsgId};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

const MLS_GROUP: &str = "pharos";
const DIRECTORY_LABEL: &[u8] = b"pharos/directory/v1";
const ACK_TIMEOUT: Duration = Duration::from_secs(45);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Messages kept per friend (oldest dropped first).
pub const HISTORY_CAP: usize = 500;
/// A shown card that nobody answered is forgotten after this.
const PENDING_TTL: u64 = pharos_id::CARD_TTL_SECS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Status {
    /// Waiting for a direct delivery (or for the friend's Relay to answer).
    Queued,
    /// Left in the friend's Relay mailbox; not yet acknowledged.
    OnRelay,
    /// The friend has it.
    Delivered,
    /// From the friend.
    Received,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: MsgId,
    pub friend: Fingerprint,
    /// Empty for an image.
    pub text: String,
    pub sent_ms: u64,
    pub status: Status,
    /// An image's type and size; its bytes are in the [`Blobs`] store, under the message id.
    pub image: Option<ImageMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageMeta {
    pub mime: String,
    pub bytes: u32,
}

/// Where image bytes live, apart from the state (which is saved whole on every
/// change and must stay small). The app keeps them in its vault; tests and the
/// demo in memory.
pub trait Blobs: Send + Sync {
    fn put(&self, id: &MsgId, data: &[u8]);
    fn get(&self, id: &MsgId) -> Option<Vec<u8>>;
    fn remove(&self, id: &MsgId);
}

#[derive(Default)]
pub struct MemBlobs(Mutex<HashMap<MsgId, Vec<u8>>>);

impl Blobs for MemBlobs {
    fn put(&self, id: &MsgId, data: &[u8]) {
        self.0.lock().unwrap().insert(*id, data.to_vec());
    }
    fn get(&self, id: &MsgId) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(id).cloned()
    }
    fn remove(&self, id: &MsgId) {
        self.0.lock().unwrap().remove(id);
    }
}

/// The saved state before images (format 1, no marker): read and moved on.
mod v1 {
    use super::*;
    #[derive(Serialize, Deserialize)]
    pub struct Message {
        pub id: MsgId,
        pub friend: Fingerprint,
        pub text: String,
        pub sent_ms: u64,
        pub status: Status,
    }
    #[derive(Serialize, Deserialize)]
    pub struct State {
        pub device: [u8; 32],
        pub name: String,
        pub relay: Option<String>,
        pub previous_relay: Vec<String>,
        pub friends: Vec<Friend>,
        pub messages: Vec<Message>,
        pub pending: Vec<Pending>,
    }
}

/// Marks the saved state's format; format 1 had none.
const STATE_V2: &[u8; 4] = b"PHS2";

#[derive(Clone, Serialize, Deserialize)]
pub struct Friend {
    pub fp: Fingerprint,
    pub name: String,
    pub device: [u8; 32],
    secret: [u8; 32],
    mls: Vec<u8>,
    /// Where their mailbox is (from their card or their directory record).
    pub relay: Option<String>,
    pub added_secs: u64,
    pub last_seen_secs: Option<u64>,
    /// How far into our mailbox for them we have read.
    cursor: i64,
    /// Acknowledgements we owe them.
    acks: Vec<MsgId>,
}

impl Friend {
    fn secret(&self) -> FriendshipSecret {
        FriendshipSecret::from_bytes(self.secret)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    token: [u8; 16],
    mls: Vec<u8>,
    created_secs: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct State {
    device: [u8; 32],
    pub name: String,
    /// Our own Relay (optional): our mailbox and pairing drop-off.
    pub relay: Option<String>,
    /// Relay addresses we used before; our directory record is left there too.
    previous_relay: Vec<String>,
    friends: Vec<Friend>,
    messages: Vec<Message>,
    pending: Vec<Pending>,
}

impl State {
    pub fn new(name: &str) -> Self {
        State {
            device: DeviceKey::generate().to_bytes(),
            name: name.to_string(),
            relay: None,
            previous_relay: vec![],
            friends: vec![],
            messages: vec![],
            pending: vec![],
        }
    }
    pub fn from_bytes(b: &[u8]) -> Result<Self> {
        if let Some(rest) = b.strip_prefix(STATE_V2.as_slice()) {
            return Ok(postcard::from_bytes(rest)?);
        }
        // Format 1: the same, without images.
        let o: v1::State = postcard::from_bytes(b)?;
        Ok(State {
            device: o.device,
            name: o.name,
            relay: o.relay,
            previous_relay: o.previous_relay,
            friends: o.friends,
            messages: o
                .messages
                .into_iter()
                .map(|m| Message { id: m.id, friend: m.friend, text: m.text, sent_ms: m.sent_ms, status: m.status, image: None })
                .collect(),
            pending: o.pending,
        })
    }
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = STATE_V2.to_vec();
        out.extend(postcard::to_stdvec(self).expect("state encodes"));
        out
    }
    fn key(&self) -> DeviceKey {
        DeviceKey::from_bytes(&self.device)
    }
    fn me(&self) -> Fingerprint {
        self.key().fingerprint()
    }
    fn friend_mut(&mut self, fp: &Fingerprint) -> Result<&mut Friend> {
        self.friends.iter_mut().find(|f| &f.fp == fp).ok_or_else(|| anyhow!("no such friend"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Something to save.
    Changed,
    Message(Message),
    Status { id: MsgId, status: Status },
    FriendAdded { fp: Fingerprint, name: String },
    FriendMoved { fp: Fingerprint, relay: String },
}

/// What scanning a friend's card did.
#[derive(Debug)]
pub struct Scanned {
    pub friend: Fingerprint,
    pub name: String,
    /// Show this to the friend if it could not be left on their Relay.
    pub reply: Option<String>,
}

/// A friend as the window shows it.
#[derive(Debug, Clone, Serialize)]
pub struct FriendView {
    pub id: String,
    pub name: String,
    pub fingerprint: String,
    pub relay: Option<String>,
    pub last_seen_secs: Option<u64>,
}

pub struct Node<N: Net> {
    inner: Arc<Inner<N>>,
}

impl<N: Net> Clone for Node<N> {
    fn clone(&self) -> Self {
        Node { inner: self.inner.clone() }
    }
}

struct Inner<N> {
    net: N,
    blobs: Arc<dyn Blobs>,
    st: Mutex<State>,
    events: mpsc::UnboundedSender<Event>,
    clock: Clock,
    hosts: Mutex<HashMap<Fingerprint, Hosted>>,
}

struct Hosted {
    week: u64,
    _task: AbortOnDrop,
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Seconds since the Unix epoch (injected so tests can move time).
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(system_secs)
}

pub fn system_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

pub fn hex(b: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(b)
}

/// A Relay to use, from what the person scanned or typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayTarget {
    pub onion: String,
    /// The name its code carries; a bare address has none.
    pub name: Option<String>,
}

/// Read a Relay from a code (`pharos-relay:…`, from its page or `relay
/// code`) or a bare v3 `.onion` address, checksum checked. Empty means none.
pub fn parse_relay(text: &str) -> Result<Option<RelayTarget>> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let prefix = pharos_id::RELAY_PREFIX;
    if t.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix)) {
        let c = pharos_id::RelayCode::from_text(t).map_err(|e| anyhow!("that Relay code does not read: {e}"))?;
        return Ok(Some(RelayTarget { onion: c.onion_address(), name: Some(c.name) }));
    }
    let pk = pharos_rendezvous::parse_onion(t)
        .ok_or_else(|| anyhow!("not a Relay code or a .onion address (a typo fails the address's checksum)"))?;
    Ok(Some(RelayTarget { onion: pharos_rendezvous::onion_address(&pk), name: None }))
}

pub fn parse_fp(s: &str) -> Result<Fingerprint> {
    let v = data_encoding::HEXLOWER_PERMISSIVE.decode(s.as_bytes())?;
    v.try_into().map_err(|_| anyhow!("not a friend id"))
}

#[derive(Serialize, Deserialize)]
struct DirectoryRecord {
    relay: Option<String>,
    at: u64,
}

impl<N: Net> Node<N> {
    /// A node keeping image bytes in memory (tests, the demo).
    pub fn new(state: State, net: N, clock: Clock) -> (Self, mpsc::UnboundedReceiver<Event>) {
        Self::with_blobs(state, net, clock, Arc::new(MemBlobs::default()))
    }

    pub fn with_blobs(state: State, net: N, clock: Clock, blobs: Arc<dyn Blobs>) -> (Self, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let inner = Inner { net, blobs, st: Mutex::new(state), events: tx, clock, hosts: Mutex::default() };
        (Node { inner: Arc::new(inner) }, rx)
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.st.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn now(&self) -> u64 {
        (self.inner.clock)()
    }
    fn emit(&self, e: Event) {
        let _ = self.inner.events.send(e);
    }
    fn changed(&self) {
        self.emit(Event::Changed);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.st().to_bytes()
    }
    pub fn fingerprint(&self) -> Fingerprint {
        self.st().me()
    }
    pub fn fingerprint_words(&self) -> String {
        pharos_id::fingerprint_words(&self.fingerprint())
    }
    pub fn name(&self) -> String {
        self.st().name.clone()
    }
    pub fn relay(&self) -> Option<String> {
        self.st().relay.clone()
    }

    pub fn set_name(&self, name: &str) -> Result<()> {
        let n = name.trim();
        if n.is_empty() || n.chars().count() > 64 {
            bail!("a name is 1 to 64 characters");
        }
        self.st().name = n.to_string();
        self.changed();
        Ok(())
    }

    pub fn friends(&self) -> Vec<FriendView> {
        self.st()
            .friends
            .iter()
            .map(|f| FriendView {
                id: hex(&f.fp),
                name: f.name.clone(),
                fingerprint: pharos_id::fingerprint_words(&f.fp),
                relay: f.relay.clone(),
                last_seen_secs: f.last_seen_secs,
            })
            .collect()
    }

    pub fn messages(&self, friend: &Fingerprint) -> Vec<Message> {
        self.st().messages.iter().filter(|m| &m.friend == friend).cloned().collect()
    }

    pub fn remove_friend(&self, friend: &Fingerprint) {
        {
            let mut st = self.st();
            st.friends.retain(|f| &f.fp != friend);
            for m in st.messages.iter().filter(|m| &m.friend == friend && m.image.is_some()) {
                self.inner.blobs.remove(&m.id);
            }
            st.messages.retain(|m| &m.friend != friend);
        }
        self.inner.hosts.lock().unwrap().remove(friend);
        self.changed();
    }

    /// Use `onion` as our Relay (checked first), or none.
    pub async fn set_relay(&self, onion: Option<String>) -> Result<()> {
        if let Some(o) = &onion {
            relay::health(&self.inner.net, o).await?;
        }
        {
            let mut st = self.st();
            if let Some(old) = st.relay.take() {
                if Some(&old) != onion.as_ref() && !st.previous_relay.contains(&old) {
                    st.previous_relay.push(old);
                }
            }
            st.relay = onion;
        }
        self.changed();
        let _ = self.publish_directory().await;
        Ok(())
    }

    // ── pairing (D1) ──────────────────────────────────────────────────────────

    /// A fresh card to show. Each card carries its own MLS key package and
    /// one-time token; an unanswered card is forgotten after a week.
    pub fn my_card(&self) -> Result<String> {
        let now = self.now();
        let mut st = self.st();
        let key = st.key();
        let mut f = Friendship::new(MLS_GROUP, &key.mls_identity())?;
        let kp = f.key_package()?;
        let token = random::<16>();
        let card = ContactCard::new(&key, &st.name, kp, st.relay.clone(), token, now)?;
        st.pending.retain(|p| now.saturating_sub(p.created_secs) < PENDING_TTL);
        st.pending.push(Pending { token, mls: f.export_state()?, created_secs: now });
        drop(st);
        self.changed();
        Ok(card.to_text())
    }

    /// Scan a friend's card: start the friendship and answer it.
    pub async fn scan_card(&self, text: &str) -> Result<Scanned> {
        let now = self.now();
        let card = ContactCard::from_text(text, now)?;
        let (reply, fp, name) = {
            let mut st = self.st();
            let fp = card.fingerprint();
            if fp == st.me() {
                bail!("this is your own card");
            }
            if st.friends.iter().any(|f| f.fp == fp) {
                bail!("{} is already a friend", card.body.name);
            }
            let key = st.key();
            let mut f = Friendship::new(MLS_GROUP, &key.mls_identity())?;
            let welcome = f.start(&card.body.key_package)?;
            let secret = *f.friendship_secret()?.as_bytes();
            st.friends.push(Friend {
                fp,
                name: card.body.name.clone(),
                device: card.body.device,
                secret,
                mls: f.export_state()?,
                relay: card.body.relay.clone(),
                added_secs: now,
                last_seen_secs: None,
                cursor: 0,
                acks: vec![],
            });
            let mine = ContactCard::new(&key, &st.name, vec![], st.relay.clone(), [0; 16], now)?;
            (PairReply::new(&key, mine, &card, welcome), fp, card.body.name.clone())
        };
        self.changed();
        self.emit(Event::FriendAdded { fp, name: name.clone() });
        let mut shown = Some(reply.to_text());
        if let Some(p) = &card.body.relay {
            if relay::put_pairing(&self.inner.net, p, &card.body.pairing_token, reply.to_bytes()).await.is_ok() {
                shown = None;
            }
        }
        Ok(Scanned { friend: fp, name, reply: shown })
    }

    /// Take a friend's reply to one of our cards (typed or scanned).
    pub fn accept_reply(&self, text: &str) -> Result<Fingerprint> {
        let me = self.fingerprint();
        let r = PairReply::from_text(text, &me, self.now())?;
        self.accept(r)
    }

    fn accept(&self, r: PairReply) -> Result<Fingerprint> {
        let now = self.now();
        let card = &r.body.card;
        let fp = card.fingerprint();
        let mut st = self.st();
        if st.friends.iter().any(|f| f.fp == fp) {
            bail!("{} is already a friend", card.body.name);
        }
        // The welcome opens only for the key package it was made for.
        let mut found = None;
        for (i, p) in st.pending.iter().enumerate() {
            let mut f = Friendship::import_state(&p.mls)?;
            if f.join(&r.body.welcome).is_ok() {
                found = Some((i, f));
                break;
            }
        }
        let (i, f) = found.ok_or_else(|| anyhow!("this reply answers none of the cards you showed"))?;
        st.pending.remove(i);
        st.friends.push(Friend {
            fp,
            name: card.body.name.clone(),
            device: card.body.device,
            secret: *f.friendship_secret()?.as_bytes(),
            mls: f.export_state()?,
            relay: card.body.relay.clone(),
            added_secs: now,
            last_seen_secs: None,
            cursor: 0,
            acks: vec![],
        });
        let name = card.body.name.clone();
        drop(st);
        self.changed();
        self.emit(Event::FriendAdded { fp, name });
        Ok(fp)
    }

    /// Replies friends left on our Relay.
    pub async fn poll_pairings(&self) -> Result<Vec<Fingerprint>> {
        let (relay, tokens, me) = {
            let st = self.st();
            (st.relay.clone(), st.pending.iter().map(|p| p.token).collect::<Vec<_>>(), st.me())
        };
        let Some(p) = relay else { return Ok(vec![]) };
        let mut added = vec![];
        for t in tokens {
            if let Some(bytes) = relay::take_pairing(&self.inner.net, &p, &t).await? {
                let r = PairReply::from_bytes(&bytes, &me, self.now())?;
                added.push(self.accept(r)?);
            }
        }
        Ok(added)
    }

    // ── messages ──────────────────────────────────────────────────────────────

    /// Queue a message and try to deliver it now.
    pub async fn send(&self, friend: &Fingerprint, text: &str) -> Result<MsgId> {
        let id = self.queue(friend, text)?;
        let _ = self.deliver(friend).await;
        Ok(id)
    }

    /// Queue without delivering (the app delivers in the background).
    pub fn queue(&self, friend: &Fingerprint, text: &str) -> Result<MsgId> {
        let id = random::<16>();
        let env = Envelope::text(id, self.now() * 1000, text)?;
        let Body::Text(t) = env.body else { unreachable!() };
        let msg = Message { id, friend: *friend, text: t, sent_ms: env.sent_ms, status: Status::Queued, image: None };
        {
            let mut st = self.st();
            st.friend_mut(friend)?;
            push_capped(&mut st.messages, msg.clone(), &*self.inner.blobs);
        }
        self.changed();
        self.emit(Event::Message(msg));
        Ok(id)
    }

    /// Queue a small image (WebP, JPEG or PNG, at most `MAX_IMAGE_BYTES`), sent
    /// whole like a text. The window shrinks a picture to fit first.
    pub fn queue_image(&self, friend: &Fingerprint, mime: &str, data: Vec<u8>) -> Result<MsgId> {
        let id = random::<16>();
        let env = Envelope::image(id, self.now() * 1000, mime, data)?;
        let Body::Image { mime, data } = env.body else { unreachable!() };
        let msg = Message {
            id,
            friend: *friend,
            text: String::new(),
            sent_ms: env.sent_ms,
            status: Status::Queued,
            image: Some(ImageMeta { mime, bytes: data.len() as u32 }),
        };
        {
            let mut st = self.st();
            st.friend_mut(friend)?;
            self.inner.blobs.put(&id, &data);
            push_capped(&mut st.messages, msg.clone(), &*self.inner.blobs);
        }
        self.changed();
        self.emit(Event::Message(msg));
        Ok(id)
    }

    /// Queue and try to deliver now.
    pub async fn send_image(&self, friend: &Fingerprint, mime: &str, data: Vec<u8>) -> Result<MsgId> {
        let id = self.queue_image(friend, mime, data)?;
        let _ = self.deliver(friend).await;
        Ok(id)
    }

    /// An image message's type and bytes.
    pub fn image(&self, id: &MsgId) -> Option<(String, Vec<u8>)> {
        let mime = self.st().messages.iter().find(|m| &m.id == id)?.image.as_ref()?.mime.clone();
        Some((mime, self.inner.blobs.get(id)?))
    }

    /// The envelope that carries a queued message.
    fn envelope_of(&self, m: &Message) -> Result<Envelope> {
        match &m.image {
            None => Ok(Envelope::text(m.id, m.sent_ms, &m.text)?),
            Some(img) => {
                let data = self.inner.blobs.get(&m.id).ok_or_else(|| anyhow!("the image's bytes are gone"))?;
                Ok(Envelope::image(m.id, m.sent_ms, &img.mime, data)?)
            }
        }
    }

    fn set_status(&self, id: &MsgId, status: Status) {
        let mut hit = false;
        {
            let mut st = self.st();
            if let Some(m) = st.messages.iter_mut().find(|m| &m.id == id && m.status != Status::Received) {
                if m.status != status && m.status != Status::Delivered {
                    m.status = status;
                    hit = true;
                }
            }
        }
        if hit {
            self.changed();
            self.emit(Event::Status { id: *id, status });
        }
    }

    /// Seal one envelope for `friend`, saving the advanced MLS state.
    fn seal(&self, friend: &Fingerprint, env: &Envelope) -> Result<Vec<u8>> {
        let mut st = self.st();
        let fr = st.friend_mut(friend)?;
        let mut f = Friendship::import_state(&fr.mls)?;
        let ct = f.seal(env)?;
        fr.mls = f.export_state()?;
        Ok(ct)
    }

    fn open(&self, friend: &Fingerprint, ct: &[u8]) -> Result<Opened> {
        let mut st = self.st();
        let now = (self.inner.clock)();
        let fr = st.friend_mut(friend)?;
        let mut f = Friendship::import_state(&fr.mls)?;
        let o = f.open(ct)?;
        fr.mls = f.export_state()?;
        fr.last_seen_secs = Some(now);
        Ok(o)
    }

    /// Handle an opened envelope; returns the id to acknowledge, if any.
    fn handle(&self, friend: &Fingerprint, env: Envelope) -> Option<MsgId> {
        match env.body {
            Body::Text(_) | Body::Image { .. } => {
                let (text, image) = match env.body {
                    Body::Text(t) => (t, None),
                    Body::Image { mime, data } => {
                        self.inner.blobs.put(&env.id, &data);
                        (String::new(), Some(ImageMeta { mime, bytes: data.len() as u32 }))
                    }
                    _ => unreachable!(),
                };
                let msg = Message { id: env.id, friend: *friend, text, sent_ms: env.sent_ms, status: Status::Received, image };
                let new = {
                    let mut st = self.st();
                    let dup = st.messages.iter().any(|m| m.id == msg.id && &m.friend == friend);
                    if !dup {
                        push_capped(&mut st.messages, msg.clone(), &*self.inner.blobs);
                    }
                    !dup
                };
                if new {
                    self.emit(Event::Message(msg));
                }
                self.changed();
                Some(env.id)
            }
            Body::Ack(ids) => {
                for id in ids {
                    self.set_status(&id, Status::Delivered);
                }
                None
            }
            Body::Mls(_) | Body::Ping => None,
        }
    }

    /// Deliver what is queued for `friend`: directly if they answer on their
    /// rendezvous onion, else into their Relay mailbox if they have one.
    pub async fn deliver(&self, friend: &Fingerprint) -> Result<()> {
        let (queued, acks, candidates, their_relay) = {
            let st = self.st();
            let fr = st.friends.iter().find(|f| &f.fp == friend).ok_or_else(|| anyhow!("no such friend"))?;
            let queued: Vec<Message> =
                st.messages.iter().filter(|m| &m.friend == friend && m.status == Status::Queued).cloned().collect();
            (queued, fr.acks.clone(), fr.secret().dial_candidates(friend, self.now()), fr.relay.clone())
        };
        if queued.is_empty() && acks.is_empty() {
            return Ok(());
        }
        // Direct first.
        for onion in &candidates {
            let Ok(io) = self.inner.net.dial(onion).await else { continue };
            return self.send_direct(friend, io, &queued, &acks).await;
        }
        // Then their Relay.
        let Some(p) = their_relay else { bail!("not reachable now; it stays in the outbox") };
        let (id, token) = {
            let st = self.st();
            let s = st.friends.iter().find(|f| &f.fp == friend).unwrap().secret();
            (s.mailbox_id(friend), s.mailbox_token(friend))
        };
        if !acks.is_empty() {
            let env = Envelope::new(random(), self.now() * 1000, Body::Ack(acks.clone()));
            relay::put_message(&self.inner.net, &p, &id, &token, self.seal(friend, &env)?).await?;
            self.drop_acks(friend, &acks);
        }
        for m in &queued {
            let env = self.envelope_of(m)?;
            relay::put_message(&self.inner.net, &p, &id, &token, self.seal(friend, &env)?).await?;
            self.set_status(&m.id, Status::OnRelay);
        }
        Ok(())
    }

    fn drop_acks(&self, friend: &Fingerprint, sent: &[MsgId]) {
        if let Ok(fr) = self.st().friend_mut(friend) {
            fr.acks.retain(|a| !sent.contains(a));
        }
        self.changed();
    }

    async fn send_direct(&self, friend: &Fingerprint, mut io: BoxIo, queued: &[Message], acks: &[MsgId]) -> Result<()> {
        if !acks.is_empty() {
            let env = Envelope::new(random(), self.now() * 1000, Body::Ack(acks.to_vec()));
            write_frame(&mut io, &self.seal(friend, &env)?).await?;
            self.drop_acks(friend, acks);
        }
        for m in queued {
            let env = self.envelope_of(m)?;
            write_frame(&mut io, &self.seal(friend, &env)?).await?;
            let reply = tokio::time::timeout(ACK_TIMEOUT, read_frame(&mut io)).await.map_err(|_| anyhow!("no acknowledgement"))??;
            if let Opened::Message(e) = self.open(friend, &reply)? {
                self.handle(friend, e);
            }
        }
        Ok(())
    }

    /// Deliver to every friend with something queued.
    pub async fn deliver_all(&self) {
        let fps: Vec<Fingerprint> = self.st().friends.iter().map(|f| f.fp).collect();
        for fp in fps {
            let _ = self.deliver(&fp).await;
        }
    }

    // ── listening (D2) ────────────────────────────────────────────────────────

    /// Host this week's rendezvous onion for every friend (and drop last week's).
    pub async fn refresh_listeners(&self) -> Result<()> {
        let week = week_of(self.now());
        let me = self.fingerprint();
        let friends: Vec<(Fingerprint, FriendshipSecret)> = self.st().friends.iter().map(|f| (f.fp, f.secret())).collect();
        for (fp, secret) in friends {
            if self.inner.hosts.lock().unwrap().get(&fp).is_some_and(|h| h.week == week) {
                continue;
            }
            let key = secret.rendezvous(&me, week);
            let nick = format!("rv{}", &hex(&fp)[..12]);
            let listener = self.inner.net.host(&nick, key.expanded_secret(), &key.onion_address()).await?;
            let task = tokio::spawn(self.clone().serve(fp, listener));
            self.inner.hosts.lock().unwrap().insert(fp, Hosted { week, _task: AbortOnDrop(task) });
        }
        Ok(())
    }

    /// The onions this node hosts right now (tests and diagnostics).
    pub fn debug_rendezvous_onions(&self) -> Vec<String> {
        let me = self.fingerprint();
        let week = week_of(self.now());
        self.st().friends.iter().map(|f| f.secret().rendezvous(&me, week).onion_address()).collect()
    }

    /// Stop hosting (going offline, or locking the vault).
    pub fn stop_listeners(&self) {
        self.inner.hosts.lock().unwrap().clear();
    }

    async fn serve(self, friend: Fingerprint, mut l: Listener) {
        let _guard = l.guard;
        while let Some(io) = l.incoming.recv().await {
            let me = self.clone();
            tokio::spawn(async move {
                let _ = me.serve_conn(friend, io).await;
            });
        }
    }

    async fn serve_conn(&self, friend: Fingerprint, mut io: BoxIo) -> Result<()> {
        loop {
            let ct = match tokio::time::timeout(IDLE_TIMEOUT, read_frame(&mut io)).await {
                Ok(Ok(ct)) => ct,
                _ => return Ok(()),
            };
            // A frame that does not open (a replay, a stranger) ends the connection.
            let Opened::Message(env) = self.open(&friend, &ct)? else { continue };
            if let Some(id) = self.handle(&friend, env) {
                let ack = Envelope::new(random(), self.now() * 1000, Body::Ack(vec![id]));
                write_frame(&mut io, &self.seal(&friend, &ack)?).await?;
            }
        }
    }

    // ── Relay mailbox (M3) ──────────────────────────────────────────────────

    /// Fetch what friends left in our mailboxes, acknowledge it to Relay, and
    /// queue acknowledgements for the friends.
    pub async fn fetch_mailboxes(&self) -> Result<usize> {
        let (relay, me, friends) = {
            let st = self.st();
            (st.relay.clone(), st.me(), st.friends.iter().map(|f| (f.fp, f.secret(), f.cursor)).collect::<Vec<_>>())
        };
        let Some(p) = relay else { return Ok(0) };
        let mut got = 0;
        for (fp, secret, cursor) in friends {
            let (id, token) = (secret.mailbox_id(&me), secret.mailbox_token(&me));
            let items = relay::fetch(&self.inner.net, &p, &id, &token, cursor).await?;
            let Some(last) = items.last().map(|(s, _)| *s) else { continue };
            for (_, blob) in items {
                if let Ok(Opened::Message(env)) = self.open(&fp, &blob) {
                    if let Some(ack) = self.handle(&fp, env) {
                        got += 1;
                        if let Ok(fr) = self.st().friend_mut(&fp) {
                            fr.acks.push(ack);
                        }
                    }
                }
            }
            if let Ok(fr) = self.st().friend_mut(&fp) {
                fr.cursor = last;
            }
            self.changed();
            relay::ack(&self.inner.net, &p, &id, &token, last).await?;
        }
        Ok(got)
    }

    // ── directory (D5) ────────────────────────────────────────────────────────

    /// Leave a sealed "my Relay is X" record for each friend, on our current
    /// Relay and on those we used before (where friends will look).
    pub async fn publish_directory(&self) -> Result<()> {
        let (me, current, mut targets, friends) = {
            let st = self.st();
            let mut t = st.previous_relay.clone();
            t.extend(st.relay.clone());
            (st.me(), st.relay.clone(), t, st.friends.iter().map(|f| f.secret()).collect::<Vec<_>>())
        };
        targets.dedup();
        let week = week_of(self.now());
        let rec = serde_json::to_vec(&DirectoryRecord { relay: current, at: self.now() })?;
        for p in &targets {
            for s in &friends {
                let sealed = seal_labelled(&s.directory_key(&me), DIRECTORY_LABEL, &rec);
                for w in [week, week + 1] {
                    relay::put_record(&self.inner.net, p, &s.directory_id(&me, w), &s.directory_token(&me), sealed.clone()).await?;
                }
            }
        }
        Ok(())
    }

    /// Ask the friend's (last known) Relay whether they moved; follow it.
    pub async fn lookup(&self, friend: &Fingerprint) -> Result<Option<String>> {
        let (p, s) = {
            let st = self.st();
            let f = st.friends.iter().find(|f| &f.fp == friend).ok_or_else(|| anyhow!("no such friend"))?;
            (f.relay.clone(), f.secret())
        };
        let Some(p) = p else { return Ok(None) };
        let week = week_of(self.now());
        for w in [week, week.saturating_sub(1)] {
            let Some(blob) = relay::get_record(&self.inner.net, &p, &s.directory_id(friend, w)).await? else { continue };
            let plain = open_labelled(&s.directory_key(friend), DIRECTORY_LABEL, &blob)?;
            let rec: DirectoryRecord = serde_json::from_slice(&plain)?;
            if let Some(newp) = rec.relay.clone() {
                if newp != p {
                    self.st().friend_mut(friend)?.relay = Some(newp.clone());
                    self.changed();
                    self.emit(Event::FriendMoved { fp: *friend, relay: newp });
                }
            }
            return Ok(rec.relay);
        }
        Ok(None)
    }

    /// One round of background work: listeners, pairings, mailbox, outbox.
    pub async fn tick(&self) {
        let _ = self.refresh_listeners().await;
        let _ = self.poll_pairings().await;
        let _ = self.fetch_mailboxes().await;
        self.deliver_all().await;
    }
}

/// Add a message, dropping the friend's oldest past [`HISTORY_CAP`] (and its
/// image's bytes).
fn push_capped(v: &mut Vec<Message>, m: Message, blobs: &dyn Blobs) {
    let f = m.friend;
    v.push(m);
    let n = v.iter().filter(|x| x.friend == f).count();
    if n > HISTORY_CAP {
        if let Some(i) = v.iter().position(|x| x.friend == f) {
            let old = v.remove(i);
            if old.image.is_some() {
                blobs.remove(&old.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relay_is_read_from_its_code_or_its_address() {
        let onion = pharos_rendezvous::onion_address(&[4u8; 32]);
        let code = pharos_id::RelayCode::new(&onion, "Pi").unwrap().to_text();
        let want = |name: Option<&str>| Some(RelayTarget { onion: onion.clone(), name: name.map(String::from) });
        assert_eq!(parse_relay(&code).unwrap(), want(Some("Pi")));
        assert_eq!(parse_relay(&format!(" {} ", code.to_uppercase())).unwrap(), want(Some("Pi")));
        assert_eq!(parse_relay(&onion).unwrap(), want(None));
        assert_eq!(parse_relay(&onion.to_uppercase()).unwrap(), want(None));
        assert_eq!(parse_relay(onion.trim_end_matches(".onion")).unwrap(), want(None));
        assert_eq!(parse_relay("  ").unwrap(), None, "empty: no Relay");
        let mut typo = onion.clone().into_bytes();
        typo[0] = if typo[0] == b'a' { b'b' } else { b'a' };
        assert!(parse_relay(std::str::from_utf8(&typo).unwrap()).unwrap_err().to_string().contains("checksum"));
        assert!(parse_relay("pharos-relay:XYZ").is_err());
        assert!(parse_relay("pharos-card:AAAA").is_err());
        assert!(parse_relay("ąę").is_err(), "non-ASCII input does not panic");
    }

    #[test]
    fn a_state_saved_before_images_is_read_and_moved_on() {
        let old = v1::State {
            device: [1; 32],
            name: "Alice".into(),
            relay: Some("x.onion".into()),
            previous_relay: vec![],
            friends: vec![],
            messages: vec![v1::Message { id: [2; 16], friend: [3; 16], text: "hi".into(), sent_ms: 5, status: Status::Delivered }],
            pending: vec![],
        };
        let bytes = postcard::to_stdvec(&old).unwrap();
        let s = State::from_bytes(&bytes).unwrap();
        assert_eq!((s.name.as_str(), s.relay.as_deref()), ("Alice", Some("x.onion")));
        assert_eq!(s.messages[0].text, "hi");
        assert_eq!(s.messages[0].image, None);
        // Saved again, it is the new format, and reads back the same.
        let again = s.to_bytes();
        assert!(again.starts_with(STATE_V2));
        assert_eq!(State::from_bytes(&again).unwrap().messages, s.messages);
    }
}
