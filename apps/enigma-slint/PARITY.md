# Slint ↔ Tauri parity

The Tauri/Vue app (`apps/enigma`) is retired once every row below is **done** or
**n/a** (b2.md, decision 2026-11-27). Sources read: `apps/enigma/src` (views,
components, stores, router, i18n) and the `invoke_handler` in
`apps/enigma/src-tauri/src/lib.rs`.

Status: **done** = works in the Slint app for real (not only `--demo`);
**todo** = not yet; **n/a** = made obsolete by design (reason given).
"TUI" says whether `enigma-tui` has it too (it may skip media).

## 1. Foundations

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 1.1 | Rooms list + chat timeline, bubbles, letter avatars | `ChatPanel.vue`, `RoomsSidebar.vue`, `ChatBubble.vue`, `LetterAvatar.vue` | done | done |
| 1.2 | Light/dark theme incl. text fields | `style.css`, `stores/ui.ts` | done (`set-dark` drives `Palette.color-scheme`) | n/a (terminal) |
| 1.3 | EN/PL texts | `i18n/en.ts`, `i18n/pl.ts` | done (`enigma-app::i18n`) | done |
| 1.4 | Real backend (vault, device key, MLS store, client link over Tor) | `src-tauri/src/{vault,device,lib}.rs` | todo | todo |

## 2. Storage & security

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 2.1 | Passphrase vault (protasius): create / unlock / lock | `vault::vault_setup/unlock/lock/status`, `App.vue` lock screen | todo | todo |
| 2.2 | Change passphrase | `vault_change_passphrase`, `EnigmaConfigView` | todo | todo |
| 2.3 | Idle lock (minutes) + warning | `idleLock.ts`, `IdleLockWarning.vue`, `vault_touch` | todo | n/a (console session) |
| 2.4 | Lock on hide | `EnigmaConfigView` (lockOnHide) | todo | n/a |
| 2.5 | PIN unlock (enroll / unlock / clear, tries) | `vault_pin_*`, `PinPad.vue` | todo | n/a |
| 2.6 | Panic code (set / clear / wipe on entry) | `vault_set/clear/has_panic_code`, `vault_wipe` | todo | todo |
| 2.7 | Erase everything (danger zone) | `vault_wipe`, `app_clear_profile_state` | todo | todo |
| 2.8 | Profiles (several per device, switch) | `app_set_active_profile`, offline profile cmds | todo | todo |
| 2.9 | Encrypted kv for app state (rooms, timeline, friends, settings) | `vault::kv_*` | todo | todo |
| 2.10 | MLS sessions in the vault (`mls` ns) | `VaultMls`, `mls_*` cmds | todo | todo |
| 2.11 | Tor keystore cleanup | `tor_clean_keystore` | n/a (b2: no per-room onions; one client Tor state dir) | n/a |

## 3. Identity & network

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 3.1 | Device key (Ed25519 in vault `keys/device_ed25519`) | `device.rs` | todo | todo |
| 3.2 | Tor indicator | `TorIndicator.vue`, `stores/tor.ts`, `mesh::tor_status` | done (label; real state with 1.4) | done |
| 3.3 | Your Beacon card: set / scan / remove `pharos-beacon:` code | `BeaconCard.vue`, `beacon_parse_code` | todo | todo |
| 3.4 | Enable Beacon (in-process Relay, own onion, sealed queue) | new in b2 (Tauri had none) | todo (desktop); n/a Android (client only) | todo |
| 3.5 | Offline mode | `app_get/set_offline`, `stores/network.ts` | todo | todo |
| 3.6 | Connection timeout setting | `EnigmaConfigView` connectTimeout | todo | todo |
| 3.7 | Per-room onions, realtime mesh (`realtime_*`, `mesh_live.rs`) | `realtime.rs`, `mesh.rs` | n/a (b2: Beacons-only mesh, devices only dial their Beacon) | n/a |
| 3.8 | Beacon mailbox polling (`beacon_post/fetch`, discovery key) | `beaconMailbox.ts`, `beacon.rs` | n/a (b2: the Beacon queues frames on the client link) | n/a |

