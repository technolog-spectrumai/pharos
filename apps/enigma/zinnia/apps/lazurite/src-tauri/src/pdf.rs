//! Making a PDF, with Rust holding the process and the frontend holding nothing.
//!
//! The renderer is a Python script (`../pdf/render.py`, embedded) over
//! WeasyPrint — the same engine zenobia's `toto.aralia` and `toto.memo` use,
//! kept because a working export beats a perfect one. It is transitional:
//! a printpdf backend replaces it later, behind this same command surface, so
//! nothing in the frontend has to know which one drew the page.
//!
//! What this module is for, and what it is not:
//!
//! * **The UI thread never waits.** Both commands are `async`; the render runs
//!   in a child process and this only polls it.
//! * **The child cannot write anywhere it likes.** It is handed one temporary
//!   directory, reads its input there, writes `output.pdf` there, and Rust
//!   moves the result to the path the user chose — through a sibling temp and
//!   a rename, so a half-written PDF never sits at that path.
//! * **It cannot run forever.** A timeout kills it; `pdf_cancel` kills it
//!   sooner. Either way the temporary directory is removed.
//! * **It cannot reach the network.** The script's `url_fetcher` allows
//!   `data:` and nothing else — aralia's rule, kept for aralia's reason: the
//!   window's Content-Security-Policy constrains the webview, not a process
//!   the webview asked for.
//! * **It is not a workflow engine.** One job at a time, no queue, no
//!   progress percentages the renderer could not honestly report.
//!
//! Missing WeasyPrint is a STATE, not a failure: `pdf_status` says which
//! interpreter was found and what it lacks, and the editors keep editing.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const SCRIPT: &str = include_str!("../pdf/render.py");

/// Generous: a long document with images at 300 dpi is tens of seconds; a
/// runaway is minutes. Cancel is there for the impatient.
const TIMEOUT: Duration = Duration::from_secs(180);
const STATUS_TIMEOUT: Duration = Duration::from_secs(15);

/// The one job. A second request while one runs is refused rather than
/// queued: a queue would be a workflow, and the second click was almost
/// certainly the first one again.
fn running() -> &'static Mutex<Option<Child>> {
    static JOB: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    JOB.get_or_init(|| Mutex::new(None))
}

// ── finding an interpreter ──────────────────────────────────────────────────

/// Where WeasyPrint might be, most deliberate first.
///
/// `ZINNIA_PDF_PYTHON` names an interpreter outright. Failing that, a
/// virtualenv the user made for this app under its data directory — the
/// documented setup — and failing that, whatever `python3` is on PATH, which
/// is where a distro package would land.
fn candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("ZINNIA_PDF_PYTHON") {
        if !p.trim().is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Ok(dir) = app.path().app_data_dir() {
        out.push(dir.join("pdf-venv").join("bin").join("python"));
        out.push(dir.join("pdf-venv").join("Scripts").join("python.exe"));
    }
    out.push(PathBuf::from("python3"));
    out.push(PathBuf::from("python"));
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct PdfStatus {
    /// True only when a render would actually work.
    available: bool,
    /// The interpreter that answered, if any.
    python: Option<String>,
    weasyprint: Option<String>,
    /// Python-Markdown, for the markdown route. Optional: HTML renders without it.
    markdown: bool,
    /// Why not, when not — a sentence an operator can act on.
    reason: Option<String>,
}

/// One probe per candidate: import WeasyPrint and print what was found.
fn probe(python: &Path) -> Option<(String, bool)> {
    let out = Command::new(python)
        .args(["-c", concat!(
            "import json\n",
            "try:\n import weasyprint; w = weasyprint.__version__\n",
            "except Exception as e:\n w = None\n",
            "try:\n import markdown; m = True\n",
            "except Exception:\n m = False\n",
            "print(json.dumps({'w': w, 'm': m}))",
        )])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let out = wait_with_timeout(out, STATUS_TIMEOUT).ok()??;
    let line = String::from_utf8_lossy(&out);
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let w = v.get("w")?.as_str()?.to_string();
    let m = v.get("m").and_then(|x| x.as_bool()).unwrap_or(false);
    Some((w, m))
}

/// What a render would find. Cheap enough to ask on every open of the export
/// dialog, so a WeasyPrint installed five minutes ago is noticed.
#[tauri::command(async)]
pub fn pdf_status(app: tauri::AppHandle) -> Result<PdfStatus, String> {
    let mut tried = Vec::new();
    for py in candidates(&app) {
        if let Some((weasy, md)) = probe(&py) {
            return Ok(PdfStatus {
                available: true,
                python: Some(py.display().to_string()),
                weasyprint: Some(weasy),
                markdown: md,
                reason: None,
            });
        }
        tried.push(py.display().to_string());
    }
    Ok(PdfStatus {
        available: false,
        python: None,
        weasyprint: None,
        markdown: false,
        reason: Some(format!(
            "no interpreter with WeasyPrint; tried {}",
            tried.join(", ")
        )),
    })
}

// ── rendering ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RenderRequest {
    /// "html" or "markdown".
    kind: String,
    /// The whole document, assets inlined. Never a path: the script reads only
    /// what Rust wrote into its directory.
    source: String,
    /// A stylesheet for the markdown route; ignored for html, which carries its own.
    #[serde(default)]
    css: String,
    /// Where the user asked for the PDF. Chosen through the save dialog.
    output: String,
}

