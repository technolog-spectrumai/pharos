//! The file protocol end to end over in-memory streams, and what it refuses.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ferrozine::file::{self, Direction, FileHost, HostSettings, Limits, Observer, TransferEvent};
use ferrozine::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

const LIMITS: Limits = Limits {
    min_chunk: 16,
    max_chunk: 64 * 1024,
};

fn recorder() -> (Observer, Arc<Mutex<Vec<TransferEvent>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink = log.clone();
    (Arc::new(move |e| sink.lock().unwrap().push(e)), log)
}

fn host(chunk: usize, integrity: bool) -> (FileHost, Arc<Mutex<Vec<TransferEvent>>>) {
    let (obs, log) = recorder();
    let h = FileHost::new(
        LIMITS,
        move || HostSettings {
            chunk_size: chunk,
            integrity,
        },
        obs,
    );
    h.set_authorize_wait(Duration::from_millis(300));
    (h, log)
}

fn write_file(dir: &Path, name: &str, len: usize) -> (PathBuf, Vec<u8>) {
    let bytes: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
    let path = dir.join(name);
    std::fs::write(&path, &bytes).unwrap();
    (path, bytes)
}

/// Two in-memory bi-streams: (downloader's recv, downloader's send) and the host's.
fn streams() -> ((DuplexStream, DuplexStream), (DuplexStream, DuplexStream)) {
    let (host_to_dl_w, host_to_dl_r) = tokio::io::duplex(256 * 1024);
    let (dl_to_host_w, dl_to_host_r) = tokio::io::duplex(256 * 1024);
    ((host_to_dl_r, dl_to_host_w), (dl_to_host_r, host_to_dl_w))
}

async fn run(
    host: &FileHost,
    offer_id: &str,
    authorize: Option<&str>,
    dest: &Path,
    want_integrity: bool,
) -> (ferrozine::Result<()>, ferrozine::Result<()>) {
    let prepared = file::prepare(offer_id).unwrap();
    let commitment = prepared.commitment();
    host.authorize(offer_id, authorize.unwrap_or(&commitment));
    let ((dl_recv, dl_send), (h_recv, h_send)) = streams();
    let h = host.clone();
    let server = tokio::spawn(async move { h.serve(h_recv, h_send).await });
    let client = file::receive(
        prepared,
        dl_recv,
        dl_send,
        dest,
        want_integrity,
        LIMITS,
        file::ignore_events(),
    )
    .await;
    (client, server.await.unwrap())
}

#[tokio::test]
async fn a_file_arrives_intact_with_and_without_the_chain() {
    let dir = tempfile::tempdir().unwrap();
    for (len, chunk, integrity) in [
        (0, 64, false),
        (1, 64, true),
        (64, 64, true),
        (10_000, 1000, false),
        (100_003, 4096, true),
    ] {
        let (path, bytes) = write_file(dir.path(), "src.bin", len);
        let (h, log) = host(chunk, integrity);
        let offer = h.offer(&path).unwrap();
        assert_eq!(offer.size, len as u64);
        let dest = dir.path().join("dest.bin");
        let (client, server) = run(&h, &offer.offer_id, None, &dest, false).await;
        client.unwrap();
        server.unwrap();
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            bytes,
            "len {len} chunk {chunk}"
        );
        let log = log.lock().unwrap();
        assert!(matches!(
            log.last(),
            Some(TransferEvent::Done {
                direction: Direction::Send,
                ..
            })
        ));
        assert!(
            log.iter()
                .filter(|e| matches!(e, TransferEvent::Progress { .. }))
                .count()
                <= 102
        );
    }
}

#[tokio::test]
async fn the_downloader_can_insist_on_the_chain() {
    let dir = tempfile::tempdir().unwrap();
    let (path, bytes) = write_file(dir.path(), "a.txt", 5000);
    let (h, _) = host(512, false);
    let offer = h.offer(&path).unwrap();
    let dest = dir.path().join("out");
    let (client, _) = run(&h, &offer.offer_id, None, &dest, true).await;
    client.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);
}

