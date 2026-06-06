# Enigma

A cross-platform productivity + chat suite with end-to-end encryption. Built with Tauri (Rust) + Vue 3. Connects to the toto Django backend.

## Screens

| Screen | Route | Backed by |
|--------|-------|-----------|
| Dashboard | `/` | Aggregated counts from all modules |
| Chat | `/chat` | `toto.telegraph` WebSocket + MLS encryption |
| Notes | `/notes` | `toto.bento` JSON API |
| Storage | `/vault` | `toto.vault` JSON API |
| Tasks | `/tasks` | `toto.kanban` JSON API |
| Locations | `/locations` | `toto.locations` JSON API + OpenStreetMap |
| People | `/people` | `toto.socialhub` JSON API |
| Events | `/events` | `toto.events` JSON API |

---

## Running — Browser Mode (quickest, no Rust needed)

In browser mode the app runs inside a normal browser tab. MLS encryption is disabled (chat falls back to plaintext). Auth token and server URL are stored in `localStorage`.

```bash
cd enigma/enigma
npm install        # once
npm run dev        # starts Vite dev server
```

Then open **http://localhost:1420** in your browser.

All screens are fully functional in browser mode. The only missing feature is MLS end-to-end encryption, which requires the Tauri desktop runtime.

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

### Run two instances side-by-side (local multi-user testing)

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
| All other modules | ✅ | ✅ |
| MLS end-to-end encryption | ❌ disabled | ✅ |
| Auth token storage | `localStorage` | Rust secure store |
| Multiple isolated profiles | ❌ | ✅ via `APP_PROFILE` |

---

## Features by Module

### Dashboard (`/`)

The welcome screen fetches live counts from all modules in parallel and displays a module grid — rooms, notes, files, projects, addresses, zones, profiles, communities. Each card links directly to its section.

### Chat (`/chat`)

- MLS-encrypted group messaging (Messaging Layer Security protocol)
- WebSocket with exponential-backoff reconnect
- Supports text, image upload, and voice messages (MediaRecorder API)
- Participant list syncing and MLS group key exchange handshake

### Locations (`/locations`)

Four tabs:

| Tab | Description |
|-----|-------------|
| **Map** | Interactive Leaflet map (OpenStreetMap tiles in light mode, CARTO dark in dark mode). Shows territories, zones, route chains, routes, and addresses as GeoJSON features. Left side panel (collapsible on mobile) contains: search, type filters, visibility toggles, and a data-layer overlay with heatmap colouring and value labels. |
| **Zones** | Card grid of all zones with territory membership. |
| **Addresses** | Card grid of saved addresses with coordinates. Form to add new addresses. |
| **Route Search** | Pick two saved addresses (or enter WGS84 coordinates manually), choose a transport mode (Car / Bicycle / Foot), and search a real OSRM route. The route geometry is drawn on a Leaflet map with distance and duration shown. |

**Backend API endpoints added for Enigma:**

| Endpoint | Description |
|----------|-------------|
| `GET /locations/api/map/` | All locations with full GeoJSON geometry |
| `GET /locations/api/layers/` | Active map data layers with heatmap polygons |
| `POST /locations/api/route-search/` | OSRM route proxy (car / bicycle / foot) |

### Notes (`/notes`)

Linked notes (Bento app) with graph visualization. Each note is a free-text `label` plus a flexible `properties` bag (body, source, quote, and any custom keys); notes are connected with labelled links and can reference external toto objects. Full graph view using Cytoscape (note, category, and reference nodes).

### Storage (`/vault`)

Encrypted file storage backed by `toto.vault`. Two views mirror the toto storage app (minus its editors/executors):

- **Tree** — the full bucket → nested folder → file hierarchy, expandable.
- **Grid** — folder-navigable cards with a breadcrumb (click a folder to descend).

Upload, rename, encrypt/decrypt with password, download, and delete. Text-ish files (`text/json/yaml/xml/csv/latex/bib/python/svg/html`) open in a built-in **Ace editor** for in-place editing and saving — the editor is bundled (not loaded from a CDN), so it works offline in the desktop build.

Backend API added for Enigma: `GET /vault/api/buckets/` (folder tree), `GET|PUT /vault/api/files/<key>/content/` (editor read/write); each file in `GET /vault/api/files/` now carries `directory_id` + `is_editable`.

### Language

Enigma is localized (English + Polish). The interface language is chosen, in order: an explicit choice made in **Settings**, otherwise the user's **toto profile language** (`Person.preferred_language`, surfaced on `/telegraph/api/me/`), otherwise the browser language. Changing the language in Settings also writes it back to the toto profile.

### Tasks (`/tasks`)

Kanban boards backed by `toto.kanban`. View projects, sprints, backlogs, missions, and the Eisenhower priority matrix.

### People (`/people`)

