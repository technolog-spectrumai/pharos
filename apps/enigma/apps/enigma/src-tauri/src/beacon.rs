//! Beacon — client for the faros server's expiring location shares (`/beacon/…`).
//!
//! Server contract: the faros repo's `for_enigma.md`. One live pin per user
//! (publishing again moves it), zones (polygons) and routes (linestrings),
//! each with a MANDATORY publisher-chosen expiry; the server returns only
//! unexpired shares and requires the Enigma Cloud login. All transport,
//! session and 401 handling comes from cloud.rs (`request_json`) — beacon
//! adds no network policy of its own. There is no dedicated build switch:
//! beacon needs the cloud client AND the Maps tab, so it derives from both
//! flags (`ensure_beacon_enabled`).
//!
//! Commands return the server JSON as-is; the frontend re-validates every
//! item through rakotis `beaconModel` (wire objects are untrusted there,
//! exactly like MLS payloads).

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::cloud;

/// Returned by every beacon command in a build without cloud or without maps.
pub(crate) const BEACON_DISABLED: &str = "Beacon is disabled in this build.";

fn ensure_beacon_enabled() -> Result<(), String> {
    if !crate::build_config::cloud::ALLOW_CONNECTIONS || !crate::build_config::maps::ENABLED {
        return Err(BEACON_DISABLED.to_string());
    }
    Ok(())
}

// ── Pure helpers (unit-tested below) ─────────────────────────────────────────

/// Percent-encode one query value (RFC 3986 unreserved bytes kept verbatim).
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn validate_lat_lng(lat: f64, lng: f64) -> Result<(), String> {
    if !lat.is_finite() || !(-90.0..=90.0).contains(&lat) {
        return Err("latitude out of range".to_string());
    }
    if !lng.is_finite() || !(-180.0..=180.0).contains(&lng) {
        return Err("longitude out of range".to_string());
    }
    Ok(())
}

fn validate_ttl(ttl_seconds: u32) -> Result<(), String> {
    if ttl_seconds == 0 {
        return Err("ttl_seconds must be positive".to_string());
    }
    Ok(())
}

/// [lat, lng] waypoints → GeoJSON positions ([lng, lat] order).
fn positions(points: &[(f64, f64)]) -> Result<Vec<Value>, String> {
    points
        .iter()
        .map(|&(lat, lng)| {
            validate_lat_lng(lat, lng)?;
            Ok(json!([lng, lat]))
        })
        .collect()
}

/// GeoJSON Polygon coordinates from [lat, lng] corners: one outer ring, the
/// closing duplicate appended here (the map UI works with open corner lists).
fn polygon_coordinates(points: &[(f64, f64)]) -> Result<Value, String> {
    if points.len() < 3 {
        return Err("a zone needs at least 3 points".to_string());
    }
    let mut ring = positions(points)?;
    ring.push(ring[0].clone());
    Ok(json!([ring]))
}

/// GeoJSON LineString coordinates from [lat, lng] waypoints.
fn line_coordinates(points: &[(f64, f64)]) -> Result<Value, String> {
    if points.len() < 2 {
        return Err("a route needs at least 2 points".to_string());
    }
    Ok(Value::Array(positions(points)?))
}

/// Publish body: mandatory ttl + geometry; comment/name only when non-empty.
fn share_body(geometry: Value, ttl_seconds: u32, comment: &str, name: Option<&str>) -> Value {
    let mut body = json!({ "geometry": geometry, "ttl_seconds": ttl_seconds });
    if !comment.is_empty() {
        body["comment"] = json!(comment);
    }
    if let Some(n) = name {
        if !n.is_empty() {
            body["name"] = json!(n);
        }
    }
    body
}

// ── HTTP plumbing (gates first, then cloud's request path) ───────────────────

async fn get_json(app: &AppHandle, server_url: &str, path: &str) -> Result<Value, String> {
    ensure_beacon_enabled()?;
    cloud::ensure_online(app)?;
    let (status, body) = cloud::request_json(app, server_url, "GET", path, true, None).await?;
    cloud::expect_2xx(status, &body)?;
    Ok(body)
}