#[tokio::test]
async fn a_downloader_with_another_keypackage_is_refused_before_any_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "secret.pdf", 100);
    let (h, log) = host(64, false);
    let offer = h.offer(&path).unwrap();
    let someone_else = file::prepare(&offer.offer_id).unwrap().commitment();
    let dest = dir.path().join("out");
    let (client, server) = run(&h, &offer.offer_id, Some(&someone_else), &dest, false).await;
    assert!(matches!(server, Err(Error::Unauthorized(_))));
    assert!(client.is_err());
    assert!(!dest.exists(), "nothing written");
    // A refusal, not the offer failing: it stays open for its real downloader.
    let log = log.lock().unwrap();
    assert!(
        matches!(log.last(), Some(TransferEvent::Refused { .. })),
        "{log:?}"
    );
    assert!(!log
        .iter()
        .any(|e| matches!(e, TransferEvent::Failed { .. })));
}

#[tokio::test]
async fn a_failure_after_admission_is_a_failed_transfer_not_a_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 200_000);
    let (h, log) = host(1000, false);
    let offer = h.offer(&path).unwrap();
    let prepared = file::prepare(&offer.offer_id).unwrap();
    h.authorize(&offer.offer_id, &prepared.commitment());

    // host → proxy → downloader; the proxy passes the header and one chunk,
    // then drops both of its ends, so the host's next write fails.
    let (host_w, mut proxy_r) = tokio::io::duplex(4096);
    let (mut proxy_w, dl_r) = tokio::io::duplex(256 * 1024);
    let (dl_w, host_r) = tokio::io::duplex(256 * 1024);
    tokio::spawn(async move {
        for _ in 0..2 {
            let mut len = [0u8; 4];
            proxy_r.read_exact(&mut len).await.unwrap();
            let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
            proxy_r.read_exact(&mut body).await.unwrap();
            proxy_w.write_all(&len).await.unwrap();
            proxy_w.write_all(&body).await.unwrap();
        }
    });
    let h2 = h.clone();
    let server = tokio::spawn(async move { h2.serve(host_r, host_w).await });
    let client = file::receive(
        prepared,
        dl_r,
        dl_w,
        &dir.path().join("o"),
        false,
        LIMITS,
        file::ignore_events(),
    )
    .await;
    assert!(client.is_err());
    assert!(server.await.unwrap().is_err());
    let log = log.lock().unwrap();
    assert!(
        matches!(
            log.last(),
            Some(TransferEvent::Failed {
                direction: Direction::Send,
                ..
            })
        ),
        "{log:?}"
    );
    assert!(!log
        .iter()
        .any(|e| matches!(e, TransferEvent::Refused { .. })));
}

#[tokio::test]
async fn an_offer_nobody_authorized_is_refused_after_the_wait() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 10);
    let (h, _) = host(64, false);
    let offer = h.offer(&path).unwrap();
    let prepared = file::prepare(&offer.offer_id).unwrap();
    let ((dl_recv, dl_send), (h_recv, h_send)) = streams();
    let h2 = h.clone();
    let server = tokio::spawn(async move { h2.serve(h_recv, h_send).await });
    let dest = dir.path().join("out");
    let client = file::receive(
        prepared,
        dl_recv,
        dl_send,
        &dest,
        false,
        LIMITS,
        file::ignore_events(),
    )
    .await;
    assert!(matches!(server.await.unwrap(), Err(Error::Unauthorized(_))));
    assert!(client.is_err());
}

#[tokio::test]
async fn an_authorization_that_arrives_during_the_dial_still_counts() {
    let dir = tempfile::tempdir().unwrap();
    let (path, bytes) = write_file(dir.path(), "f", 300);
    let (h, _) = host(64, false);
    let offer = h.offer(&path).unwrap();
    let prepared = file::prepare(&offer.offer_id).unwrap();
    let commitment = prepared.commitment();
    let ((dl_recv, dl_send), (h_recv, h_send)) = streams();
    let h2 = h.clone();
    let server = tokio::spawn(async move { h2.serve(h_recv, h_send).await });
    let late = h.clone();
    let id = offer.offer_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        late.authorize(&id, &commitment);
    });
    let dest = dir.path().join("out");
    file::receive(
        prepared,
        dl_recv,
        dl_send,
        &dest,
        false,
        LIMITS,
        file::ignore_events(),
    )
    .await
    .unwrap();
    server.await.unwrap().unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);
}

