use openmls::group::{
    MlsGroupCreateConfig,
    MlsGroupJoinConfig,
    PURE_CIPHERTEXT_WIRE_FORMAT_POLICY,
};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::{MemoryStorage, RustCrypto};
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize, Serialize};
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

pub type RotorResult<T> = Result<T, String>;

/// The one MLS ciphersuite this build of Rotor runs. `CIPHERSUITE_NAME` is
/// derived from it below, so swapping the suite here automatically renames
/// both — the app's build_config.yaml assert compares against the name and
/// fails the build on drift.
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
pub const CIPHERSUITE_NAME: &str = ciphersuite_name(CIPHERSUITE);

const fn ciphersuite_name(cs: Ciphersuite) -> &'static str {
    match cs {
        Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 => {
            "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"
        }
        Ciphersuite::MLS_128_DHKEMP256_AES128GCM_SHA256_P256 => {
            "MLS_128_DHKEMP256_AES128GCM_SHA256_P256"
        }
        Ciphersuite::MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448 => {
            "MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448"
        }
        _ => "UNKNOWN", // extend the map when adopting a new suite
    }
}

fn rotor_err<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

#[derive(Debug)]
pub struct RotorProvider {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl Default for RotorProvider {
    fn default() -> Self {
        Self {
            crypto: RustCrypto::default(),
            storage: MemoryStorage::default(),
        }
    }
}

impl OpenMlsProvider for RotorProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::CryptoProvider {
        &self.crypto
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ExportedRotorState {
    room_slug: String,
    identity: String,
    storage: Vec<u8>,
    signature_keys: Option<Vec<u8>>,
    group_id: Option<Vec<u8>>,
}

pub struct RotorSession {
    room_slug: String,
    identity: String,
    provider: RotorProvider,
    signature_keys: Option<SignatureKeyPair>,
    group_id: Option<GroupId>,
}

impl RotorSession {
    pub fn new(room_slug: String, identity: String) -> RotorResult<Self> {
        Ok(Self {
            room_slug,
            identity,
            provider: RotorProvider::default(),
            signature_keys: None,
            group_id: None,
        })
    }

    pub fn ciphersuite() -> Ciphersuite {
        CIPHERSUITE
    }

    fn fallback_group_id(&self) -> GroupId {
        GroupId::from_slice(self.room_slug.as_bytes())
    }

    fn active_group_id(&self) -> GroupId {
        self.group_id
            .clone()
            .unwrap_or_else(|| self.fallback_group_id())
    }

    fn credential_with_key(&self, signature_keys: &SignatureKeyPair) -> CredentialWithKey {
        let credential = BasicCredential::new(self.identity.as_bytes().to_vec());

        CredentialWithKey {
            credential: credential.into(),
            signature_key: signature_keys.to_public_vec().into(),
        }
    }

    fn create_config() -> MlsGroupCreateConfig {
        MlsGroupCreateConfig::builder()
            .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .ciphersuite(Self::ciphersuite())
            .use_ratchet_tree_extension(true)
            .build()
    }

    fn join_config() -> MlsGroupJoinConfig {
        MlsGroupJoinConfig::builder()
            .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .use_ratchet_tree_extension(true)
            .build()
    }

    fn ensure_signature_keys(&mut self) -> RotorResult<()> {
        if self.signature_keys.is_some() {
            return Ok(());
        }

        let signature_keys =
            SignatureKeyPair::new(Self::ciphersuite().into()).map_err(rotor_err)?;

        signature_keys
            .store(self.provider.storage())
            .map_err(rotor_err)?;

        self.signature_keys = Some(signature_keys);

        Ok(())
    }

    fn load_group(&self) -> RotorResult<MlsGroup> {
        let group_id = self.active_group_id();

        MlsGroup::load(self.provider.storage(), &group_id)
            .map_err(rotor_err)?
            .ok_or_else(|| {
                format!(
                    "session has not joined MLS group {} yet",
                    self.room_slug
                )
            })
    }

    pub fn create_group(&mut self) -> RotorResult<()> {
        self.ensure_signature_keys()?;

        let signature_keys = self
            .signature_keys
            .as_ref()
            .ok_or_else(|| "signing keys are missing after ensure_signature_keys()".to_string())?;

        let credential_with_key = self.credential_with_key(signature_keys);

        let group = MlsGroup::new(
            &self.provider,
            signature_keys,
            &Self::create_config(),
            credential_with_key,
        )
        .map_err(rotor_err)?;

        self.group_id = Some(group.group_id().clone());

        Ok(())
    }