#[derive(Debug, Serialize)]
pub struct RenderResult {
    pages: u64,
    bytes: u64,
    /// WeasyPrint's warnings, verbatim — a substituted font, a refused fetch.
    log: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ScriptReply {
    ok: bool,
    #[serde(default)]
    error: String,
    #[serde(default)]
    pages: u64,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    log: Vec<String>,
}

/// A private directory for one job. Under the system temp dir, named after
/// this process and a counter, so two zinnias cannot collide and a crash
/// leaves something a person can recognise and delete.
fn workdir() -> Result<PathBuf, String> {
    static N: Mutex<u64> = Mutex::new(0);
    let n = {
        let mut g = N.lock().map_err(|_| "busy".to_string())?;
        *g += 1;
        *g
    };
    let dir = std::env::temp_dir().join(format!("zinnia-pdf-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("tempdir: {e}"))?;
    Ok(dir)
}

/// Poll rather than block: `wait()` would hold the thread with no way to
/// enforce a deadline, and the job registry needs the handle for cancel.
fn wait_with_timeout(mut child: Child, limit: Duration) -> Result<Option<Vec<u8>>, String> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > limit {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("wait: {e}")),
        }
    }
    let mut buf = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_end(&mut buf);
    }
    Ok(Some(buf))
}

/// Sibling temp, fsync, rename — the same rule `lock.rs` applies to a sealed
/// file, for the same reason: the path the user chose either holds the whole
/// PDF or whatever was there before, never a partial one.
fn place(pdf: &Path, output: &str) -> Result<(), String> {
    let bytes = std::fs::read(pdf).map_err(|e| format!("read: {e}"))?;
    let tmp = format!("{output}.zinnia.tmp");
    let done = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, output)
    })();
    if let Err(e) = done {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write: {e}"));
    }
    Ok(())
}

