# Slint ↔ Tauri parity

The Tauri/Vue app (`apps/enigma`) is retired once every row below is **done** or
**n/a** (b2.md, decision 2026-11-27). Sources read: `apps/enigma/src` (views,
components, stores, router, i18n) and the `invoke_handler` in
`apps/enigma/src-tauri/src/lib.rs`.

Status: **done** = works in the Slint app for real (not only `--demo`);
**todo** = not yet; **n/a** = made obsolete by design (reason given).
"TUI" says whether `enigma-tui` has it too (it may skip media). TUI features beyond the
main screen are `:` commands (`:help` lists them).

Tests named in a row run headless (`cargo test -p enigma-app -p enigma27 -p
enigma-tui`): no real Tor, the client link runs to beacon-node relays in an in-memory
`Directory` (tests only; the app itself only dials Your Beacon over Tor).

## 1. Foundations

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 1.1 | Rooms list + chat timeline, bubbles, letter avatars | `ChatPanel.vue`, `RoomsSidebar.vue`, `ChatBubble.vue`, `LetterAvatar.vue` | done | done |
| 1.2 | Light/dark theme incl. text fields | `style.css`, `stores/ui.ts` | done (`set-dark` drives `Palette.color-scheme`) | n/a (terminal) |
| 1.3 | EN/PL texts | `i18n/en.ts`, `i18n/pl.ts` | done (`enigma-app::i18n`) | done |
| 1.4 | Real backend (vault, device key, MLS store, client link over Tor) | `src-tauri/src/{vault,device,lib}.rs` | done (`enigma_app::real::RealBackend`: vault-backed engine Kv + MLS store + device seed; `enigma-client` to Your Beacon over `pharos-tor`; invitations over the client link with `admit_invited_via`; test `tests/real.rs`) | done |

