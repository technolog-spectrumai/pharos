//! The DHT, in a build WITHOUT the `dht` feature.
//!
//! lib.rs mounts this file as `p2p_dht` when the feature is off. The real
//! module (p2p_dht.rs), the `mainline` crate and iroh's pkarr-DHT lookup are
//! then not compiled at all, and the `dht_*` commands do not exist.
//!
//! What is here is the handful of names the iroh node (p2p_iroh.rs) reaches
//! for, in the shape it already handles for "discovery is off": the toggle
//! reads false, and there is never a DHT handle. `DhtHandle` and `AsyncDht`
//! are uninhabited — a value of either cannot exist, so everything that would
//! take one is unreachable by construction rather than by a runtime check.
//! Keeping the node on one code path is the point: it is the same path a
//! `dht` build takes with the user's toggle off, which is the tested one.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use iroh::EndpointId;
use tauri::AppHandle;

/// There is no DHT in this build, so discovery is never on.
pub fn discovery_enabled(_app: &AppHandle) -> bool {
    false
}

/// No rendezvous without a DHT, so no room has a secret to serve joiners with.
pub fn load_room_secret(_app: &AppHandle, _room_id: &str) -> Option<[u8; 32]> {
    None
}

/// Stands in for `mainline::async_dht::AsyncDht`. Cannot be constructed.
pub enum AsyncDht {}

/// Stands in for the Mainline node handle. Cannot be constructed.
#[derive(Clone)]
pub enum DhtHandle {}

impl DhtHandle {
    pub fn new() -> Result<Self> {
        Err(anyhow!("the DHT is not part of this build"))
    }

    pub fn clone_dht(&self) -> AsyncDht {
        match *self {}
    }

    pub async fn resolve_room_peers(
        &self,
        _secret: &[u8; 32],
        _exclude: Option<EndpointId>,
    ) -> Vec<EndpointId> {
        match *self {}
    }
}

pub fn spawn_nick_publisher(
    _app: AppHandle,
    dht: AsyncDht,
    _self_id: EndpointId,
) -> tauri::async_runtime::JoinHandle<()> {
    match dht {}
}

pub fn spawn_room_publisher(
    _app: AppHandle,
    dht: AsyncDht,
    _secret: [u8; 32],
    _self_id: EndpointId,
    _neighbors: Arc<Mutex<HashSet<EndpointId>>>,
) -> tauri::async_runtime::JoinHandle<()> {
    match dht {}
}
