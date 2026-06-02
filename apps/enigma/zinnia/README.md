# Enigma

A cross-platform productivity + chat suite with end-to-end encryption. Built with Tauri (Rust) + Vue 3. Connects to the toto Django backend.

## Screens

| Screen | Route | Backed by |
|--------|-------|-----------|
| Chat | `/chat` | `toto.telegraph` WebSocket + MLS encryption |
| Notes | `/notes` | `toto.bento` JSON API |
| Storage | `/vault` | `toto.vault` JSON API |
| Tasks | `/tasks` | `toto.kanban` JSON API |
| Locations | `/locations` | `toto.locations` JSON API |
| People | `/people` | `toto.socialhub` JSON API |
| Wallet | `/wallet` | `toto.assets` + `toto.tariffs` + `toto.invoice` JSON API |

---

## Running — Browser Mode (quickest, no Rust needed)

In browser mode the app runs inside a normal browser tab. MLS encryption is disabled (chat falls back to plaintext). Auth token and server URL are stored in `localStorage`.

```bash
cd enigma/enigma
npm install        # once
npm run dev        # starts Vite dev server
```

Then open **http://localhost:1420** in your browser.

All 7 screens (Notes, Storage, Tasks, Locations, People, Wallet, Chat) are fully functional in browser mode. The only missing feature is MLS end-to-end encryption, which requires the Tauri desktop runtime.

---

## Running — Desktop App Mode (full features, Tauri required)

Desktop mode opens a native window. MLS encryption, Rust-backed secure storage, and native file pickers all work.

### Prerequisites (first time only)

**1. Install Rust**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

**2. Install system libraries (Linux)**
```bash
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  pkg-config
```

**3. Install JS dependencies**
```bash
cd enigma/enigma
npm install
```

### Start a single desktop instance

```bash
cd enigma/enigma
APP_PROFILE=alice CHAT_USER=alice npm run tauri dev
```

A native desktop window opens. The Vite dev server also starts at `localhost:1420` but the window uses Tauri's webview — `window.__TAURI_INTERNALS__` is available, so MLS and secure storage are active.

### Run two instances side-by-side (local multi-user testing)

Each instance gets an isolated profile, MLS identity, and auth token.

```bash
# Terminal 1 — starts Vite + opens first window
APP_PROFILE=alice CHAT_USER=alice npm run tauri dev

# Terminal 2 — reuses the already-running Vite server
APP_PROFILE=bob CHAT_USER=bob npx tauri dev --no-dev-server
```

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `APP_PROFILE` | Isolates storage per identity (e.g. `alice`, `bob`) | `default` |
| `CHAT_USER` | MLS cryptographic identity used for encryption | `default` |

Each profile stores MLS session state and auth token independently under:
`~/.local/share/enigma/profiles/{APP_PROFILE}/`

---

## Production Build

Creates a distributable `.deb` / `.AppImage` (Linux) or `.app` / `.dmg` (macOS):

```bash
cd enigma/enigma
npm run tauri build
# Output: src-tauri/target/release/bundle/
```

---

## Browser vs Desktop — Feature Comparison

| Feature | Browser (`npm run dev`) | Desktop (`npm run tauri dev`) |
|---------|------------------------|-------------------------------|
| Chat (text) | ✅ plaintext | ✅ MLS encrypted |
| Images in chat | ✅ | ✅ |
| Voice messages | ✅ | ✅ |
| Notes / Storage / Tasks / Locations / People / Wallet | ✅ | ✅ |
| MLS end-to-end encryption | ❌ disabled | ✅ |
| Auth token storage | `localStorage` | Rust secure store |
| Server URL setting | `localStorage` | Rust secure store |
| Native file picker (Storage upload) | HTML `<input>` | HTML `<input>` |
| Multiple isolated profiles | ❌ | ✅ via `APP_PROFILE` |

---

## Tech Stack

- **Frontend:** Vue 3, TypeScript, Pinia, Vue Router, TailwindCSS v4, FontAwesome
- **Desktop runtime:** Tauri v2, Rust
- **Encryption:** `rotor-core` (Rust crate), MLS (Messaging Layer Security) protocol
- **Build:** Vite 6, Cargo

---

## Project Structure

```
enigma/
├── enigma/                   # Vite + Vue 3 frontend
│   ├── src/
│   │   ├── views/            # Page-level components
│   │   │   ├── EnigmaChatView.vue
│   │   │   ├── NotesView.vue
│   │   │   ├── VaultView.vue
│   │   │   ├── TasksView.vue
│   │   │   ├── LocationsView.vue
│   │   │   ├── SocialhubView.vue
│   │   │   ├── WalletView.vue
│   │   │   ├── EnigmaLoginView.vue
│   │   │   ├── EnigmaProfileView.vue
│   │   │   └── EnigmaConfigView.vue
│   │   ├── stores/           # Pinia stores (chat, user, notes, vault, tasks, locations, socialhub, wallet)
│   │   ├── services/
│   │   │   ├── api.ts        # HTTP API client — all typed interfaces + Bearer auth
│   │   │   ├── ws.ts         # WebSocket client with exponential-backoff reconnect
│   │   │   ├── crypto.ts     # MLS bridge to Rust (no-ops gracefully in browser)
│   │   │   └── appStorage.ts # Token + URL storage (Tauri → Rust; browser → localStorage)
│   │   ├── components/
│   │   │   └── ChatBubble.vue  # Renders text / image / audio messages
│   │   ├── router/index.ts
│   │   └── App.vue           # Header nav + RouterView
│   └── src-tauri/            # Rust / Tauri backend
│       └── src/
│           ├── main.rs       # Entry point — reads APP_PROFILE / CHAT_USER env vars
│           └── lib.rs        # AppConfig, profile state, MLS session registry
└── README.md
```

---

## Authentication

1. Go to `/login`, enter your toto credentials.
2. A Django session key is returned and stored as a Bearer token.
3. Every API request includes `Authorization: Bearer <token>`.
4. In browser mode the token is stored in `localStorage`; in desktop mode it is stored in the Rust secure store.

---

## Chat Media

| Media type | How to send | How it arrives |
|------------|-------------|----------------|
| **Image** | Click the image icon → pick a file | `POST /telegraph/api/channels/{slug}/upload/` → WebSocket relay → `<img>` |
| **Voice** | Click the mic icon → speak → click stop | `POST /telegraph/api/channels/{slug}/upload-audio/` → WebSocket relay → `<audio controls>` |

---

## Message Types (WebSocket)

| Type | Description |
|------|-------------|
| `chat_message` | Plaintext message |
| `mls_app` | MLS-encrypted application message (opaque relay) |
| `image_message` | Base64 image data |
| `voice_message` | Base64 audio/webm data |
| `mls_welcome` / `mls_commit` / `mls_key_package` | MLS group handshake |
| `room_participants` | Active participant list update (server → client) |
| `system_info` / `system_error` | Server notifications |
