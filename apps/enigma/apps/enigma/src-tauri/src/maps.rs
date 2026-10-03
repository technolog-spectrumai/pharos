// Maps — the PMTiles backend for the Map tab: serves vector tiles to MapLibre
// from imported local region blobs, and imports/exports/shares those blobs.
//
// The app NEVER talks to tile servers (see technology.md §25): region
// packages (`<name>.pmtiles` + `<name>.manifest.json`) are produced offline by
// the standalone companion tool (tools/map_packager) and imported from the
// device — `map_region_import` is the single entry point and re-verifies
// BLAKE3 + every manifest field before anything is registered.
//
// Layout & posture:
//   * Region blobs live at `<profile_dir>/maps/<blake3-hex>.pmtiles` —
//     content-addressed, immutable, deduplicated by hash. They hold only
//     public map data and their names carry no coordinates; everything
//     sensitive (which bbox you have, pins, routes) lives sealed in the
//     protasius kv store (`map:regions` / `map:pins` / `map:routes`).
//   * Region P2P sharing reuses file_xfer.rs verbatim (`map_region_offer`
//     wraps `file_offer_create` on the blob path). Map BYTES never ride the
//     MLS chat seam.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use pmtiles::{AsyncPmTilesReader, HashMapCache, MmapBackend, TileCoord};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as TokioMutex;

use crate::vault;

// ── constants / gates ─────────────────────────────────────────────────────────

/// Error prefix contract for the storage budget (frontend matches on it).
pub(crate) const MAPS_STORAGE_LIMIT: &str = "MAPS_STORAGE_LIMIT";
/// Error prefix contract for a package whose tiles the bundled style cannot
/// draw (wrong vector schema — e.g. Shortbread instead of Protomaps).
pub(crate) const MAPS_SCHEMA_UNSUPPORTED: &str = "MAPS_SCHEMA_UNSUPPORTED";

/// Source layers the bundled protomaps-themes-base style draws from. An
/// archive missing these paints an entirely blank map, so the import is
/// refused up front rather than leaving the user staring at empty canvas.
/// Only the core four are required: a Protomaps build always has them, and no
/// other common schema (Shortbread uses land/streets/water_polygons/…) does.
const REQUIRED_SOURCE_LAYERS: [&str; 4] = ["earth", "roads", "water", "places"];

/// Encrypted kv namespace holding the region manifest list (single JSON array
/// under scope "default", key "" — same pattern as `p2p:rooms`; rakotis
/// `mapData.ts` reads the identical key).
const NS_REGIONS: &str = "map:regions";
const SETTINGS_NS: &str = "p2p:settings";
const SETTINGS_SCOPE: &str = "default";
const REGIONS_SCOPE: &str = "default";
const REGIONS_KEY: &str = "";
/// Active (priority) region for tile resolution — sealed per-profile setting;
/// the frontend writes it via rakotis appStorage.setMapActiveRegion. Device-
/// local by design: deliberately NOT in the devlink sync allow-list (each device
/// imports its own packages, so a synced id would usually dangle).
const KEY_ACTIVE_REGION: &str = "map_active_region";

/// Caps mirrored from rakotis mapModel.ts — the Rust side re-validates
/// independently and never trusts the frontend or the wire.
const NAME_MAX_LEN: usize = 120;
const SOURCE_URL_MAX_LEN: usize = 2048;
const ZOOM_MAX: u8 = 22;
const MANIFEST_VERSION: u32 = 1;

// ── settings (encrypted kv is the runtime source of truth; build config seeds
//    and bounds — see technology.md §15) ───────────────────────────────────────

fn storage_limit_bytes(app: &AppHandle) -> u64 {
    use crate::build_config::settings as s;
    let mb = match vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, "map_storage_limit_mb") {
        Some(v) => v
            .parse::<u64>()
            .map(|n| n.clamp(s::MAP_STORAGE_LIMIT_MIN_MB, s::MAP_STORAGE_LIMIT_MAX_MB))
            .unwrap_or(s::MAP_STORAGE_LIMIT_DEFAULT_MB),
        None => s::MAP_STORAGE_LIMIT_DEFAULT_MB,
    };
    mb.saturating_mul(1024 * 1024)
}