    pub fn add_member(&mut self, key_package_bytes: &[u8]) -> RotorResult<(Vec<u8>, Vec<u8>)> {
        let mut group = self.load_group()?;

        let signature_keys = self
            .signature_keys
            .as_ref()
            .ok_or_else(|| {
                "signing keys are missing; call create_group() before add_member()".to_string()
            })?;

        let key_package_message =
            MlsMessageIn::tls_deserialize_exact(key_package_bytes).map_err(rotor_err)?;

        let key_package_in = match key_package_message.extract() {
            MlsMessageBodyIn::KeyPackage(key_package) => key_package,
            _ => return Err("expected an MLS KeyPackage message".to_string()),
        };

        let key_package = key_package_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(rotor_err)?;

        let key_packages = vec![key_package];

        let (commit, welcome, _group_info) = group
            .add_members(&self.provider, signature_keys, &key_packages)
            .map_err(rotor_err)?;

        group
            .merge_pending_commit(&self.provider)
            .map_err(rotor_err)?;

        self.group_id = Some(group.group_id().clone());

        let welcome_bytes = MlsMessageOut::from(welcome)
            .to_bytes()
            .map_err(rotor_err)?;

        let commit_bytes = commit.to_bytes().map_err(rotor_err)?;

        Ok((welcome_bytes, commit_bytes))
    }

    /// List the device identities of all current MLS group members. This is the
    /// authenticated roster — it reflects exactly who is in the cryptographic group.
    pub fn members(&self) -> RotorResult<Vec<String>> {
        let group = self.load_group()?;
        let mut ids = Vec::new();
        for member in group.members() {
            let basic = BasicCredential::try_from(member.credential).map_err(rotor_err)?;
            ids.push(String::from_utf8_lossy(basic.identity()).to_string());
        }
        Ok(ids)
    }

    /// Remove a member by device identity (admin action). Returns the remove
    /// commit bytes to broadcast so the other members update their group.
    pub fn remove_member(&mut self, identity: &str) -> RotorResult<Vec<u8>> {
        let mut group = self.load_group()?;

        let signature_keys = self
            .signature_keys
            .as_ref()
            .ok_or_else(|| "signing keys are missing; cannot remove a member".to_string())?;

        let target = {
            let mut found = None;
            for member in group.members() {
                let basic = BasicCredential::try_from(member.credential).map_err(rotor_err)?;
                if basic.identity() == identity.as_bytes() {
                    found = Some(member.index);
                    break;
                }
            }
            found.ok_or_else(|| format!("member {identity} not found in group"))?
        };

        let (commit, _welcome, _group_info) = group
            .remove_members(&self.provider, signature_keys, &[target])
            .map_err(rotor_err)?;

        group.merge_pending_commit(&self.provider).map_err(rotor_err)?;
        self.group_id = Some(group.group_id().clone());

        commit.to_bytes().map_err(rotor_err)
    }

    pub fn key_package(&mut self) -> RotorResult<Vec<u8>> {
        let ciphersuite = Self::ciphersuite();

        self.ensure_signature_keys()?;

        let signature_keys = self
            .signature_keys
            .as_ref()
            .ok_or_else(|| "signing keys are missing after ensure_signature_keys()".to_string())?;

        let credential_with_key = self.credential_with_key(signature_keys);

        let key_package_bundle = KeyPackage::builder()
            .build(
                ciphersuite,
                &self.provider,
                signature_keys,
                credential_with_key,
            )
            .map_err(rotor_err)?;

        let key_package = key_package_bundle.key_package().clone();

        let message_out = MlsMessageOut::from(key_package);
        let bytes = message_out.to_bytes().map_err(rotor_err)?;

        Ok(bytes)
    }

    pub fn join_from_welcome(&mut self, welcome_bytes: &[u8]) -> RotorResult<()> {
        let message = MlsMessageIn::tls_deserialize_exact(welcome_bytes).map_err(rotor_err)?;

        let welcome = match message.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err("expected an MLS Welcome message".to_string()),
        };

        let staged_welcome =
            StagedWelcome::new_from_welcome(&self.provider, &Self::join_config(), welcome, None)
                .map_err(rotor_err)?;

        let group = staged_welcome
            .into_group(&self.provider)
            .map_err(rotor_err)?;

        self.group_id = Some(group.group_id().clone());

        Ok(())
    }

    pub fn process_message(&mut self, message_bytes: &[u8]) -> RotorResult<Option<Vec<u8>>> {
        let mut group = self.load_group()?;

        let message = MlsMessageIn::tls_deserialize_exact(message_bytes).map_err(rotor_err)?;

        let protocol_message: ProtocolMessage = message
            .try_into_protocol_message()
            .map_err(|_| "expected an MLS PublicMessage or PrivateMessage".to_string())?;

        let processed_message = group
            .process_message(&self.provider, protocol_message)
            .map_err(rotor_err)?;

        match processed_message.into_content() {
            ProcessedMessageContent::ApplicationMessage(application_message) => {
                Ok(Some(application_message.into_bytes()))
            }

            ProcessedMessageContent::ProposalMessage(proposal)
            | ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.storage(), *proposal)
                    .map_err(rotor_err)?;

                Ok(None)
            }

            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                group
                    .merge_staged_commit(&self.provider, *staged_commit)
                    .map_err(rotor_err)?;