#[tokio::test]
async fn a_cancelled_or_unknown_offer_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 10);
    let (h, _) = host(64, false);
    let offer = h.offer(&path).unwrap();
    h.cancel(&offer.offer_id);
    let (client, server) = run(&h, &offer.offer_id, None, &dir.path().join("o"), false).await;
    assert!(matches!(server, Err(Error::Unauthorized(_))));
    assert!(client.is_err());
}

/// Forward host→downloader frames; `edit` returns what to send in place of
/// each one (nothing, the frame changed, or several frames).
async fn mitm(
    mut from_host: DuplexStream,
    mut to_dl: DuplexStream,
    mut edit: impl FnMut(usize, Vec<u8>) -> Vec<Vec<u8>> + Send + 'static,
) {
    let mut i = 0;
    loop {
        let mut len = [0u8; 4];
        if from_host.read_exact(&mut len).await.is_err() {
            break;
        }
        let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
        if from_host.read_exact(&mut body).await.is_err() {
            break;
        }
        for body in edit(i, body) {
            let _ = to_dl.write_all(&(body.len() as u32).to_le_bytes()).await;
            let _ = to_dl.write_all(&body).await;
        }
        i += 1;
    }
    let _ = to_dl.shutdown().await;
}

/// Run a transfer through `edit` (frame 0 is the header; then chunks; then the trailer).
async fn run_through(
    integrity: bool,
    edit: impl FnMut(usize, Vec<u8>) -> Vec<Vec<u8>> + Send + 'static,
) -> (ferrozine::Result<()>, bool) {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 1000);
    let (h, _) = host(100, integrity);
    let offer = h.offer(&path).unwrap();
    let prepared = file::prepare(&offer.offer_id).unwrap();
    h.authorize(&offer.offer_id, &prepared.commitment());
    let (host_w, proxy_r) = tokio::io::duplex(256 * 1024);
    let (proxy_w, dl_r) = tokio::io::duplex(256 * 1024);
    let (dl_w, host_r) = tokio::io::duplex(256 * 1024);
    tokio::spawn(mitm(proxy_r, proxy_w, edit));
    let h2 = h.clone();
    tokio::spawn(async move { h2.serve(host_r, host_w).await });
    let dest = dir.path().join("out");
    let result = file::receive(
        prepared,
        dl_r,
        dl_w,
        &dest,
        false,
        LIMITS,
        file::ignore_events(),
    )
    .await;
    (result, dest.exists())
}

#[tokio::test]
async fn a_flipped_byte_in_a_chunk_is_refused_and_the_partial_file_removed() {
    let (result, exists) = run_through(false, |i, mut b| {
        if i == 3 {
            let at = b.len() / 2;
            b[at] ^= 1;
        }
        vec![b]
    })
    .await;
    assert!(matches!(result, Err(Error::Mls(_))), "{result:?}");
    assert!(!exists);
}

#[tokio::test]
async fn a_dropped_chunk_is_refused() {
    let (result, exists) = run_through(true, |i, b| if i == 4 { vec![] } else { vec![b] }).await;
    assert!(result.is_err(), "{result:?}");
    assert!(!exists);
}

#[tokio::test]
async fn a_swapped_pair_of_chunks_is_refused() {
    // Frames 2 and 3 (chunks 1 and 2) delivered as 3, 2: each is genuine MLS
    // from the host, so only the sealed sequence number can catch it.
    let mut held = None;
    let (result, exists) = run_through(false, move |i, b| match i {
        2 => {
            held = Some(b);
            vec![]
        }
        3 => vec![b, held.take().unwrap()],
        _ => vec![b],
    })
    .await;
    assert!(result.is_err(), "{result:?}");
    assert!(!exists);
}