/// Render one document to the path the user chose.
///
/// Errors come back as `prefix: prose`, like every other command here, so the
/// frontend can map the prefix and show the prose only where it helps.
#[tauri::command(async)]
pub fn pdf_render(app: tauri::AppHandle, request: RenderRequest) -> Result<RenderResult, String> {
    if request.kind != "html" && request.kind != "markdown" {
        return Err("bad_request: kind must be html or markdown".into());
    }
    if request.output.trim().is_empty() {
        return Err("bad_request: no output path".into());
    }
    {
        let mut job = running().lock().map_err(|_| "busy: job lock".to_string())?;
        if let Some(child) = job.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Err("busy: a PDF is already being made".into());
            }
            *job = None;
        }
    }

    let python = candidates(&app)
        .into_iter()
        .find(|p| probe(p).is_some())
        .ok_or_else(|| "pdf_unavailable: no interpreter with WeasyPrint".to_string())?;

    let dir = workdir()?;
    let result = (|| -> Result<RenderResult, String> {
        let input = dir.join(if request.kind == "markdown" { "input.md" } else { "input.html" });
        std::fs::write(&input, request.source.as_bytes()).map_err(|e| format!("tempdir: {e}"))?;
        if !request.css.is_empty() {
            std::fs::write(dir.join("style.css"), request.css.as_bytes())
                .map_err(|e| format!("tempdir: {e}"))?;
        }
        let script = dir.join("render.py");
        std::fs::write(&script, SCRIPT).map_err(|e| format!("tempdir: {e}"))?;

        let child = Command::new(&python)
            .arg(&script)
            .arg(&request.kind)
            .arg(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn: {e}"))?;

        // Registered for cancel, then taken back to wait on. The registry holds
        // it only while it runs.
        let child = {
            let mut job = running().lock().map_err(|_| "busy: job lock".to_string())?;
            *job = Some(child);
            job.take().unwrap()
        };
        let stdout = match wait_with_timeout(child, TIMEOUT)? {
            Some(s) => s,
            None => return Err("timeout: the renderer did not finish in time".into()),
        };
        let line = String::from_utf8_lossy(&stdout);
        let reply: ScriptReply = serde_json::from_str(line.trim().lines().last().unwrap_or(""))
            .map_err(|_| format!("bad_reply: {}", line.trim().chars().take(200).collect::<String>()))?;
        if !reply.ok {
            return Err(reply.error);
        }
        place(&dir.join("output.pdf"), &request.output)?;
        Ok(RenderResult { pages: reply.pages, bytes: reply.bytes, log: reply.log })
    })();

    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// Kill the running job, if there is one. Idempotent.
#[tauri::command]
pub fn pdf_cancel() -> Result<bool, String> {
    let mut job = running().lock().map_err(|_| "busy: job lock".to_string())?;
    if let Some(child) = job.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
        *job = None;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_is_embedded_and_refuses_the_network() {
        assert!(SCRIPT.contains("def refuse_fetch"));
        assert!(SCRIPT.contains("url.startswith(\"data:\")"));
        assert!(SCRIPT.contains("base_url=None"));
    }

    #[test]
    fn placing_a_pdf_never_leaves_a_partial_file_behind() {
        let dir = std::env::temp_dir().join(format!("zinnia-pdf-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.pdf");
        std::fs::write(&src, b"%PDF-1.7 fake").unwrap();
        let out = dir.join("out.pdf");
        place(&src, out.to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"%PDF-1.7 fake");
        assert!(!dir.join("out.pdf.zinnia.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The whole path, against a real WeasyPrint. Skips itself where none is
    /// installed; `ZINNIA_PDF_PYTHON` names one for the machine that has it.
    #[test]
    fn renders_a_real_pdf_when_weasyprint_is_present() {
        let Ok(py) = std::env::var("ZINNIA_PDF_PYTHON") else { return };
        let py = PathBuf::from(py);
        if probe(&py).is_none() {
            return;
        }
        let dir = workdir().unwrap();
        std::fs::write(dir.join("input.html"), "<h1>Zażółć gęślą jaźń</h1><p>ok</p>").unwrap();
        let script = dir.join("render.py");
        std::fs::write(&script, SCRIPT).unwrap();
        let child = Command::new(&py).arg(&script).arg("html").arg(&dir)
            .stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let out = wait_with_timeout(child, TIMEOUT).unwrap().expect("no timeout");
        let reply: ScriptReply = serde_json::from_str(String::from_utf8_lossy(&out).trim()).unwrap();
        assert!(reply.ok, "{}", reply.error);
        assert_eq!(reply.pages, 1);
        let pdf = std::fs::read(dir.join("output.pdf")).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