## 2. Storage & security

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 2.1 | Passphrase vault (protasius): create / unlock / lock | `vault::vault_setup/unlock/lock/status`, `App.vue` lock screen | done (Welcome / lock screen, 🔒 in the sidebar and ☰; `Session`) | done (gate before the app, Ctrl+L / `:lock`) |
| 2.2 | Change passphrase | `vault_change_passphrase`, `EnigmaConfigView` | done (Settings → Security) | done (`:passwd`) |
| 2.3 | Idle lock (minutes) + warning | `idleLock.ts`, `IdleLockWarning.vue`, `vault_touch` | done (Settings; warning overlay the last 20 s) | n/a (console session) |
| 2.4 | Lock on hide | `EnigmaConfigView` (lockOnHide) | done (minimised / hidden window) | n/a |
| 2.5 | PIN unlock (enroll / unlock / clear, tries) | `vault_pin_*`, `PinPad.vue` | done (memory only, 5 tries, as Tauri) | n/a |
| 2.6 | Panic code (set / clear / wipe on entry) | `vault_set/clear/has_panic_code`, `vault_wipe` | done (typing it at unlock wipes every profile and opens an empty app) | done (`:panic`, `:panic-clear`) |
| 2.7 | Erase everything (danger zone) | `vault_wipe`, `app_clear_profile_state` | done (type ERASE) | done (`:erase ERASE`) |
| 2.8 | Profiles (several per device, switch) | `app_set_active_profile`, offline profile cmds | done (Settings and the lock screen) | done (`:profile NAME`) |
| 2.9 | Encrypted kv for app state (rooms, timeline, friends, settings) | `vault::kv_*` | done | done |
| 2.10 | MLS sessions in the vault (`mls` ns) | `VaultMls`, `mls_*` cmds | done (`VaultMls`, same keys; restart test in `tests/real.rs`) | done |
| 2.11 | Tor keystore cleanup | `tor_clean_keystore` | n/a (b2: no per-room onions; one client Tor state dir) | n/a |
| 2.12 | Migration of an existing Tauri profile | Tauri data dir `com.spectrumaipl.enigma27` | done (same data dir and vault layout, so it opens with its passphrase; the lock screen says so; vault test `a_tauri_profile_opens_with_the_same_layout`. Tauri's segmented chat logs are not imported) | done |

## 3. Identity & network

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 3.1 | Device key (Ed25519 in vault `keys/device_ed25519`) | `device.rs` | done | done |
| 3.2 | Tor indicator | `TorIndicator.vue`, `stores/tor.ts`, `mesh::tor_status` | done (from the real Tor client: off / starting / on / error) | done |
| 3.3 | Your Beacon card: set / scan / remove `pharos-beacon:` code | `BeaconCard.vue`, `beacon_parse_code` | done (paste, read from a picture, remove) | done (`b`, `:beacon`) |
| 3.4 | Enable Beacon (in-process Relay, own onion, sealed queue) | new in b2 (Tauri had none) | n/a — client and Beacon are separate apps (b2.md 2026-11-27): the Beacon is `apps/pharos-lighthouse` / `beacon` | n/a — same |
| 3.5 | Offline mode | `app_get/set_offline`, `stores/network.ts` | done (Tor and the link stop) | done (`:offline`) |
| 3.6 | Connection timeout setting | `EnigmaConfigView` connectTimeout | done (10–300 s, dial + handshake) | done (`:timeout`) |
| 3.7 | Per-room onions, realtime mesh (`realtime_*`, `mesh_live.rs`) | `realtime.rs`, `mesh.rs` | n/a (b2: Beacons-only mesh, devices only dial their Beacon) | n/a |
| 3.8 | Beacon mailbox polling (`beacon_post/fetch`, discovery key) | `beaconMailbox.ts`, `beacon.rs` | n/a (b2: the Beacon queues frames on the client link) | n/a |
| 3.9 | "Only my phones": this device's discovery key for Your Beacon | `beacon_discovery_key` | done (Settings → Your Beacon, once Tor is up; `pharos-tor` `client-discovery`) | done (`:key`) |

## 4. Rooms

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 4.1 | Create room | `CreateRoomModal.vue` | done | done |
| 4.2 | Join room (by invitation) | `JoinRoomModal.vue` | done | done |
| 4.3 | Leave / delete room | `ChatHeader.vue`, `DeleteRoomModal.vue` | done (real: leave keeps the Beacon membership, delete forgets; test `personal_invitations_leave_and_delete_for_real`) | done |
| 4.4 | Room info | `RoomInfoModal.vue` | done | done (`:info`) |
| 4.5 | Participants list | `ParticipantsModal.vue`, `ParticipantsPanel.vue` | done | done |
| 4.6 | Reset encryption (signed reset) | `device::reset_sign/verify` | done (engine) | done |
| 4.7 | Unread counts, saved rooms list | `SavedRoomsList.vue`, `RoomListRow.vue` | done | done |
| 4.8 | Observer banner (not yet a member) | `ObserverBanner.vue` | done (waiting to be let in / alone in the room) | done (footer) |

## 5. Invitations

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 5.1 | Personal invitation (to a friend) with TTL | `RoomShareCard.vue`, `invite_create` | done (Invite page: valid for / for whom; refused to other devices) | done (`:invite 1h NAME`) |
| 5.2 | General invitation (bearer code) with TTL | `RoomShareCard.vue`, `invite_create` | done | done (`:invite 1d`) |
| 5.3 | List / revoke / states (active, used, expired, withdrawn) | `invite_list/get/revoke` | done | done (`:invites`, `:revoke`) |
| 5.4 | Peek (what a code is before redeeming) | `invite_peek`, `invite_is_invite` | done (Join → Check) | done (`:peek`) |
| 5.5 | Redeem through the inviter's Beacon (`redeem` / `answer_redeem`, `admit_invited_via`) | `invite_redeem.rs`, `useInviteAdmit.ts` | done | done |
| 5.6 | Invitation QR + copy | `RoomShareCard.vue` | done | done |
| 5.7 | Room tickets (permanent) | `invite_ticket.rs` | n/a (closed by design: `invite.closedNotice`) | n/a |

## 6. Messages & media

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 6.1 | Text messages | `MessageComposer.vue` | done | done |
| 6.2 | Images (send, show) | `AttachmentPreview.vue`, engine `send_image` | done (🖼: a file path; scaled to 1280 px, re-encoded JPEG so no EXIF leaves; shown in the bubble) | n/a |
| 6.3 | Voice notes (record / play) | `VoiceRecorderButton.vue`, `audio_*` | done on desktop (cpal + WAV); Android: not yet (says so) | n/a |
| 6.4 | File transfer (offer / accept / progress) | `FilePanel.vue`, `useFileShare.ts`, `files.rs`, Files tab | done (Files page; chunks as MLS-sealed sync messages through the Beacons, sha256 checked, saved to `~/Downloads/Enigma27`) | n/a |
| 6.5 | Emoji picker | `EmojiPicker.vue` | n/a — by design: no emoji picker (user decision 2026-11-27); typed emoji still display | n/a |
| 6.6 | Notifications (new message while away) | `ChatPanel.vue` (tauri notification) | done on desktop (notify-rust, when the window is hidden or another page is open; Settings switch); Android: not yet | n/a |
| 6.7 | Deep links `enigma://room/...` | `deeplink.ts`, `deeplink_take` | done (`enigma enigma://room/NAME[/tag][?to=&quote=]`; registering the scheme with the OS: see README) | done (`:open`) |
| 6.8 | History saved in the vault | `chat:log` | done (engine timeline in kv `chat:log`, restart test) | done |

## 7. Friends & settings

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 7.1 | Friends pairing code + QR + check code | `EnigmaFriendsView.vue`, `stores/friends.ts` | done (in the vault; a friend's QR can be read from a picture) | done |
| 7.2 | Nickname | `EnigmaProfileView.vue` | done (in the vault) | done |
| 7.3 | Language | `EnigmaConfigView` | done | done |
| 7.4 | Theme choice (system / light / dark) | `stores/ui.ts` | done | n/a |
| 7.5 | Tab visibility (Chat / Files / Friends) | `tabs.ts`, `EnigmaConfigView` | done | n/a |
| 7.6 | Max file size / chunk size | `EnigmaConfigView` | done | n/a |
| 7.7 | Welcome / about page | `EnigmaWelcomeView.vue` | done (first-run screen; about text in Settings) | done (gate) |
| 7.8 | Remove friend | `EnigmaFriendsView.vue` | done | done (`:unfriend`) |

## 8. Platforms

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 8.1 | QR scan by camera | `QrScannerModal.vue` | n/a for now — Slint 1.x has no camera widget and the Android build has no camera glue yet; scan from a picture instead (8.2), e.g. one taken with the phone's camera app. Plan in README ("Camera") | n/a |
| 8.2 | QR scan from an image file | `QrScannerModal.vue` (file input) | done (rqrr; Join, Friends, Your Beacon) | n/a |
| 8.3 | Responsive phone layout on narrow windows | Tailwind breakpoints | done (below 700 px wide, set from Rust each tick: no binding loop) | n/a |
| 8.4 | Android APK | Tauri Android | done (`cargo apk build --lib`; the phone runs the real client) | n/a |
| 8.5 | Windows build | Tauri Windows | see README ("Windows"): not built here | n/a |
| 8.6 | Packaging / CI notes | Tauri bundler | done (README) | n/a |