#[tokio::test]
async fn a_stream_cut_before_the_end_is_refused_even_without_the_chain() {
    // 1000 bytes in 100-byte chunks: header + 10 chunks. Stop after 5.
    let (result, exists) = run_through(false, |i, b| if i <= 5 { vec![b] } else { vec![] }).await;
    assert!(matches!(result, Err(Error::Integrity(_))), "{result:?}");
    assert!(!exists);
}

#[tokio::test]
async fn a_missing_trailer_is_refused_when_the_chain_was_promised() {
    let (result, _) = run_through(true, |i, b| if i <= 10 { vec![b] } else { vec![] }).await;
    assert!(matches!(result, Err(Error::Integrity(_))), "{result:?}");
}

#[tokio::test]
async fn a_header_announcing_chunks_beyond_the_limits_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 10);
    let (obs, _) = recorder();
    let big = Limits {
        min_chunk: 16,
        max_chunk: 1 << 20,
    };
    let h = FileHost::new(
        big,
        || HostSettings {
            chunk_size: 1 << 20,
            integrity: false,
        },
        obs,
    );
    let offer = h.offer(&path).unwrap();
    let prepared = file::prepare(&offer.offer_id).unwrap();
    h.authorize(&offer.offer_id, &prepared.commitment());
    let ((dl_recv, dl_send), (h_recv, h_send)) = streams();
    tokio::spawn(async move { h.serve(h_recv, h_send).await });
    let result = file::receive(
        prepared,
        dl_recv,
        dl_send,
        &dir.path().join("o"),
        false,
        LIMITS,
        file::ignore_events(),
    )
    .await;
    assert!(matches!(result, Err(Error::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn a_transfer_counts_as_active_while_it_runs() {
    // Other tests run in parallel and also count, so this checks only that a
    // live transfer is counted, not that the count returns to zero.
    let (h, _) = host(64, false);
    let ((_dl_recv, _dl_send), (h_recv, h_send)) = streams();
    let server = tokio::spawn(async move { h.serve(h_recv, h_send).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        file::transfers_active(),
        "a host waiting for its request counts"
    );
    server.abort();
}

#[tokio::test]
async fn a_flipped_byte_anywhere_in_a_chunk_is_an_error_never_a_panic() {
    // Every position of one sealed chunk, including the AEAD tag openmls
    // debug-asserts on.
    for at in [0usize, 5, 20, 40, 60, 80, 99, 100] {
        let (result, exists) = run_through(false, move |i, mut b| {
            if i == 2 {
                let idx = at.min(b.len() - 1);
                b[idx] ^= 0x40;
            }
            vec![b]
        })
        .await;
        assert!(result.is_err(), "flip at {at}");
        assert!(!exists);
    }
}

// ── regressions from the review of the extraction ────────────────────────────

#[tokio::test]
async fn a_download_that_fails_before_writing_leaves_an_existing_file_alone() {
    // The user picked an existing file as the destination; the host then
    // refused the downloader. The old file must survive.
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 100);
    let (h, _) = host(64, false);
    let offer = h.offer(&path).unwrap();
    let dest = dir.path().join("report.pdf");
    std::fs::write(&dest, b"the user's own file").unwrap();
    let someone_else = file::prepare(&offer.offer_id).unwrap().commitment();
    let (client, _) = run(&h, &offer.offer_id, Some(&someone_else), &dest, false).await;
    assert!(client.is_err());
    assert_eq!(std::fs::read(&dest).unwrap(), b"the user's own file");
}

#[tokio::test]
async fn a_verified_file_is_kept_when_its_ack_cannot_be_delivered() {
    let dir = tempfile::tempdir().unwrap();
    let (path, bytes) = write_file(dir.path(), "f", 5000);
    let (h, _) = host(512, true);
    let offer = h.offer(&path).unwrap();
    let prepared = file::prepare(&offer.offer_id).unwrap();
    h.authorize(&offer.offer_id, &prepared.commitment());

    // Downloader → host carries the request and then hangs up, so the
    // downloader's final ack has nowhere to go.
    let (host_w, dl_r) = tokio::io::duplex(256 * 1024);
    let (dl_w, mut proxy_r) = tokio::io::duplex(256 * 1024);
    let (mut proxy_w, host_r) = tokio::io::duplex(256 * 1024);
    tokio::spawn(async move {
        let mut len = [0u8; 4];
        proxy_r.read_exact(&mut len).await.unwrap();
        let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
        proxy_r.read_exact(&mut body).await.unwrap();
        proxy_w.write_all(&len).await.unwrap();
        proxy_w.write_all(&body).await.unwrap();
        // Dropping both ends here.
    });
    let h2 = h.clone();
    tokio::spawn(async move { h2.serve(host_r, host_w).await });
    let dest = dir.path().join("out");
    file::receive(
        prepared,
        dl_r,
        dl_w,
        &dest,
        false,
        LIMITS,
        file::ignore_events(),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_never_sends_its_request_times_out() {
    let (h, _) = host(64, false);
    let ((_dl_recv, _dl_send), (h_recv, h_send)) = streams();
    let server = tokio::spawn(async move { h.serve(h_recv, h_send).await });
    tokio::time::advance(Duration::from_secs(31)).await;
    assert!(matches!(server.await.unwrap(), Err(Error::Protocol(_))));
}

#[tokio::test(start_paused = true)]
async fn connections_beyond_the_cap_are_refused_at_once() {
    let (h, _) = host(64, false);
    let mut idle = Vec::new();
    for _ in 0..file::MAX_CONCURRENT_SERVES {
        let ((dl_recv, dl_send), (h_recv, h_send)) = streams();
        let h2 = h.clone();
        idle.push((
            dl_recv,
            dl_send,
            tokio::spawn(async move { h2.serve(h_recv, h_send).await }),
        ));
    }
    tokio::task::yield_now().await;
    let ((_r, _s), (h_recv, h_send)) = streams();
    assert!(matches!(
        h.serve(h_recv, h_send).await,
        Err(Error::Connection(_))
    ));
}

#[test]
fn user_visible_messages_keep_their_old_wording() {
    // Vesper shows these verbatim; the extraction must not reword them.
    assert_eq!(
        Error::Integrity("integrity check failed — the file was altered in transit".into())
            .to_string(),
        "integrity check failed — the file was altered in transit"
    );
    assert_eq!(
        Error::Io(std::io::Error::other("disk full")).to_string(),
        "disk full"
    );
}

// ── tickets: one-time secrets instead of a signalling channel ────────────────

fn ticket_for(h: &FileHost, path: &Path) -> file::Ticket {
    let offer = h.offer(path).unwrap();
    let addr = iroh::EndpointAddr::new(iroh::SecretKey::from_bytes(&[9; 32]).public());
    let ticket = file::Ticket::new(addr, &offer).unwrap();
    h.authorize_with_secret(&offer.offer_id, &ticket.secret);
    ticket
}

async fn fetch(
    h: &FileHost,
    prepared: file::Prepared,
    dest: &Path,
) -> (ferrozine::Result<()>, ferrozine::Result<()>) {
    let ((dl_recv, dl_send), (h_recv, h_send)) = streams();
    let h2 = h.clone();
    let server = tokio::spawn(async move { h2.serve(h_recv, h_send).await });
    let client = file::receive(
        prepared,
        dl_recv,
        dl_send,
        dest,
        false,
        LIMITS,
        file::ignore_events(),
    )
    .await;
    (client, server.await.unwrap())
}

#[tokio::test]
async fn a_ticket_holder_fetches_the_file_and_the_ticket_then_stops_working() {
    let dir = tempfile::tempdir().unwrap();
    let (path, bytes) = write_file(dir.path(), "holiday.jpg", 3000);
    let (h, _) = host(256, true);
    let ticket = ticket_for(&h, &path);
    assert_eq!((ticket.name.as_str(), ticket.size), ("holiday.jpg", 3000));

    let dest = dir.path().join("got");
    let (client, server) = fetch(&h, file::prepare_for_ticket(&ticket).unwrap(), &dest).await;
    client.unwrap();
    server.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);

    // The same ticket again, with a fresh KeyPackage: refused.
    let again = dir.path().join("again");
    let (client, server) = fetch(&h, file::prepare_for_ticket(&ticket).unwrap(), &again).await;
    assert!(matches!(server, Err(Error::Unauthorized(_))), "{server:?}");
    assert!(client.is_err());
    assert!(!again.exists());
}

#[tokio::test]
async fn a_wrong_secret_or_no_claim_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 100);
    let (h, _) = host(64, false);
    let mut ticket = ticket_for(&h, &path);
    let real = ticket.secret;

    ticket.secret[0] ^= 1;
    let (_, server) = fetch(
        &h,
        file::prepare_for_ticket(&ticket).unwrap(),
        &dir.path().join("a"),
    )
    .await;
    assert!(matches!(server, Err(Error::Unauthorized(_))));

    // A plain prepare (no claim) for a ticket offer.
    let (_, server) = fetch(
        &h,
        file::prepare(&ticket.offer_id).unwrap(),
        &dir.path().join("b"),
    )
    .await;
    assert!(matches!(server, Err(Error::Unauthorized(_))));

    // The failures did not burn the ticket: the real secret still works.
    ticket.secret = real;
    let (client, _) = fetch(
        &h,
        file::prepare_for_ticket(&ticket).unwrap(),
        &dir.path().join("c"),
    )
    .await;
    client.unwrap();
}

#[tokio::test]
async fn of_two_simultaneous_ticket_holders_exactly_one_gets_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 20_000);
    let (h, _) = host(1024, false);
    let ticket = ticket_for(&h, &path);
    let (dest_a, dest_b) = (dir.path().join("a"), dir.path().join("b"));
    let (a, b) = tokio::join!(
        fetch(&h, file::prepare_for_ticket(&ticket).unwrap(), &dest_a),
        fetch(&h, file::prepare_for_ticket(&ticket).unwrap(), &dest_b),
    );
    let wins = [a.0.is_ok(), b.0.is_ok()];
    assert_eq!(wins.iter().filter(|w| **w).count(), 1, "{wins:?}");
}

