//! Binding an iroh endpoint the way every Belisario app needs it.
//!
//! Two decisions are the app's and stay parameters here:
//!
//! - **Relays.** [`Relays::Hosted`] keeps iroh's n0 relays and pkarr/DNS
//!   discovery, so a bare endpoint id is dialable from anywhere. [`Relays::None`]
//!   is direct QUIC only — no third-party server ever sees the endpoint — and
//!   needs a full address (an [`EndpointAddr`]) to dial.
//! - **Identity.** A stable secret gives a stable endpoint id, the durable
//!   handle a contact keeps for reconnecting; an ephemeral one (the default)
//!   avoids linking one transfer to the next. Where a stable secret is stored
//!   is the app's business: ferrozine takes the 32 bytes and never persists them.

use iroh::address_lookup::memory::MemoryLookup;
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey};

use crate::error::{Error, Result};

/// Whether the endpoint uses third-party relays and discovery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relays {
    /// iroh's n0 relays and pkarr/DNS discovery.
    Hosted,
    /// Direct QUIC only.
    None,
}

/// How to bind an endpoint.
#[derive(Clone, Debug)]
pub struct EndpointConfig {
    /// Relay policy.
    pub relays: Relays,
    /// The endpoint's secret key; `None` for a fresh, ephemeral identity.
    pub secret: Option<[u8; 32]>,
    /// ALPNs the endpoint accepts without a [`Router`](iroh::protocol::Router)
    /// (a router registers its own).
    pub alpns: Vec<Vec<u8>>,
    /// A self-hosted relay used instead of n0's (with [`Relays::Hosted`]; discovery stays
    /// n0's). `None`: n0's relays.
    pub relay_url: Option<String>,
}

impl EndpointConfig {
    /// An ephemeral endpoint with the given relay policy.
    pub fn ephemeral(relays: Relays) -> Self {
        Self {
            relays,
            secret: None,
            alpns: Vec::new(),
            relay_url: None,
        }
    }

    /// An endpoint with a stable identity.
    pub fn stable(relays: Relays, secret: [u8; 32]) -> Self {
        Self {
            relays,
            secret: Some(secret),
            alpns: Vec::new(),
            relay_url: None,
        }
    }
}

/// A bound endpoint and the in-memory address book that lets it dial peers
/// whose addresses arrived out of band (a QR code, an invitation, an offer).
#[derive(Clone, Debug)]
pub struct Node {
    /// The endpoint.
    pub endpoint: Endpoint,
    /// Addresses learned out of band; see [`Node::learn`].
    pub lookup: MemoryLookup,
}

impl Node {
    /// Bind an endpoint.
    pub async fn bind(config: EndpointConfig) -> Result<Self> {
        let lookup = MemoryLookup::new();
        let mut builder = match config.relays {
            Relays::Hosted => {
                let mode = match config.relay_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
                    Some(url) => {
                        let url: iroh::RelayUrl = url
                            .parse()
                            .map_err(|e| Error::Bind(format!("relay URL {url}: {e}")))?;
                        RelayMode::Custom(iroh::RelayMap::from(url))
                    }
                    None => RelayMode::Default,
                };
                Endpoint::builder(presets::N0).relay_mode(mode)
            }
            Relays::None => Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled),
        };
        if let Some(secret) = config.secret {
            builder = builder.secret_key(SecretKey::from_bytes(&secret));
        }
        if !config.alpns.is_empty() {
            builder = builder.alpns(config.alpns);
        }
        let endpoint = builder
            .address_lookup(lookup.clone())
            .bind()
            .await
            .map_err(|e| Error::Bind(e.to_string()))?;
        Ok(Self { endpoint, lookup })
    }

    /// Remember `addr`, so a later dial by its endpoint id alone resolves.
    pub fn learn(&self, addr: EndpointAddr) {
        self.lookup.add_endpoint_info(addr);
    }

    /// This endpoint's dialable address, as text ([`crate::addr::encode`]).
    pub fn addr_text(&self) -> String {
        crate::addr::encode(&self.endpoint.addr())
    }
}

/// A fresh random secret key, for an app to store and pass back as
/// [`EndpointConfig::secret`].
pub fn generate_secret() -> [u8; 32] {
    SecretKey::generate().to_bytes()
}