/// The active region id, or None ("" and absent read identically — the TS
/// clear path writes "" while map_region_remove deletes the row).
fn active_region_id(app: &AppHandle) -> Option<String> {
    vault::kv_get_raw(app, SETTINGS_NS, SETTINGS_SCOPE, KEY_ACTIVE_REGION)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── manifest (mirrors rakotis mapModel.ts field-for-field) ────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapRegionManifest {
    pub id: String,
    pub name: String,
    /// [west, south, east, north] degrees; antimeridian-crossing rejected.
    pub bbox: [f64; 4],
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub size: u64,
    /// Lowercase hex BLAKE3 of the blob — the content address.
    pub blake3: String,
    pub source_url: String,
    pub version: u32,
}

fn valid_bbox(b: &[f64; 4]) -> bool {
    let [west, south, east, north] = *b;
    (-180.0..=180.0).contains(&west)
        && (-180.0..=180.0).contains(&east)
        && (-90.0..=90.0).contains(&south)
        && (-90.0..=90.0).contains(&north)
        && west < east
        && south < north
}

fn valid_blake3_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn validate_manifest(m: &MapRegionManifest) -> Result<(), String> {
    if m.id.is_empty() || m.id.len() > 64 {
        return Err("manifest: bad id".into());
    }
    if m.name.trim().is_empty() || m.name.len() > NAME_MAX_LEN {
        return Err("manifest: bad name".into());
    }
    if !valid_bbox(&m.bbox) {
        return Err("manifest: bad bbox".into());
    }
    if m.min_zoom > m.max_zoom || m.max_zoom > ZOOM_MAX {
        return Err("manifest: bad zoom range".into());
    }
    if m.size == 0 {
        return Err("manifest: bad size".into());
    }
    if !valid_blake3_hex(&m.blake3) {
        return Err("manifest: bad blake3".into());
    }
    if m.source_url.len() > SOURCE_URL_MAX_LEN {
        return Err("manifest: bad sourceUrl".into());
    }
    if m.version != MANIFEST_VERSION {
        return Err("manifest: unsupported version".into());
    }
    Ok(())
}

// ── tile math (pure — unit-tested below; mirrors mapModel.ts) ─────────────────

const MERCATOR_MAX_LAT: f64 = 85.051_128_78;

pub(crate) fn lon_lat_to_tile(lon: f64, lat: f64, z: u8) -> (u32, u32) {
    let n = (1u64 << z) as f64;
    let lat = lat.clamp(-MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
    let lat_rad = lat.to_radians();
    let x = (((lon + 180.0) / 360.0) * n).floor();
    let y = (((1.0 - lat_rad.tan().asinh() / std::f64::consts::PI) / 2.0) * n).floor();
    let max = (n - 1.0).max(0.0);
    (x.clamp(0.0, max) as u32, y.clamp(0.0, max) as u32)
}

/// Inclusive XYZ range covering `bbox` at zoom `z`.
pub(crate) fn bbox_tile_range(bbox: &[f64; 4], z: u8) -> (u32, u32, u32, u32) {
    let (x_min, y_min) = lon_lat_to_tile(bbox[0], bbox[3], z); // NW corner
    let (x_max, y_max) = lon_lat_to_tile(bbox[2], bbox[1], z); // SE corner
    (x_min, x_max, y_min, y_max)
}

fn tile_in_bbox(bbox: &[f64; 4], z: u8, x: u32, y: u32) -> bool {
    let (x_min, x_max, y_min, y_max) = bbox_tile_range(bbox, z);
    (x_min..=x_max).contains(&x) && (y_min..=y_max).contains(&y)
}

// ── files / paths ─────────────────────────────────────────────────────────────

fn maps_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<crate::AppConfigState>();
    let cfg = crate::active_config(&state)?;
    let dir = crate::profile_dir(app, &cfg).join("maps");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn tmp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = maps_dir(app)?.join("tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn blob_path(app: &AppHandle, blake3_hex: &str) -> Result<PathBuf, String> {
    Ok(maps_dir(app)?.join(format!("{blake3_hex}.pmtiles")))
}

/// BLAKE3 + byte size of a file, streamed in 1 MiB chunks. Shared with
/// file_sync.rs (the Files→Devices per-file sync uses the same hashing).
pub(crate) fn blake3_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total: u64 = 0;
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hasher.finalize().to_hex().to_string(), total))
}

/// Total bytes of region blobs on disk (tmp excluded) — the storage accounting.
fn blob_bytes_used(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            e.path().extension().is_some_and(|x| x == "pmtiles") && e.path().is_file()
        })
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Drop stale tmp files (crash leftovers): anything older than a day that no
/// live task owns. Called from `map_regions_list` (the Maps view mount).
fn sweep_tmp(app: &AppHandle) {
    let Ok(dir) = tmp_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > 24 * 3600);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ── region list persistence (sealed kv — shared key with rakotis mapData.ts) ──

fn read_regions(app: &AppHandle) -> Vec<MapRegionManifest> {
    let Some(raw) = vault::kv_get_raw(app, NS_REGIONS, REGIONS_SCOPE, REGIONS_KEY) else {
        return Vec::new();
    };
    let parsed: Vec<MapRegionManifest> = serde_json::from_str(&raw).unwrap_or_default();
    parsed
        .into_iter()
        .filter(|m| validate_manifest(m).is_ok())
        .collect()
}