#[tokio::test]
async fn a_commitment_offer_ignores_a_ticket_claim() {
    // A downloader that sends a claim to an offer authorized by commitment is
    // judged on its commitment alone (a claim never widens access).
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 100);
    let (h, _) = host(64, false);
    let offer = h.offer(&path).unwrap();
    let addr = iroh::EndpointAddr::new(iroh::SecretKey::from_bytes(&[9; 32]).public());
    let forged = file::Ticket::new(addr, &offer).unwrap();
    h.authorize(
        &offer.offer_id,
        &file::prepare(&offer.offer_id).unwrap().commitment(),
    );
    let (_, server) = fetch(
        &h,
        file::prepare_for_ticket(&forged).unwrap(),
        &dir.path().join("x"),
    )
    .await;
    assert!(matches!(server, Err(Error::Unauthorized(_))));
}

// ── ticket lifecycle: retry after failure, one at a time, wall-clock expiry ───

/// Fetch through a proxy that passes `frames` host→downloader frames and then
/// drops the connection.
async fn fetch_cut_after(
    h: &FileHost,
    prepared: file::Prepared,
    dest: &Path,
    frames: usize,
) -> ferrozine::Result<()> {
    let (host_w, mut proxy_r) = tokio::io::duplex(4096);
    let (mut proxy_w, dl_r) = tokio::io::duplex(256 * 1024);
    let (dl_w, host_r) = tokio::io::duplex(256 * 1024);
    tokio::spawn(async move {
        for _ in 0..frames {
            let mut len = [0u8; 4];
            if proxy_r.read_exact(&mut len).await.is_err() {
                return;
            }
            let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
            proxy_r.read_exact(&mut body).await.unwrap();
            proxy_w.write_all(&len).await.unwrap();
            proxy_w.write_all(&body).await.unwrap();
        }
    });
    let h2 = h.clone();
    let server = tokio::spawn(async move { h2.serve(host_r, host_w).await });
    let client = file::receive(
        prepared,
        dl_r,
        dl_w,
        dest,
        false,
        LIMITS,
        file::ignore_events(),
    )
    .await;
    let _ = server.await;
    client
}