async fn post_json(
    app: &AppHandle,
    server_url: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    ensure_beacon_enabled()?;
    cloud::ensure_online(app)?;
    let (status, resp) = cloud::request_json(app, server_url, "POST", path, true, body).await?;
    cloud::expect_2xx(status, &resp)?;
    Ok(resp)
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Every active share of every user: `{pins, zones, routes}`.
#[tauri::command]
pub async fn beacon_all(app: AppHandle, server_url: String) -> Result<Value, String> {
    get_json(&app, &server_url, "/beacon/all").await
}

/// Active pins within `radius_m` of a point, sorted by distance.
#[tauri::command]
pub async fn beacon_near(
    app: AppHandle,
    server_url: String,
    lat: f64,
    lon: f64,
    radius_m: f64,
) -> Result<Value, String> {
    validate_lat_lng(lat, lon)?;
    if !radius_m.is_finite() || radius_m <= 0.0 {
        return Err("radius_m must be positive".to_string());
    }
    let path = format!(
        "/beacon/near?lat={}&lon={}&radius_m={}",
        encode_component(&lat.to_string()),
        encode_component(&lon.to_string()),
        encode_component(&radius_m.to_string()),
    );
    get_json(&app, &server_url, &path).await
}

/// Publish (or move) MY live pin — one per user on the server.
#[tauri::command]
pub async fn beacon_publish_pin(
    app: AppHandle,
    server_url: String,
    lat: f64,
    lng: f64,
    ttl_seconds: u32,
    comment: String,
) -> Result<Value, String> {
    validate_lat_lng(lat, lng)?;
    validate_ttl(ttl_seconds)?;
    let geometry = json!({ "type": "Point", "coordinates": [lng, lat] });
    let body = share_body(geometry, ttl_seconds, &comment, None);
    post_json(&app, &server_url, "/beacon/pin", Some(body)).await
}

/// Retract my pin (idempotent on the server).
#[tauri::command]
pub async fn beacon_delete_pin(app: AppHandle, server_url: String) -> Result<Value, String> {
    post_json(&app, &server_url, "/beacon/pin/delete", None).await
}

/// Publish a zone from open [lat, lng] corners (ring closed here).
#[tauri::command]
pub async fn beacon_publish_zone(
    app: AppHandle,
    server_url: String,
    name: String,
    points: Vec<(f64, f64)>,
    ttl_seconds: u32,
    comment: String,
) -> Result<Value, String> {
    validate_ttl(ttl_seconds)?;
    let geometry = json!({ "type": "Polygon", "coordinates": polygon_coordinates(&points)? });
    let body = share_body(geometry, ttl_seconds, &comment, Some(&name));
    post_json(&app, &server_url, "/beacon/zone", Some(body)).await
}

/// Publish a route from [lat, lng] waypoints.
#[tauri::command]
pub async fn beacon_publish_route(
    app: AppHandle,
    server_url: String,
    name: String,
    points: Vec<(f64, f64)>,
    ttl_seconds: u32,
    comment: String,
) -> Result<Value, String> {
    validate_ttl(ttl_seconds)?;
    let geometry = json!({ "type": "LineString", "coordinates": line_coordinates(&points)? });
    let body = share_body(geometry, ttl_seconds, &comment, Some(&name));
    post_json(&app, &server_url, "/beacon/route", Some(body)).await
}

/// Delete my zone (server 404s for someone else's — surfaced as-is).
#[tauri::command]
pub async fn beacon_delete_zone(
    app: AppHandle,
    server_url: String,
    id: u64,
) -> Result<Value, String> {
    post_json(&app, &server_url, &format!("/beacon/zone/{id}/delete"), None).await
}

/// Delete my route.
#[tauri::command]
pub async fn beacon_delete_route(
    app: AppHandle,
    server_url: String,
    id: u64,
) -> Result<Value, String> {
    post_json(&app, &server_url, &format!("/beacon/route/{id}/delete"), None).await
}

// ── Tests (pure helpers only, crate convention) ──────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_reserved_and_keeps_unreserved() {
        assert_eq!(encode_component("52.2297"), "52.2297");
        assert_eq!(encode_component("-21.5"), "-21.5");
        assert_eq!(encode_component("a b&c"), "a%20b%26c");
        assert_eq!(encode_component("zażółć"), "za%C5%BC%C3%B3%C5%82%C4%87");
    }

    #[test]
    fn rejects_out_of_range_coordinates() {
        assert!(validate_lat_lng(52.0, 21.0).is_ok());
        assert!(validate_lat_lng(90.1, 0.0).is_err());
        assert!(validate_lat_lng(0.0, -180.1).is_err());
        assert!(validate_lat_lng(f64::NAN, 0.0).is_err());
    }

    #[test]
    fn polygon_ring_is_closed_and_lng_lat_ordered() {
        let coords = polygon_coordinates(&[(52.2, 21.0), (52.2, 21.1), (52.3, 21.1)]).unwrap();
        let ring = coords[0].as_array().unwrap();
        assert_eq!(ring.len(), 4);
        assert_eq!(ring[0], json!([21.0, 52.2])); // GeoJSON order
        assert_eq!(ring[0], ring[3]); // closed
    }

    #[test]
    fn polygon_needs_three_corners() {
        assert!(polygon_coordinates(&[(52.2, 21.0), (52.2, 21.1)]).is_err());
    }

    #[test]
    fn line_needs_two_points_and_rejects_bad_ones() {
        assert!(line_coordinates(&[(52.2, 21.0)]).is_err());
        assert!(line_coordinates(&[(52.2, 21.0), (95.0, 21.1)]).is_err());
        let line = line_coordinates(&[(52.2, 21.0), (52.3, 21.1)]).unwrap();
        assert_eq!(line, json!([[21.0, 52.2], [21.1, 52.3]]));
    }

    #[test]
    fn share_body_omits_empty_optionals() {
        let g = json!({ "type": "Point", "coordinates": [21.0, 52.2] });
        let bare = share_body(g.clone(), 900, "", Some(""));
        assert!(bare.get("comment").is_none());
        assert!(bare.get("name").is_none());
        assert_eq!(bare["ttl_seconds"], 900);
        let full = share_body(g, 3600, "hi", Some("camp"));
        assert_eq!(full["comment"], "hi");
        assert_eq!(full["name"], "camp");
    }

    #[test]
    fn ttl_must_be_positive() {
        assert!(validate_ttl(0).is_err());
        assert!(validate_ttl(900).is_ok());
    }
}