Profiles and communities from `toto.socialhub`. Org chart visualization using Cytoscape for community hierarchies.

### Events (`/events`)

Scheduled events from `toto.events`: browse upcoming/past events, create events, send invitations to people, and respond to invites you've received.

---

## Tech Stack

- **Frontend:** Vue 3, TypeScript, Pinia, Vue Router, TailwindCSS v4, FontAwesome
- **i18n:** vue-i18n (English + Polish)
- **Editor:** ace-builds (bundled, offline)
- **Map:** Leaflet 1.9, OpenStreetMap tiles, CARTO dark tiles
- **Charts:** Cytoscape (org charts, note graphs)
- **Desktop runtime:** Tauri v2, Rust
- **Encryption:** `rotor-core` (Rust crate), MLS (Messaging Layer Security) protocol
- **Build:** Vite 6, Cargo
- **Tests:** Vitest + Vue Test Utils (unit/component/integration), Playwright (e2e)

## Testing

```bash
cd enigma/enigma
npm test            # vitest: unit + component + integration (jsdom)
npm run test:coverage
npm run test:e2e    # playwright: builds, serves, runs browser smoke tests
```

`tests/unit` covers pure logic (vault folder-tree builder, i18n resolution, API client), `tests/component` mounts components/views (FontAwesome stubbed, Ace aliased to a stub), `tests/integration` exercises the Pinia stores against a mocked API, and `tests/e2e` drives the built bundle in Chromium with the backend stubbed via route fulfilment. Backend endpoints are covered in `toto/toto/vault/tests_api.py` and `toto/toto/telegraph/tests/test_api_views.py`.

---

## Project Structure

```
enigma/
├── enigma/                   # Vite + Vue 3 frontend
│   ├── src/
│   │   ├── views/
│   │   │   ├── EnigmaWelcomeView.vue   # Dashboard (live module counts)
│   │   │   ├── EnigmaChatView.vue      # MLS chat + media
│   │   │   ├── NotesView.vue           # Bento notes + graph
│   │   │   ├── VaultView.vue           # Encrypted storage
│   │   │   ├── TasksView.vue           # Kanban + missions
│   │   │   ├── LocationsView.vue       # Map (Leaflet/OSM) + route search
│   │   │   ├── SocialhubView.vue       # People + org charts
│   │   │   ├── EventsView.vue          # Scheduled events + invites
│   │   │   ├── EnigmaLoginView.vue
│   │   │   ├── EnigmaProfileView.vue
│   │   │   └── EnigmaConfigView.vue
│   │   ├── stores/           # Pinia stores per module
│   │   ├── services/
│   │   │   ├── api.ts        # HTTP client — all typed interfaces + Bearer auth
│   │   │   ├── ws.ts         # WebSocket with exponential-backoff reconnect
│   │   │   ├── crypto.ts     # MLS bridge to Rust (no-ops in browser)
│   │   │   └── appStorage.ts # Token + URL storage (Tauri: Rust; browser: localStorage)
│   │   ├── components/
│   │   │   ├── OyaCard.vue
│   │   │   ├── OyaButton.vue
│   │   │   └── ChatBubble.vue
│   │   ├── router/index.ts
│   │   └── App.vue
│   └── src-tauri/            # Rust / Tauri backend
│       └── src/
│           ├── main.rs       # Entry — reads APP_PROFILE / CHAT_USER env vars
│           └── lib.rs        # AppConfig, profile state, MLS session registry
└── README.md
```

---

## Authentication

1. Go to `/login`, enter your toto credentials.
2. A Django session token is returned and stored as a Bearer token.
3. Every API request includes `Authorization: Bearer <token>`.
4. In browser mode the token is in `localStorage`; in desktop mode it is in the Rust secure store.

---

## Chat Media

| Type | Send | Receive |
|------|------|---------|
| **Image** | Image icon → pick file | WebSocket relay → `<img>` |
| **Voice** | Mic icon → record → stop | WebSocket relay → `<audio>` |

## WebSocket Message Types

| Type | Description |
|------|-------------|
| `chat_message` | Plaintext message |
| `mls_app` | MLS-encrypted application message |
| `image_message` | Base64 image |
| `voice_message` | Base64 audio/webm |
| `mls_welcome` / `mls_commit` / `mls_key_package` | MLS group handshake |
| `room_participants` | Active participant list update |
| `system_info` / `system_error` | Server notifications |

---

## Responsive Layout

All screens work at any window width. The Locations map view adapts:

- **Desktop:** Static location index sidebar on the left, map fills remaining space.
- **Mobile / narrow window:** Map fills the full view. A floating **Locations** button (bottom-left) slides in the location index as a side panel. The panel has a close button and a semi-transparent backdrop.

The Route Search tab stacks the form above the map on narrow windows, with the form header tappable to collapse/expand it.