fn write_regions(app: &AppHandle, regions: &[MapRegionManifest]) -> Result<(), String> {
    let json = serde_json::to_string(regions).map_err(|e| e.to_string())?;
    vault::kv_put_raw(app, NS_REGIONS, REGIONS_SCOPE, REGIONS_KEY, &json)
}

// ── lookup order (pure — unit-tested below) ───────────────────────────────────

/// Tile-resolution order: the active region first, then every other region in
/// stored (newest-first) order — so a coarse world package keeps filling the
/// gaps a detailed active package doesn't cover. An `active_id` matching
/// nothing leaves the order untouched: a stale id degrades to "no active
/// region", never to "no tiles".
fn ordered_for_lookup(
    regions: Vec<MapRegionManifest>,
    active_id: Option<&str>,
) -> Vec<MapRegionManifest> {
    let Some(id) = active_id else { return regions };
    let (mut active, rest): (Vec<_>, Vec<_>) = regions.into_iter().partition(|r| r.id == id);
    active.extend(rest);
    active
}

// ── state ─────────────────────────────────────────────────────────────────────

type LocalReader = AsyncPmTilesReader<MmapBackend, HashMapCache>;

#[derive(Default)]
pub struct MapsState {
    /// Open local region readers, keyed by blob hash (mmap + directory cache).
    local_readers: TokioMutex<HashMap<String, std::sync::Arc<LocalReader>>>,
}

/// Drop cached readers (profile switch: the maps dir changed under them).
pub async fn reset_readers(app: &AppHandle) {
    app.state::<MapsState>().local_readers.lock().await.clear();
}

// ── readers ───────────────────────────────────────────────────────────────────

async fn local_reader(
    app: &AppHandle,
    blake3_hex: &str,
) -> Result<std::sync::Arc<LocalReader>, String> {
    let state = app.state::<MapsState>();
    let mut readers = state.local_readers.lock().await;
    if let Some(r) = readers.get(blake3_hex) {
        return Ok(r.clone());
    }
    let path = blob_path(app, blake3_hex)?;
    let reader = AsyncPmTilesReader::new_with_cached_path(HashMapCache::default(), &path)
        .await
        .map_err(|e| format!("open region failed: {e}"))?;
    let arc = std::sync::Arc::new(reader);
    readers.insert(blake3_hex.to_string(), arc.clone());
    Ok(arc)
}

// ── commands: tiles ───────────────────────────────────────────────────────────

