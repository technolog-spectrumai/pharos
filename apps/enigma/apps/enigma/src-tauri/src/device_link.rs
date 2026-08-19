// Device-link compatibility helpers. QR device pairing is parked in limbo for
// now; existing linked profiles still need to adopt their stored MLS leaf
// identity at boot and derive hidden devlink room names during unlink/rekey.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{AppConfigState, Sessions};

const NS_DEVICES: &str = "devices";
const SCOPE: &str = "default";
const KEY_LINK: &str = "link";

#[derive(Default)]
pub struct DevLinkState;

#[derive(Default)]
pub struct DevLinkJoin;

#[derive(Serialize, Deserialize)]
struct LinkInfo {
    v: u8,
    #[serde(rename = "linkKey")]
    link_key: String,
    #[serde(rename = "roomName")]
    room_name: String,
    #[serde(rename = "myDeviceId")]
    my_device_id: String,
    #[serde(rename = "myLeafId")]
    my_leaf_id: String,
}

fn read_link_info(app: &AppHandle) -> Option<LinkInfo> {
    let raw = crate::vault::kv_get_raw(app, NS_DEVICES, SCOPE, KEY_LINK)?;
    serde_json::from_str(&raw).ok()
}

/// The hidden device-room name, derived from the link key (unguessable topic).
pub(crate) fn devlink_room_name(link_key: &[u8; 32]) -> String {
    let hash = blake3::derive_key("enigma/devlink/v1/room", link_key);
    format!("devlink-{}", data_encoding::HEXLOWER.encode(&hash))
}

/// Pairing is parked, so there is no active ephemeral endpoint to tear down.
/// The function stays in the shutdown fan-out to keep profile/network/vault
/// teardown call sites simple and harmless.
pub async fn shutdown(_state: &DevLinkState) {}

/// After vault unlock: if this profile is a linked device, adopt its stored
/// leaf identity ("user#dev-xxxxxxxx") as the runtime MLS identity. Returns the
/// adopted leaf id, or None when this profile was never linked.
#[tauri::command]
pub fn devlink_adopt_identity(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    sessions: State<'_, Sessions>,
) -> Result<Option<String>, String> {
    let Some(info) = read_link_info(&app) else { return Ok(None) };
    {
        let mut guard = config.lock().map_err(|e| e.to_string())?;
        if guard.identity == info.my_leaf_id {
            return Ok(Some(info.my_leaf_id));
        }
        guard.identity = info.my_leaf_id.clone();
    }
    if let Ok(mut s) = sessions.lock() {
        s.clear();
    }
    Ok(Some(info.my_leaf_id))
}

/// Derive the hidden room name for a link key (base64). Used by the frontend
/// when it rotates the link key on unlink (N>2 rekey).
#[tauri::command]
pub fn devlink_derive_room(link_key: String) -> Result<String, String> {
    let bytes = data_encoding::BASE64
        .decode(link_key.as_bytes())
        .map_err(|e| format!("invalid link key: {e}"))?;
    let key: [u8; 32] = bytes.try_into().map_err(|_| "link key must be 32 bytes".to_string())?;
    Ok(devlink_room_name(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devlink_room_name_is_stable_and_prefixed() {
        let key = [7u8; 32];
        let a = devlink_room_name(&key);
        assert!(a.starts_with("devlink-"));
        assert_eq!(a, devlink_room_name(&key));
        assert_ne!(a, devlink_room_name(&[8u8; 32]));
    }

    #[test]
    fn derive_room_rejects_bad_key_lengths() {
        let short = data_encoding::BASE64.encode(&[1, 2, 3]);
        assert!(devlink_derive_room(short).is_err());
    }

}