## 4. Rooms

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 4.1 | Create room | `CreateRoomModal.vue` | done (demo) / todo real | done (demo) |
| 4.2 | Join room (by invitation) | `JoinRoomModal.vue` | done (demo) / todo real | done (demo) |
| 4.3 | Leave / delete room | `ChatHeader.vue`, `DeleteRoomModal.vue` | done | done |
| 4.4 | Room info | `RoomInfoModal.vue` | todo | todo |
| 4.5 | Participants list | `ParticipantsModal.vue`, `ParticipantsPanel.vue` | done | done |
| 4.6 | Reset encryption (signed reset) | `device::reset_sign/verify` | done (engine) | done |
| 4.7 | Unread counts, saved rooms list | `SavedRoomsList.vue`, `RoomListRow.vue` | done | done |
| 4.8 | Observer banner (not yet a member) | `ObserverBanner.vue` | todo | todo |

## 5. Invitations

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 5.1 | Personal invitation (to a friend) with TTL | `RoomShareCard.vue`, `invite_create` | todo | todo |
| 5.2 | General invitation (bearer code) with TTL | `RoomShareCard.vue`, `invite_create` | todo | todo |
| 5.3 | List / revoke / states (active, used, expired, withdrawn) | `invite_list/get/revoke` | todo | todo |
| 5.4 | Peek (what a code is before redeeming) | `invite_peek`, `invite_is_invite` | todo | todo |
| 5.5 | Redeem through the inviter's Beacon (`redeem` / `answer_redeem`, `admit_invited_via`) | `invite_redeem.rs`, `useInviteAdmit.ts` | todo | todo |
| 5.6 | Invitation QR + copy | `RoomShareCard.vue` | done | done |
| 5.7 | Room tickets (permanent) | `invite_ticket.rs` | n/a (closed by design: `invite.closedNotice`) | n/a |

## 6. Messages & media

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 6.1 | Text messages | `MessageComposer.vue` | done | done |
| 6.2 | Images (send, show) | `AttachmentPreview.vue`, engine `send_image` | todo | n/a |
| 6.3 | Voice notes (record / play) | `VoiceRecorderButton.vue`, `audio_*` | todo | n/a |
| 6.4 | File transfer (offer / accept / progress) | `FilePanel.vue`, `useFileShare.ts`, `files.rs`, Files tab | todo | n/a |
| 6.5 | Emoji picker | `EmojiPicker.vue` | todo | n/a |
| 6.6 | Notifications (new message while away) | `ChatPanel.vue` (tauri notification) | todo | n/a |
| 6.7 | Deep links `enigma://room/...` | `deeplink.ts`, `deeplink_take` | todo | todo |

## 7. Friends & settings

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 7.1 | Friends pairing code + QR + check code | `EnigmaFriendsView.vue`, `stores/friends.ts` | done (persisted with 2.9) | done |
| 7.2 | Nickname | `EnigmaProfileView.vue` | done (persisted with 2.9) | done |
| 7.3 | Language | `EnigmaConfigView` | done | done |
| 7.4 | Theme choice (system / light / dark) | `stores/ui.ts` | todo | n/a |
| 7.5 | Tab visibility (Chat / Files / Friends) | `tabs.ts`, `EnigmaConfigView` | todo | n/a |
| 7.6 | Max file size / chunk size | `EnigmaConfigView` | todo | n/a |
| 7.7 | Welcome / about page | `EnigmaWelcomeView.vue` | todo | todo |

## 8. Platforms

| # | Feature | Tauri location | Slint | TUI |
|---|---------|----------------|-------|-----|
| 8.1 | QR scan by camera | `QrScannerModal.vue` | todo | n/a |
| 8.2 | QR scan from an image file | `QrScannerModal.vue` (file input) | todo | n/a |
| 8.3 | Responsive phone layout on narrow windows | Tailwind breakpoints | todo (only Android sets `narrow`; desktop window size not yet) | n/a |
| 8.4 | Android APK | Tauri Android | done (`cargo apk build --lib`) | n/a |