                self.group_id = Some(group.group_id().clone());

                Ok(None)
            }
        }
    }

    pub fn encrypt_app(&mut self, plaintext: &[u8]) -> RotorResult<Vec<u8>> {
        let mut group = self.load_group()?;

        let signature_keys = self
            .signature_keys
            .as_ref()
            .ok_or_else(|| {
                "signing keys are missing; create a key package or group first".to_string()
            })?;

        let message_out = group
            .create_message(&self.provider, signature_keys, plaintext)
            .map_err(rotor_err)?;

        let bytes = message_out.to_bytes().map_err(rotor_err)?;

        Ok(bytes)
    }

    /// Export a symmetric secret from the current MLS epoch (RFC 9420 exporter).
    /// Two members of the same group at the same epoch derive identical bytes for
    /// the same `(label, context, length)` — used to key out-of-band media such as
    /// Vox voice calls without sending every audio frame through MLS itself.
    pub fn export_secret(&self, label: &str, context: &[u8], length: usize) -> RotorResult<Vec<u8>> {
        let group = self.load_group()?;
        group
            .export_secret(self.provider.crypto(), label, context, length)
            .map_err(rotor_err)
    }

    pub fn export_state(&self) -> RotorResult<Vec<u8>> {
        let mut storage = Vec::new();

        self.provider
            .storage
            .serialize(&mut storage)
            .map_err(rotor_err)?;

        let signature_keys = self
            .signature_keys
            .as_ref()
            .map(|keys| keys.tls_serialize_detached().map_err(rotor_err))
            .transpose()?;

        let group_id = self
            .group_id
            .as_ref()
            .map(|id| id.tls_serialize_detached().map_err(rotor_err))
            .transpose()?;

        let bytes = serde_json::to_vec(&ExportedRotorState {
            room_slug: self.room_slug.clone(),
            identity: self.identity.clone(),
            storage,
            signature_keys,
            group_id,
        })
        .map_err(rotor_err)?;

        Ok(bytes)
    }

    pub fn import_state(state_bytes: &[u8]) -> RotorResult<Self> {
        let state: ExportedRotorState = serde_json::from_slice(state_bytes).map_err(rotor_err)?;

        let storage = if state.storage.is_empty() {
            MemoryStorage::default()
        } else {
            MemoryStorage::deserialize(&mut state.storage.as_slice()).map_err(rotor_err)?
        };

        let signature_keys = state
            .signature_keys
            .as_deref()
            .map(SignatureKeyPair::tls_deserialize_exact)
            .transpose()
            .map_err(rotor_err)?;

        let group_id = state
            .group_id
            .as_deref()
            .map(GroupId::tls_deserialize_exact)
            .transpose()
            .map_err(rotor_err)?;

        Ok(Self {
            room_slug: state.room_slug,
            identity: state.identity,
            provider: RotorProvider {
                crypto: RustCrypto::default(),
                storage,
            },
            signature_keys,
            group_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ops::Range;

    /// Two members that join the same 2-member group derive an identical
    /// exporter secret for the same (label, context) — the basis for keying
    /// out-of-band media like Vox.
    #[test]
    fn exported_secret_matches_across_members() {
        let mut admin = RotorSession::new("call-123".into(), "alice".into()).unwrap();
        let mut guest = RotorSession::new("call-123".into(), "bob".into()).unwrap();

        admin.create_group().unwrap();
        let guest_kp = guest.key_package().unwrap();
        let (welcome, _commit) = admin.add_member(&guest_kp).unwrap();
        guest.join_from_welcome(&welcome).unwrap();

        let a = admin.export_secret("enigma/vox/c2s", b"call-123", 32).unwrap();
        let b = guest.export_secret("enigma/vox/c2s", b"call-123", 32).unwrap();
        assert_eq!(a.len(), 32);
        assert_eq!(a, b, "both members derive the same exporter secret");

        // Different labels (per-direction keys) must differ.
        let other = admin.export_secret("enigma/vox/s2c", b"call-123", 32).unwrap();
        assert_ne!(a, other, "different labels yield independent keys");
    }

    /// Two leaves whose identities share a user part ("alice" and
    /// "alice#dev-aaaaaaab") coexist in one group alongside a third member,
    /// all traffic decrypts, and removal by full identity takes out exactly
    /// the addressed leaf — the crypto basis for linked devices.
    #[test]
    fn same_user_second_device_leaf_coexists_and_removes_cleanly() {
        let mut alice = RotorSession::new("room-1".into(), "alice".into()).unwrap();
        let mut dev = RotorSession::new("room-1".into(), "alice#dev-aaaaaaab".into()).unwrap();
        let mut bob = RotorSession::new("room-1".into(), "bob".into()).unwrap();

        alice.create_group().unwrap();
        let dev_kp = dev.key_package().unwrap();
        let (welcome, _commit) = alice.add_member(&dev_kp).unwrap();
        dev.join_from_welcome(&welcome).unwrap();

        let bob_kp = bob.key_package().unwrap();
        let (welcome, commit) = alice.add_member(&bob_kp).unwrap();
        bob.join_from_welcome(&welcome).unwrap();
        assert!(dev.process_message(&commit).unwrap().is_none(), "commit is not app data");

        // Every leaf's app traffic decrypts at every other leaf.
        let ct = alice.encrypt_app(b"from alice").unwrap();
        assert_eq!(dev.process_message(&ct).unwrap().as_deref(), Some(&b"from alice"[..]));
        let ct = alice.encrypt_app(b"from alice 2").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"from alice 2"[..]));
        let ct = dev.encrypt_app(b"from dev").unwrap();
        assert_eq!(alice.process_message(&ct).unwrap().as_deref(), Some(&b"from dev"[..]));
        let ct = dev.encrypt_app(b"from dev 2").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"from dev 2"[..]));
        let ct = bob.encrypt_app(b"from bob").unwrap();
        assert_eq!(alice.process_message(&ct).unwrap().as_deref(), Some(&b"from bob"[..]));

        let mut roster = alice.members().unwrap();
        roster.sort();
        assert_eq!(roster, vec!["alice", "alice#dev-aaaaaaab", "bob"]);

        // Exact-identity removal takes out only the device leaf.
        let commit = alice.remove_member("alice#dev-aaaaaaab").unwrap();
        assert!(bob.process_message(&commit).unwrap().is_none());
        let mut roster = alice.members().unwrap();
        roster.sort();
        assert_eq!(roster, vec!["alice", "bob"]);
        let mut roster = bob.members().unwrap();
        roster.sort();
        assert_eq!(roster, vec!["alice", "bob"]);

        // The surviving pair still converses; the removed leaf is locked out.
        let ct = alice.encrypt_app(b"post-removal").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"post-removal"[..]));
        assert!(dev.process_message(&ct).is_err(), "removed leaf cannot decrypt the new epoch");
    }

    /// `alice` creates `room`, then each guest is added in turn and every
    /// earlier member processes the commit — the order a relay delivers in.
    fn room(slug: &str, guests: &[&str]) -> (RotorSession, Vec<RotorSession>) {
        let mut admin = RotorSession::new(slug.into(), "alice".into()).unwrap();
        admin.create_group().unwrap();
        let mut joined: Vec<RotorSession> = Vec::new();
        for id in guests {
            let mut guest = RotorSession::new(slug.into(), (*id).into()).unwrap();
            let kp = guest.key_package().unwrap();
            let (welcome, commit) = admin.add_member(&kp).unwrap();
            for earlier in joined.iter_mut() {
                assert_eq!(earlier.process_message(&commit).unwrap(), None);
            }
            guest.join_from_welcome(&welcome).unwrap();
            joined.push(guest);
        }
        (admin, joined)
    }

    fn sorted(mut ids: Vec<String>) -> Vec<String> {
        ids.sort();
        ids
    }

    fn wire_format(bytes: &[u8]) -> WireFormat {
        MlsMessageIn::tls_deserialize_exact(bytes).unwrap().wire_format()
    }

    #[test]
    fn the_ciphersuite_name_is_derived_from_the_suite() {
        // The app's build_config.yaml assert compares against this string; a
        // suite that fell through to "UNKNOWN" would fail every build.
        assert_eq!(RotorSession::ciphersuite(), CIPHERSUITE);
        assert_eq!(CIPHERSUITE_NAME, "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519");
    }

    #[test]
    fn a_session_that_has_not_joined_refuses_every_group_operation() {
        // Each of these needs a group; before one exists they must say so,
        // naming the room, rather than act on an empty one.
        let mut s = RotorSession::new("room-x".into(), "alice".into()).unwrap();
        let want = "session has not joined MLS group room-x yet".to_string();
        assert_eq!(s.members().err(), Some(want.clone()));
        assert_eq!(s.encrypt_app(b"hi").err(), Some(want.clone()));
        assert_eq!(s.export_secret("label", b"", 32).err(), Some(want.clone()));
        assert_eq!(s.remove_member("bob").err(), Some(want.clone()));
        assert_eq!(s.process_message(b"\x00").err(), Some(want.clone()));
        assert_eq!(s.add_member(b"\x00").err(), Some(want.clone()));
        // Having signing keys (from a key package) is not having a group.
        s.key_package().unwrap();
        assert_eq!(s.encrypt_app(b"hi").err(), Some(want));
    }

    #[test]
    fn a_new_group_holds_only_its_creator() {
        let (alice, _) = room("room-solo", &[]);
        assert_eq!(alice.members().unwrap(), vec!["alice"]);
    }

    #[test]
    fn two_members_converse_in_both_directions() {
        let (mut alice, mut guests) = room("room-pair", &["bob"]);
        let bob = &mut guests[0];
        for (i, text) in ["one", "two", "three"].iter().enumerate() {
            let ct = alice.encrypt_app(text.as_bytes()).unwrap();
            assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(text.as_bytes()), "a->b {i}");
            let reply = format!("re: {text}");
            let ct = bob.encrypt_app(reply.as_bytes()).unwrap();
            assert_eq!(alice.process_message(&ct).unwrap().as_deref(), Some(reply.as_bytes()), "b->a {i}");
        }
        // An empty message is still a message.
        let ct = alice.encrypt_app(b"").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b""[..]));
        assert_eq!(sorted(bob.members().unwrap()), vec!["alice", "bob"]);
    }

    #[test]
    fn nothing_travels_in_the_clear() {
        // PURE_CIPHERTEXT: application data AND commits go out as
        // PrivateMessages, so a relay learns neither the text nor who was
        // added or removed.
        let (mut alice, mut guests) = room("room-wire", &["bob"]);
        let ct = alice.encrypt_app(b"a very recognisable plaintext").unwrap();
        assert_eq!(wire_format(&ct), WireFormat::PrivateMessage);
        assert!(!ct.windows(12).any(|w| w == b"recognisable"));

        let mut carol = RotorSession::new("room-wire".into(), "carol".into()).unwrap();
        let (welcome, commit) = alice.add_member(&carol.key_package().unwrap()).unwrap();
        assert_eq!(wire_format(&commit), WireFormat::PrivateMessage);
        assert_eq!(wire_format(&welcome), WireFormat::Welcome);
        assert_eq!(guests[0].process_message(&commit).unwrap(), None);
        carol.join_from_welcome(&welcome).unwrap();
        assert_eq!(sorted(carol.members().unwrap()), vec!["alice", "bob", "carol"]);
    }

    #[test]
    fn a_replayed_application_message_is_refused() {
        // Each message key is used once and then deleted; a relay (or anyone
        // on the path) re-sending a message must not make it appear twice.
        let (mut alice, mut guests) = room("room-replay", &["bob"]);
        let bob = &mut guests[0];
        let ct = alice.encrypt_app(b"pay 10").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"pay 10"[..]));
        assert!(bob.process_message(&ct).is_err(), "the second delivery must be refused");
        // And the refusal leaves the session usable.
        let ct = alice.encrypt_app(b"next").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"next"[..]));
    }

    /// Where a PrivateMessage keeps its encrypted sender data and its
    /// ciphertext, walking RFC 9420's framing: version(2) wire_format(2)
    /// group_id<V> epoch(8) content_type(1) authenticated_data<V>
    /// encrypted_sender_data<V> ciphertext<V>, each <V> a varint length and
    /// then the bytes.
    fn private_message_fields(msg: &[u8]) -> (Range<usize>, Range<usize>) {
        fn vl(msg: &[u8], at: &mut usize) -> Range<usize> {
            let len_len = 1usize << (msg[*at] >> 6);
            let mut len = (msg[*at] & 0x3f) as usize;
            for b in &msg[*at + 1..*at + len_len] {
                len = (len << 8) | *b as usize;
            }
            let start = *at + len_len;
            *at = start + len;
            start..*at
        }
        assert_eq!(&msg[..4], &[0, 1, 0, 2], "an MLS 1.0 PrivateMessage");
        let mut at = 4;
        vl(msg, &mut at); // group_id
        at += 8 + 1; // epoch, content_type
        vl(msg, &mut at); // authenticated_data
        let sender = vl(msg, &mut at);
        let ciphertext = vl(msg, &mut at);
        assert_eq!(at, msg.len(), "walked the whole message");
        (sender, ciphertext)
    }

    #[test]
    fn a_tampered_message_is_refused_and_does_not_burn_the_real_one() {
        // A forgery must fail WITHOUT consuming the message key, or anyone on
        // the path could make a real message unreadable by racing a corrupted
        // copy of it ahead.
        //
        // The flips are in the encrypted sender data and in the ciphertext
        // sample its key is derived from. A flip further into the ciphertext
        // (its tag) is refused too in a release build, but openmls 0.7.4
        // `debug_assert!`s on that path, so a debug build panics instead.
        let (mut alice, mut guests) = room("room-tamper", &["bob"]);
        let bob = &mut guests[0];
        let ct = alice.encrypt_app(b"authentic").unwrap();
        let (sender, body) = private_message_fields(&ct);
        for idx in [sender.start, sender.end - 1, body.start] {
            let mut forged = ct.clone();
            forged[idx] ^= 0x01;
            assert!(bob.process_message(&forged).is_err(), "flip at {idx}");
        }
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"authentic"[..]));
    }

    #[test]
    fn a_message_for_another_group_is_refused() {
        // Two rooms with the same members' names: a ciphertext from one must
        // not decrypt in the other.
        let (mut alice_a, _a) = room("room-a", &["bob"]);
        let (_alice_b, mut b) = room("room-b", &["bob"]);
        let ct = alice_a.encrypt_app(b"for room a").unwrap();
        assert!(b[0].process_message(&ct).is_err());
    }

    #[test]
    fn wrong_kinds_of_message_are_refused_by_name() {
        let (mut alice, mut guests) = room("room-kinds", &["bob"]);
        let mut carol = RotorSession::new("room-kinds".into(), "carol".into()).unwrap();
        let kp = carol.key_package().unwrap();
        let ct = alice.encrypt_app(b"x").unwrap();

        // A key package is not a welcome, and an app message is not a key package.
        assert_eq!(carol.join_from_welcome(&kp).err().as_deref(), Some("expected an MLS Welcome message"));
        assert_eq!(alice.add_member(&ct).err().as_deref(), Some("expected an MLS KeyPackage message"));
        // A welcome or a key package is not something a member processes.
        let (welcome, _commit) = alice.add_member(&kp).unwrap();
        for not_protocol in [&welcome, &kp] {
            assert_eq!(
                guests[0].process_message(not_protocol).err().as_deref(),
                Some("expected an MLS PublicMessage or PrivateMessage")
            );
        }
    }

    #[test]
    fn bytes_that_are_not_mls_are_an_error_everywhere() {
        let (mut alice, _) = room("room-junk", &[]);
        let mut stranger = RotorSession::new("room-junk".into(), "eve".into()).unwrap();
        for junk in [&b""[..], b"\x00", b"not an mls message"] {
            assert!(alice.add_member(junk).is_err(), "add {junk:?}");
            assert!(alice.process_message(junk).is_err(), "process {junk:?}");
            assert!(stranger.join_from_welcome(junk).is_err(), "join {junk:?}");
        }
        // A good message with a byte appended is not exactly one message.
        let mut padded = alice.encrypt_app(b"x").unwrap();
        padded.push(0);
        assert!(alice.process_message(&padded).is_err());
        // None of that disturbed the group.
        assert_eq!(alice.members().unwrap(), vec!["alice"]);
    }

    #[test]
    fn a_welcome_is_only_for_the_key_package_it_answers() {
        let (mut alice, _) = room("room-welcome", &[]);
        let mut bob = RotorSession::new("room-welcome".into(), "bob".into()).unwrap();
        let mut eve = RotorSession::new("room-welcome".into(), "eve".into()).unwrap();
        eve.key_package().unwrap();
        let (welcome, _commit) = alice.add_member(&bob.key_package().unwrap()).unwrap();
        assert!(eve.join_from_welcome(&welcome).is_err(), "eve holds no matching key package");
        assert!(eve.members().is_err(), "and a failed join leaves her outside");
        bob.join_from_welcome(&welcome).unwrap();
    }

    #[test]
    fn an_epoch_change_rotates_the_exported_secret_for_everyone() {
        // Vox keys come from the exporter; when the roster changes, the old
        // key must stop being the key — and every member must move together.
        let (mut alice, mut guests) = room("room-epoch", &["bob"]);
        let before = alice.export_secret("enigma/vox/c2s", b"call", 32).unwrap();
        assert_eq!(guests[0].export_secret("enigma/vox/c2s", b"call", 32).unwrap(), before);

        let mut carol = RotorSession::new("room-epoch".into(), "carol".into()).unwrap();
        let (welcome, commit) = alice.add_member(&carol.key_package().unwrap()).unwrap();
        let after = alice.export_secret("enigma/vox/c2s", b"call", 32).unwrap();
        assert_ne!(after, before);

        // Bob is still on the old epoch until he processes the commit.
        assert_eq!(guests[0].export_secret("enigma/vox/c2s", b"call", 32).unwrap(), before);
        guests[0].process_message(&commit).unwrap();
        carol.join_from_welcome(&welcome).unwrap();
        assert_eq!(guests[0].export_secret("enigma/vox/c2s", b"call", 32).unwrap(), after);
        assert_eq!(carol.export_secret("enigma/vox/c2s", b"call", 32).unwrap(), after);
    }

    #[test]
    fn a_member_that_missed_a_commit_cannot_read_the_next_epoch_until_it_catches_up() {
        let (mut alice, mut guests) = room("room-lag", &["bob"]);
        let bob = &mut guests[0];
        let mut carol = RotorSession::new("room-lag".into(), "carol".into()).unwrap();
        let (_welcome, commit) = alice.add_member(&carol.key_package().unwrap()).unwrap();

        let ct = alice.encrypt_app(b"new epoch").unwrap();
        assert!(bob.process_message(&ct).is_err(), "bob is an epoch behind");
        // Delivered late, the commit still applies, and the next message reads.
        bob.process_message(&commit).unwrap();
        let ct = alice.encrypt_app(b"caught up").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"caught up"[..]));
    }

    #[test]
    fn a_message_from_before_a_commit_is_unreadable_after_it() {
        // No past epochs are kept (the join/create config sets none), so the
        // relay must deliver an application message before the commit that
        // follows it — afterwards its key is gone.
        let (mut alice, mut guests) = room("room-order", &["bob"]);
        let old = alice.encrypt_app(b"sent at epoch 1").unwrap();
        let mut carol = RotorSession::new("room-order".into(), "carol".into()).unwrap();
        let (_welcome, commit) = alice.add_member(&carol.key_package().unwrap()).unwrap();
        guests[0].process_message(&commit).unwrap();
        assert!(guests[0].process_message(&old).is_err());
    }

    #[test]
    fn export_secret_is_bound_to_label_context_and_length() {
        let (alice, guests) = room("room-export", &["bob"]);
        let base = alice.export_secret("l", b"ctx", 32).unwrap();
        assert_ne!(alice.export_secret("l", b"ctx2", 32).unwrap(), base, "context matters");
        assert_ne!(alice.export_secret("l2", b"ctx", 32).unwrap(), base, "label matters");
        // A shorter export is a different key, not a prefix of the longer one:
        // a 16-byte key must reveal nothing about a 32-byte one.
        let short = alice.export_secret("l", b"ctx", 16).unwrap();
        assert_eq!(short.len(), 16);
        assert_ne!(&short[..], &base[..16]);
        assert_eq!(guests[0].export_secret("l", b"ctx", 16).unwrap(), short);
        // Same inputs, same epoch: deterministic.
        assert_eq!(alice.export_secret("l", b"ctx", 32).unwrap(), base);
    }

    #[test]
    fn an_export_longer_than_the_kdf_can_produce_is_an_error() {
        // HKDF-SHA256 tops out at 255 * 32 bytes.
        let (alice, _) = room("room-export-max", &[]);
        assert_eq!(alice.export_secret("l", b"", 255 * 32).unwrap().len(), 255 * 32);
        assert!(alice.export_secret("l", b"", 255 * 32 + 1).is_err());
    }

    #[test]
    fn removing_an_unknown_identity_changes_nothing() {
        let (mut alice, guests) = room("room-rm", &["bob"]);
        let secret = alice.export_secret("l", b"", 32).unwrap();
        assert_eq!(alice.remove_member("carol").err().as_deref(), Some("member carol not found in group"));
        // Identities match exactly, not by prefix: "bo" is not "bob".
        assert_eq!(alice.remove_member("bo").err().as_deref(), Some("member bo not found in group"));
        assert_eq!(sorted(alice.members().unwrap()), vec!["alice", "bob"]);
        assert_eq!(alice.export_secret("l", b"", 32).unwrap(), secret, "no new epoch");
        assert_eq!(guests[0].export_secret("l", b"", 32).unwrap(), secret);
    }

    #[test]
    fn a_removed_member_is_cut_off_in_both_directions() {
        let (mut alice, mut guests) = room("room-cut", &["bob", "carol"]);
        let commit = alice.remove_member("carol").unwrap();
        guests[0].process_message(&commit).unwrap();

        // Carol, not yet aware, still writes at the old epoch: nobody reads it.
        let stale = guests[1].encrypt_app(b"still here?").unwrap();
        assert!(alice.process_message(&stale).is_err());
        assert!(guests[0].process_message(&stale).is_err());

        // Once she processes her own removal she cannot send at all.
        assert_eq!(guests[1].process_message(&commit).unwrap(), None);
        assert!(guests[1].encrypt_app(b"let me back in").is_err());
        assert_eq!(sorted(guests[0].members().unwrap()), vec!["alice", "bob"]);
    }

    #[test]
    fn a_key_package_cannot_add_the_same_device_twice() {
        let (mut alice, _) = room("room-dup", &[]);
        let mut bob = RotorSession::new("room-dup".into(), "bob".into()).unwrap();
        let kp = bob.key_package().unwrap();
        alice.add_member(&kp).unwrap();
        assert!(alice.add_member(&kp).is_err(), "the same leaf keys cannot sit in the group twice");
        assert_eq!(sorted(alice.members().unwrap()), vec!["alice", "bob"]);
    }

    #[test]
    fn exported_state_resumes_a_live_member() {
        // What the app does across a restart: export, persist, import. The
        // resumed session must be the same member — same group, same keys,
        // same position in the ratchet — not a stranger with the same name.
        let (mut alice, mut guests) = room("room-persist", &["bob"]);
        let ct = alice.encrypt_app(b"before").unwrap();
        assert_eq!(guests[0].process_message(&ct).unwrap().as_deref(), Some(&b"before"[..]));
        let secret = guests[0].export_secret("l", b"", 32).unwrap();

        let saved = guests[0].export_state().unwrap();
        let mut bob = RotorSession::import_state(&saved).unwrap();
        assert_eq!(sorted(bob.members().unwrap()), vec!["alice", "bob"]);
        assert_eq!(bob.export_secret("l", b"", 32).unwrap(), secret);

        let ct = alice.encrypt_app(b"after").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"after"[..]));
        let ct = bob.encrypt_app(b"resumed").unwrap();
        assert_eq!(alice.process_message(&ct).unwrap().as_deref(), Some(&b"resumed"[..]));
        // The resumed admin keeps admin powers: it still holds the signing key.
        let alice_saved = alice.export_state().unwrap();
        let mut alice2 = RotorSession::import_state(&alice_saved).unwrap();
        let commit = alice2.remove_member("bob").unwrap();
        assert_eq!(bob.process_message(&commit).unwrap(), None);
        assert_eq!(alice2.members().unwrap(), vec!["alice"]);
    }

    #[test]
    fn a_key_package_survives_a_restart_before_the_welcome_arrives() {
        // Bob publishes a key package, the app restarts, and only then does
        // the welcome come back: the private half must have been persisted.
        let (mut alice, _) = room("room-pending", &[]);
        let mut bob = RotorSession::new("room-pending".into(), "bob".into()).unwrap();
        let kp = bob.key_package().unwrap();
        let mut bob = RotorSession::import_state(&bob.export_state().unwrap()).unwrap();
        let (welcome, _commit) = alice.add_member(&kp).unwrap();
        bob.join_from_welcome(&welcome).unwrap();
        let ct = alice.encrypt_app(b"welcome back").unwrap();
        assert_eq!(bob.process_message(&ct).unwrap().as_deref(), Some(&b"welcome back"[..]));
    }

    #[test]
    fn a_fresh_session_round_trips_as_a_fresh_session() {
        let blank = RotorSession::new("room-blank".into(), "dora".into()).unwrap();
        let back = RotorSession::import_state(&blank.export_state().unwrap()).unwrap();
        assert_eq!(back.members().err().as_deref(), Some("session has not joined MLS group room-blank yet"));

        // A state written with no storage at all imports as a blank session too.
        let empty = serde_json::json!({
            "room_slug": "room-empty", "identity": "dora", "storage": [],
            "signature_keys": null, "group_id": null,
        });
        let mut back = RotorSession::import_state(&serde_json::to_vec(&empty).unwrap()).unwrap();
        assert_eq!(back.members().err().as_deref(), Some("session has not joined MLS group room-empty yet"));
        // ... and can still go on to make a group of its own.
        back.create_group().unwrap();
        assert_eq!(back.members().unwrap(), vec!["dora"]);
    }

    #[test]
    fn a_corrupt_saved_state_is_refused() {
        let s = RotorSession::new("room-bad".into(), "erin".into()).unwrap();
        let good: serde_json::Value = serde_json::from_slice(&s.export_state().unwrap()).unwrap();
        assert!(RotorSession::import_state(b"not json").is_err());
        assert!(RotorSession::import_state(b"{}").is_err(), "fields are required");

        let mut truncated_storage = good.clone();
        truncated_storage["storage"] = serde_json::json!([0, 0, 0]);
        assert!(RotorSession::import_state(&serde_json::to_vec(&truncated_storage).unwrap()).is_err());

        let mut bad_keys = good.clone();
        bad_keys["signature_keys"] = serde_json::json!([1, 2, 3]);
        assert!(RotorSession::import_state(&serde_json::to_vec(&bad_keys).unwrap()).is_err());

        // A group id that claims five bytes and carries one.
        let mut bad_group = good;
        bad_group["group_id"] = serde_json::json!([5, 1]);
        assert!(RotorSession::import_state(&serde_json::to_vec(&bad_group).unwrap()).is_err());
    }
}