/// Serve one tile to the MapLibre custom protocol from the imported local
/// regions. Empty body = no tile. Bytes are decompressed per the archive's
/// tile_compression, so the webview always receives raw MVT/image data.
#[tauri::command]
pub async fn map_get_tile(app: AppHandle, z: u8, x: u32, y: u32) -> Result<tauri::ipc::Response, String> {
    if z > ZOOM_MAX {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let Ok(coord) = TileCoord::new(z, x, y) else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };

    // Local regions (newest first — the order read_regions preserves).
    for region in ordered_for_lookup(read_regions(&app), active_region_id(&app).as_deref()) {
        if z < region.min_zoom || z > region.max_zoom || !tile_in_bbox(&region.bbox, z, x, y) {
            continue;
        }
        let Ok(reader) = local_reader(&app, &region.blake3).await else {
            continue; // missing/corrupt blob — other regions or remote may cover
        };
        match reader.get_tile_decompressed(coord).await {
            Ok(Some(bytes)) => return Ok(tauri::ipc::Response::new(bytes.to_vec())),
            _ => continue,
        }
    }

    Ok(tauri::ipc::Response::new(Vec::new()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSourceInfo {
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub bbox: [f64; 4],
}

/// Zoom/bbox envelope for style bootstrap: the union of imported regions,
/// else null (nothing imported yet).
/// Mirror a Map-tab lifecycle line to the app's stderr.
///
/// The map canvas is the one surface whose failures are invisible without
/// devtools (a dark canvas reports nothing), and devtools are awkward in the
/// WebKitGTK shell — so the panel echoes its startup trace here, where
/// `run_dev.sh` shows it and a user can paste it into a bug report.
#[tauri::command]
pub fn map_debug_log(message: String) {
    let msg: String = message.chars().take(400).collect();
    eprintln!("[map-ui] {msg}");
}

#[tauri::command]
pub async fn map_source_info(app: AppHandle) -> Result<Option<MapSourceInfo>, String> {
    let regions = read_regions(&app);
    if regions.is_empty() {
        return Ok(None);
    }
    let mut bbox = regions[0].bbox;
    let (mut min_z, mut max_z) = (regions[0].min_zoom, regions[0].max_zoom);
    for r in &regions[1..] {
        bbox[0] = bbox[0].min(r.bbox[0]);
        bbox[1] = bbox[1].min(r.bbox[1]);
        bbox[2] = bbox[2].max(r.bbox[2]);
        bbox[3] = bbox[3].max(r.bbox[3]);
        min_z = min_z.min(r.min_zoom);
        max_z = max_z.max(r.max_zoom);
    }
    Ok(Some(MapSourceInfo { min_zoom: min_z, max_zoom: max_z, bbox }))
}

// ── commands: regions ─────────────────────────────────────────────────────────

/// The manifest list (validated). Also sweeps crash-leftover temp files.
#[tauri::command]
pub async fn map_regions_list(app: AppHandle) -> Result<Vec<MapRegionManifest>, String> {
    sweep_tmp(&app);
    Ok(read_regions(&app))
}

/// Remove a region: drop its manifest; garbage-collect the blob when no other
/// manifest references the same content hash.
#[tauri::command]
pub async fn map_region_remove(app: AppHandle, id: String) -> Result<(), String> {
    let regions = read_regions(&app);
    let Some(removed) = regions.iter().find(|r| r.id == id).cloned() else {
        return Ok(());
    };
    let remaining: Vec<MapRegionManifest> =
        regions.into_iter().filter(|r| r.id != id).collect();
    write_regions(&app, &remaining)?;
    // The active region just went away — clear the pointer rather than leave a
    // dangling id (best-effort: the read paths fail soft on one anyway).
    if active_region_id(&app).as_deref() == Some(id.as_str()) {
        let _ = vault::kv_delete_raw(&app, SETTINGS_NS, SETTINGS_SCOPE, KEY_ACTIVE_REGION);
    }
    if !remaining.iter().any(|r| r.blake3 == removed.blake3) {
        let path = blob_path(&app, &removed.blake3)?;
        // Privacy HP: measured here, on the real file, immediately before it is
        // unlinked — this credit never takes the frontend's word for a size.
        let freed = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&path);
        app.state::<MapsState>().local_readers.lock().await.remove(&removed.blake3);
        crate::privacy_hp::award_data(&app, "data.delete.maps", freed);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapStorageUsage {
    pub used_bytes: u64,
    pub limit_bytes: u64,
}

#[tauri::command]
pub async fn map_storage_usage(app: AppHandle) -> Result<MapStorageUsage, String> {
    Ok(MapStorageUsage {
        used_bytes: blob_bytes_used(&maps_dir(&app)?),
        limit_bytes: storage_limit_bytes(&app),
    })
}

// ── commands: share / import / export ─────────────────────────────────────────

/// Register a region blob with the P2P file-transfer node and return the offer
/// (`offer_id`, dialable `addr`, …) for the frontend to relay inside the
/// MLS `map_region` share card. All transfer gates (airplane, Tor) apply.
#[tauri::command]
pub async fn map_region_offer(
    app: AppHandle,
    config: State<'_, crate::AppConfigState>,
    file: State<'_, crate::file_xfer::FileXferState>,
    id: String,
) -> Result<crate::file_xfer::OfferCreated, String> {
    let regions = read_regions(&app);
    let region = regions
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "unknown region".to_string())?;
    let path = blob_path(&app, &region.blake3)?;
    if !path.exists() {
        return Err("region file is missing".into());
    }
    crate::file_xfer::file_offer_create(app.clone(), config, file, path.to_string_lossy().to_string())
        .await
}

/// Destination path for an incoming region transfer (kept inside maps/tmp so a
/// failed verification never leaves stray files elsewhere). The frontend passes
/// it to `file_download`, then to `map_region_import` once the transfer ends.
#[tauri::command]
pub async fn map_region_recv_path(app: AppHandle, offer_id: String) -> Result<String, String> {
    let safe: String = offer_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    if safe.is_empty() {
        return Err("invalid offer id".into());
    }
    Ok(tmp_dir(&app)?
        .join(format!("recv-{safe}.pmtiles"))
        .to_string_lossy()
        .to_string())
}

/// Verify + register a region file. `manifest_json` present = P2P/share path:
/// every field is re-validated and the file must match the manifest's BLAKE3
/// and size EXACTLY, else nothing is imported. Absent = manual import: the
/// manifest is derived from the archive header. Dedup is by content hash; the
/// storage budget only counts blobs not already stored.
/// Which required source layers an archive's metadata does NOT advertise
/// (pure — unit-tested below).
///
/// PMTiles archives declare their vector schema in the metadata JSON as
/// `vector_layers[].id`; comparing those ids is far cheaper than decoding a
/// tile, and it is exactly what MapLibre matches style layers against.
/// Returns an empty vec when the archive is compatible OR when it advertises
/// no `vector_layers` at all — an archive that declares nothing is a "cannot
/// tell", and refusing those would block legitimate imports.
fn missing_source_layers(metadata_json: &str) -> Vec<String> {
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(metadata_json) else {
        return Vec::new();
    };
    let Some(layers) = meta.get("vector_layers").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    if layers.is_empty() {
        return Vec::new();
    }
    let ids: Vec<&str> = layers
        .iter()
        .filter_map(|l| l.get("id").and_then(|v| v.as_str()))
        .collect();
    REQUIRED_SOURCE_LAYERS
        .iter()
        .filter(|req| !ids.contains(req))
        .map(|s| (*s).to_string())
        .collect()
}

/// Decide the manifest for an import (pure — unit-tested below).
///
/// Precedence: an explicit manifest (P2P accept path) → a `<name>.manifest.json`
/// sidecar next to the file (the packager tool writes packages that way) → a
/// manifest derived from the PMTiles header. Explicit and sidecar manifests are
/// fully verified against the file (BLAKE3 + size); a PRESENT-but-broken
/// sidecar is a hard error, not a silent fallback — a mismatch means the
/// package is corrupt or tampered with, and importing header-derived data
/// instead would mask that.
fn resolve_import_manifest(
    src: &Path,
    manifest_json: Option<String>,
    hash: &str,
    size: u64,
    header_bbox: [f64; 4],
    header_min_zoom: u8,
    header_max_zoom: u8,
) -> Result<MapRegionManifest, String> {
    let manifest_json = match manifest_json {
        Some(json) => Some(json),
        None => {
            let sidecar = src.with_extension("manifest.json");
            if sidecar.is_file() {
                Some(
                    std::fs::read_to_string(&sidecar)
                        .map_err(|e| format!("sidecar manifest unreadable: {e}"))?,
                )
            } else {
                None
            }
        }
    };

    match manifest_json {
        Some(json) => {
            let m: MapRegionManifest =
                serde_json::from_str(&json).map_err(|e| format!("bad manifest: {e}"))?;
            validate_manifest(&m)?;
            if m.blake3 != hash {
                return Err("region file failed verification: BLAKE3 mismatch".into());
            }
            if m.size != size {
                return Err("region file failed verification: size mismatch".into());
            }
            Ok(m)
        }
        None => {
            if !valid_bbox(&header_bbox) {
                return Err("archive header has no usable bounds".into());
            }
            let name = src
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Imported region".into());
            let m = MapRegionManifest {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.chars().take(NAME_MAX_LEN).collect(),
                bbox: header_bbox,
                min_zoom: header_min_zoom.min(ZOOM_MAX),
                max_zoom: header_max_zoom.min(ZOOM_MAX),
                size,
                blake3: hash.to_string(),
                source_url: String::new(),
                version: MANIFEST_VERSION,
            };
            validate_manifest(&m)?;
            Ok(m)
        }
    }
}

#[tauri::command]
pub async fn map_region_import(
    app: AppHandle,
    path: String,
    manifest_json: Option<String>,
) -> Result<MapRegionManifest, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("file not found".into());
    }

    // Must parse as a real PMTiles archive before anything else.
    let reader = AsyncPmTilesReader::new_with_path(&src)
        .await
        .map_err(|e| format!("not a valid PMTiles file: {e}"))?;
    let header = {
        let h = reader.get_header();
        (
            [h.min_longitude, h.min_latitude, h.max_longitude, h.max_latitude],
            h.min_zoom,
            h.max_zoom,
        )
    };
    // Refuse archives the bundled style cannot draw: they import fine, then
    // render an entirely blank map with nothing to explain why.
    if let Ok(metadata) = reader.get_metadata().await {
        let missing = missing_source_layers(&metadata);
        if !missing.is_empty() {
            return Err(format!(
                "{MAPS_SCHEMA_UNSUPPORTED}: this archive uses a different vector schema \
                 (missing layers: {}). Build the package with the Enigma26 map packager.",
                missing.join(", ")
            ));
        }
    }
    drop(reader);
    let (header_bbox, header_min_zoom, header_max_zoom) = header;

    let (hash, size) = blake3_file(&src)?;

    let manifest = resolve_import_manifest(
        &src,
        manifest_json,
        &hash,
        size,
        header_bbox,
        header_min_zoom,
        header_max_zoom,
    )?;

    let mut regions = read_regions(&app);
    if let Some(existing) = regions.iter().find(|r| r.id == manifest.id) {
        if existing.blake3 == manifest.blake3 {
            return Ok(existing.clone()); // idempotent re-import
        }
        return Err("a different region with this id already exists".into());
    }

    let dest = blob_path(&app, &manifest.blake3)?;
    if !dest.exists() {
        let used = blob_bytes_used(&maps_dir(&app)?);
        let limit = storage_limit_bytes(&app);
        if used.saturating_add(size) > limit {
            return Err(format!(
                "{MAPS_STORAGE_LIMIT}: importing this region ({size} B) would exceed the storage limit"
            ));
        }
        // Copy via tmp + rename so a crash can't leave a half-written blob
        // under its final content-addressed name.
        let staging = tmp_dir(&app)?.join(format!("import-{}.pmtiles", manifest.id));
        std::fs::copy(&src, &staging).map_err(|e| format!("copy failed: {e}"))?;
        std::fs::rename(&staging, &dest).map_err(|e| format!("finalize move failed: {e}"))?;
    }
    // A P2P transfer lands in our own tmp dir — consume it after import.
    if src.starts_with(tmp_dir(&app)?) {
        let _ = std::fs::remove_file(&src);
    }

    regions.insert(0, manifest.clone());
    write_regions(&app, &regions)?;
    Ok(manifest)
}

/// Export a region: copy the blob to `dest_path` and write the manifest as a
/// `<stem>.manifest.json` sidecar next to it (the pair a receiver imports).
#[tauri::command]
pub async fn map_region_export(app: AppHandle, id: String, dest_path: String) -> Result<(), String> {
    let regions = read_regions(&app);
    let region = regions
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "unknown region".to_string())?;
    let blob = blob_path(&app, &region.blake3)?;
    if !blob.exists() {
        return Err("region file is missing".into());
    }
    let dest = PathBuf::from(&dest_path);
    std::fs::copy(&blob, &dest).map_err(|e| format!("copy failed: {e}"))?;
    let sidecar = dest.with_extension("manifest.json");
    let json = serde_json::to_string_pretty(region).map_err(|e| e.to_string())?;
    let mut f = std::fs::File::create(&sidecar).map_err(|e| e.to_string())?;
    f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

// ── tests (pure helpers + writer/reader round-trip) ──────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use pmtiles::{Compression, PmTilesWriter, TileType};
    use serde_json::json;

    const BBOX: [f64; 4] = [16.8, 52.3, 17.1, 52.5];

    fn manifest() -> MapRegionManifest {
        MapRegionManifest {
            id: "r1".into(),
            name: "Poznań".into(),
            bbox: BBOX,
            min_zoom: 0,
            max_zoom: 14,
            size: 1234,
            blake3: "a".repeat(64),
            source_url: "https://example.org/planet.pmtiles".into(),
            version: 1,
        }
    }

    #[test]
    fn tile_math_matches_mapmodel() {
        assert_eq!(lon_lat_to_tile(0.0, 0.0, 0), (0, 0));
        // Same fixture as rakotis mapModel.test.ts: Poznań at z10.
        assert_eq!(lon_lat_to_tile(16.9, 52.4, 10), (560, 336));
        // Polar clamp.
        assert_eq!(lon_lat_to_tile(0.0, 89.9, 4).1, 0);
        assert_eq!(lon_lat_to_tile(0.0, -89.9, 4).1, 15);
    }

    #[test]
    fn bbox_ranges_and_counts() {
        let (x_min, x_max, y_min, y_max) = bbox_tile_range(&BBOX, 10);
        assert!(x_min <= x_max && y_min <= y_max);
        let (x, y) = lon_lat_to_tile(16.9, 52.4, 10);
        assert!(tile_in_bbox(&BBOX, 10, x, y));
        assert!(!tile_in_bbox(&BBOX, 10, x + 100, y));
    }

    #[test]
    fn manifest_validation_matrix() {
        assert!(validate_manifest(&manifest()).is_ok());
        let cases: Vec<(&str, Box<dyn Fn(&mut MapRegionManifest)>)> = vec![
            ("empty id", Box::new(|m| m.id.clear())),
            ("blank name", Box::new(|m| m.name = "  ".into())),
            ("long name", Box::new(|m| m.name = "x".repeat(NAME_MAX_LEN + 1))),
            ("swapped bbox", Box::new(|m| m.bbox = [17.1, 52.3, 16.8, 52.5])),
            ("antimeridian bbox", Box::new(|m| m.bbox = [170.0, -10.0, -170.0, 10.0])),
            ("zoom order", Box::new(|m| { m.min_zoom = 15; m.max_zoom = 14; })),
            ("zoom cap", Box::new(|m| m.max_zoom = 23)),
            ("zero size", Box::new(|m| m.size = 0)),
            ("short hash", Box::new(|m| m.blake3 = "abc".into())),
            ("uppercase hash", Box::new(|m| m.blake3 = "A".repeat(64))),
            ("version", Box::new(|m| m.version = 2)),
        ];
        for (label, mutate) in cases {
            let mut m = manifest();
            mutate(&mut m);
            assert!(validate_manifest(&m).is_err(), "should reject: {label}");
        }
    }

    #[test]
    fn manifest_serde_uses_camel_case_wire_keys() {
        let json = serde_json::to_string(&manifest()).unwrap();
        for key in ["\"minZoom\"", "\"maxZoom\"", "\"sourceUrl\"", "\"blake3\"", "\"bbox\""] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
        let back: MapRegionManifest = serde_json::from_str(&json).unwrap();
        assert!(validate_manifest(&back).is_ok());
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("enigma_maps_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn blake3_file_hashes_and_sizes() {
        let dir = temp_dir();
        let path = dir.join("blob.bin");
        std::fs::write(&path, b"enigma-map-data").unwrap();
        let (hash, size) = blake3_file(&path).unwrap();
        assert_eq!(size, 15);
        assert_eq!(hash, blake3::hash(b"enigma-map-data").to_hex().to_string());
        assert!(valid_blake3_hex(&hash));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn blob_accounting_counts_only_pmtiles() {
        let dir = temp_dir();
        std::fs::write(dir.join("a.pmtiles"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("b.pmtiles"), vec![0u8; 50]).unwrap();
        std::fs::write(dir.join("junk.txt"), vec![0u8; 999]).unwrap();
        assert_eq!(blob_bytes_used(&dir), 150);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Regression guard for the crate behavior the download path relies on:
    /// write a bbox subset (gzip), read it back decompressed, hash stable.
    fn sample_manifest(hash: &str, size: u64) -> MapRegionManifest {
        MapRegionManifest {
            id: "pkg-1".into(),
            name: "Poznań centrum".into(),
            bbox: [16.8, 52.3, 17.1, 52.5],
            min_zoom: 0,
            max_zoom: 12,
            size,
            blake3: hash.into(),
            source_url: "https://example.org/planet.pmtiles".into(),
            version: 1,
        }
    }

    fn region(id: &str) -> MapRegionManifest {
        MapRegionManifest {
            id: id.into(),
            name: format!("Region {id}"),
            bbox: [16.8, 52.3, 17.1, 52.5],
            min_zoom: 0,
            max_zoom: 12,
            size: 1,
            blake3: "a".repeat(64),
            source_url: String::new(),
            version: 1,
        }
    }

    #[test]
    fn active_region_is_checked_first() {
        let ids = |v: Vec<MapRegionManifest>| v.into_iter().map(|r| r.id).collect::<Vec<_>>();
        let regions = vec![region("a"), region("b"), region("c")];
        // The active region moves to the front; the rest keep relative order.
        assert_eq!(ids(ordered_for_lookup(regions.clone(), Some("b"))), ["b", "a", "c"]);
        assert_eq!(ids(ordered_for_lookup(regions.clone(), Some("c"))), ["c", "a", "b"]);
        // Already-first stays a no-op reorder.
        assert_eq!(ids(ordered_for_lookup(regions, Some("a"))), ["a", "b", "c"]);
    }

    #[test]
    fn unknown_or_absent_active_id_leaves_order_untouched() {
        let ids = |v: Vec<MapRegionManifest>| v.into_iter().map(|r| r.id).collect::<Vec<_>>();
        let regions = vec![region("a"), region("b")];
        // Fail-soft contract: a dangling id degrades to "no active region".
        assert_eq!(ids(ordered_for_lookup(regions.clone(), Some("gone"))), ["a", "b"]);
        assert_eq!(ids(ordered_for_lookup(regions.clone(), None)), ["a", "b"]);
        assert_eq!(ids(ordered_for_lookup(Vec::new(), Some("x"))), Vec::<String>::new());
    }

    fn meta_with(ids: &[&str]) -> String {
        let layers: Vec<serde_json::Value> = ids.iter().map(|id| json!({ "id": id })).collect();
        json!({ "name": "x", "vector_layers": layers }).to_string()
    }

    #[test]
    fn detects_incompatible_tile_schemas() {
        // A real Protomaps build (what tools/map_packager produces) — drawable.
        let protomaps = meta_with(&[
            "boundaries", "buildings", "earth", "landcover", "landuse", "places", "pois",
            "roads", "water",
        ]);
        assert!(missing_source_layers(&protomaps).is_empty());

        // A real Shortbread build: imports fine, then paints nothing because
        // the style's earth/roads/water/places layers match no source layer.
        let shortbread = meta_with(&[
            "place_labels", "boundaries", "addresses", "water_lines", "bridges", "streets",
            "street_labels", "public_transport", "buildings", "water_polygons", "ocean",
            "land", "sites", "pois",
        ]);
        let missing = missing_source_layers(&shortbread);
        assert_eq!(missing, vec!["earth", "roads", "water", "places"]);

        // Partial overlap still fails — one missing core layer is enough.
        let partial = meta_with(&["earth", "water", "places"]);
        assert_eq!(missing_source_layers(&partial), vec!["roads"]);
    }

    #[test]
    fn undeclared_schema_is_allowed_through() {
        // "Cannot tell" must never block a legitimate import.
        assert!(missing_source_layers("not json at all").is_empty());
        assert!(missing_source_layers(r#"{"name":"no vector_layers key"}"#).is_empty());
        assert!(missing_source_layers(r#"{"vector_layers":[]}"#).is_empty());
    }

    #[test]
    fn import_sidecar_is_picked_up_and_verified() {
        let dir = std::env::temp_dir().join(format!("enigma-maps-sc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("poznan.pmtiles");
        std::fs::write(&src, b"blobdata").unwrap();
        let (hash, size) = blake3_file(&src).unwrap();

        // Matching sidecar → its manifest wins over the header fallback.
        let m = sample_manifest(&hash, size);
        std::fs::write(
            dir.join("poznan.manifest.json"),
            serde_json::to_string(&m).unwrap(),
        )
        .unwrap();
        let got =
            resolve_import_manifest(&src, None, &hash, size, [0.0; 4], 0, 0).expect("sidecar import");
        assert_eq!(got.name, "Poznań centrum");
        assert_eq!(got.source_url, "https://example.org/planet.pmtiles");

        // Broken sidecar (wrong hash) → hard error, never a silent fallback.
        let bad = sample_manifest(&"b".repeat(64), size);
        std::fs::write(
            dir.join("poznan.manifest.json"),
            serde_json::to_string(&bad).unwrap(),
        )
        .unwrap();
        let err = resolve_import_manifest(&src, None, &hash, size, [16.0, 52.0, 17.0, 53.0], 0, 12)
            .unwrap_err();
        assert!(err.contains("BLAKE3"), "{err}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn import_without_sidecar_derives_from_header() {
        let dir = std::env::temp_dir().join(format!("enigma-maps-nosc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("berlin.pmtiles");
        std::fs::write(&src, b"blobdata").unwrap();
        let (hash, size) = blake3_file(&src).unwrap();

        let got = resolve_import_manifest(&src, None, &hash, size, [13.0, 52.3, 13.8, 52.7], 0, 14)
            .expect("header fallback");
        assert_eq!(got.name, "berlin");
        assert_eq!(got.bbox, [13.0, 52.3, 13.8, 52.7]);
        assert_eq!(got.source_url, "");
        assert_eq!(got.blake3, hash);

        // Useless header bounds and no sidecar → refuse.
        let err = resolve_import_manifest(&src, None, &hash, size, [0.0; 4], 0, 0).unwrap_err();
        assert!(err.contains("no usable bounds"), "{err}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn import_explicit_manifest_verifies_hash_and_size() {
        let dir = std::env::temp_dir().join(format!("enigma-maps-exp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("recv-abc.pmtiles");
        std::fs::write(&src, b"blobdata").unwrap();
        let (hash, size) = blake3_file(&src).unwrap();

        let ok = serde_json::to_string(&sample_manifest(&hash, size)).unwrap();
        assert!(resolve_import_manifest(&src, Some(ok), &hash, size, [0.0; 4], 0, 0).is_ok());

        let wrong_size = serde_json::to_string(&sample_manifest(&hash, size + 1)).unwrap();
        let err = resolve_import_manifest(&src, Some(wrong_size), &hash, size, [0.0; 4], 0, 0)
            .unwrap_err();
        assert!(err.contains("size mismatch"), "{err}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn writer_reader_roundtrip() {
        let dir = temp_dir();
        let path = dir.join("region.pmtiles");
        let tiles = [
            (TileCoord::new(0, 0, 0).unwrap(), b"t-0".as_slice()),
            (TileCoord::new(1, 0, 0).unwrap(), b"t-a".as_slice()),
            (TileCoord::new(1, 1, 1).unwrap(), b"t-a".as_slice()), // dedup
        ];
        {
            let file = std::fs::File::create(&path).unwrap();
            let mut w = PmTilesWriter::new(TileType::Mvt)
                .tile_compression(Compression::Gzip)
                .bounds(BBOX[0], BBOX[1], BBOX[2], BBOX[3])
                .min_zoom(0)
                .max_zoom(1)
                .create(std::io::BufWriter::new(file))
                .unwrap();
            for (coord, data) in tiles {
                w.add_tile(coord, data).unwrap();
            }
            w.finalize().unwrap();
        }
        let reader = AsyncPmTilesReader::new_with_path(&path).await.unwrap();
        let h = reader.get_header();
        assert_eq!((h.min_zoom, h.max_zoom), (0, 1));
        assert!((h.min_longitude - BBOX[0]).abs() < 1e-6);
        for (coord, data) in tiles {
            let got = reader.get_tile_decompressed(coord).await.unwrap().unwrap();
            assert_eq!(&got[..], data);
        }
        let (h1, _) = blake3_file(&path).unwrap();
        let (h2, _) = blake3_file(&path).unwrap();
        assert_eq!(h1, h2);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