#[tokio::test]
async fn a_ticket_transfer_cut_short_can_be_retried_with_the_same_link() {
    let dir = tempfile::tempdir().unwrap();
    let (path, bytes) = write_file(dir.path(), "big.bin", 200_000);
    let (h, _) = host(1000, false);
    let ticket = ticket_for(&h, &path);
    let dest = dir.path().join("got");
    assert!(
        fetch_cut_after(&h, file::prepare_for_ticket(&ticket).unwrap(), &dest, 3)
            .await
            .is_err()
    );
    // The receiver's network came back: same link, fresh KeyPackage.
    let (client, server) = fetch(&h, file::prepare_for_ticket(&ticket).unwrap(), &dest).await;
    client.unwrap();
    server.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);
}

#[tokio::test]
async fn while_a_ticket_transfer_runs_a_second_holder_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 500_000);
    let (h, log) = host(1000, false);
    let ticket = ticket_for(&h, &path);

    // The first downloader is admitted, then stalls: its proxy stops reading
    // after the header, so the host blocks mid-file with the ticket in use.
    let (host_w, mut proxy_r) = tokio::io::duplex(1024);
    let (mut proxy_w, dl_r) = tokio::io::duplex(256 * 1024);
    let (dl_w, host_r) = tokio::io::duplex(256 * 1024);
    let stall = tokio::spawn(async move {
        let mut len = [0u8; 4];
        proxy_r.read_exact(&mut len).await.unwrap();
        let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
        proxy_r.read_exact(&mut body).await.unwrap();
        proxy_w.write_all(&len).await.unwrap();
        proxy_w.write_all(&body).await.unwrap();
        std::future::pending::<()>().await;
        drop((proxy_r, proxy_w));
    });
    let h2 = h.clone();
    tokio::spawn(async move { h2.serve(host_r, host_w).await });
    let first = file::prepare_for_ticket(&ticket).unwrap();
    let dest1 = dir.path().join("one");
    tokio::spawn(async move {
        file::receive(
            first,
            dl_r,
            dl_w,
            &dest1,
            false,
            LIMITS,
            file::ignore_events(),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;

    let (_, server) = fetch(
        &h,
        file::prepare_for_ticket(&ticket).unwrap(),
        &dir.path().join("two"),
    )
    .await;
    assert!(
        matches!(&server, Err(Error::Unauthorized(m)) if m.contains("being used")),
        "{server:?}"
    );
    assert!(log
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, TransferEvent::Refused { .. })));
    stall.abort();
}

#[tokio::test]
async fn a_ticket_past_its_wall_clock_deadline_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = write_file(dir.path(), "f", 10);
    let (h, _) = host(64, false);
    let offer = h.offer(&path).unwrap();
    let addr = iroh::EndpointAddr::new(iroh::SecretKey::from_bytes(&[9; 32]).public());
    let ticket = file::Ticket::new(addr, &offer).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    h.authorize_with_secret_until(&offer.offer_id, &ticket.secret, now - 1);
    let (_, server) = fetch(
        &h,
        file::prepare_for_ticket(&ticket).unwrap(),
        &dir.path().join("x"),
    )
    .await;
    assert!(
        matches!(&server, Err(Error::Unauthorized(m)) if m.contains("expired")),
        "{server:?}"
    );
    // And one still inside its deadline is served.
    h.authorize_with_secret_until(&offer.offer_id, &ticket.secret, now + 600);
    let (client, _) = fetch(
        &h,
        file::prepare_for_ticket(&ticket).unwrap(),
        &dir.path().join("y"),
    )
    .await;
    client.unwrap();
}
