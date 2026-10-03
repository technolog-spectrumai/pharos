# CryptoRotor

> The single source of truth for the crypto layer. It lives in the **Rutile**
> repository at `crates/rotor`, as its own cargo workspace; Enigma and Morion
> mount Rutile as a git submodule and consume these crates by **path**, so
> nothing is fetched at build time.
> The toto project vendors a static copy of the `rotor_wasm` build produced by
> [build_wasm.sh](build_wasm.sh).

CryptoRotor is the canonical home of **Rotor** — a small, reusable [MLS](https://www.rfc-editor.org/rfc/rfc9420)
(Messaging Layer Security) engine built on [OpenMLS](https://github.com/openmls/openmls).
It provides group creation, member add/remove, welcome-based joins, application-message
encryption/decryption, exporter secrets, and serializable session state — behind one
Rust API with WASM and Python bindings.

Rotor owns MLS cryptography and OpenMLS integration only. Application concerns
(chat orchestration, transports, UI, voice, P2P) live in the consumers.

## Layout

| Crate | Path | What it builds |
|---|---|---|
| `rotor-core` | [rotor_core/](rotor_core/) | The pure-Rust MLS engine (`RotorSession`). Ciphersuite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. |
| `rotor-wasm` | [rotor_wasm/](rotor_wasm/) | wasm-bindgen bindings (`WasmRotorSession`), built with wasm-pack (`web` and `bundler` targets). |
| `rotor-py` | [rotor_py/](rotor_py/) | PyO3 bindings (`rotor_py.RotorEngine`), built with maturin. |

`compile.py` orchestrates all builds and tests; `build_wasm.sh` is the one-click
WASM-only build (the `rotor:wasm` CI job runs the same script).

## Build & test

```bash
# Everything: cargo check, maturin develop, smoke E2E, pytest, wasm (web target)
python3 compile.py

# Also build the bundler-target WASM package (rotor_wasm/build/)
python3 compile.py --tauri

# WASM only — web (rotor_wasm/build_web/) + bundler (rotor_wasm/build/)
./build_wasm.sh              # or: ./build_wasm.sh web|bundler

# Individual pieces
cargo test -p rotor-core --locked          # Rust unit tests
cd rotor_py && maturin develop && pytest -q test   # Python bindings + tests
```

Prerequisites: Rust (with the `wasm32-unknown-unknown` target), `wasm-pack`,
and for the Python bindings a virtualenv with `maturin` and `pytest`.

## Consuming Rotor

Now that Rotor is vendored, consumers use it **by path**, not over git:

- **enigma desktop / Android** (`apps/enigma/src-tauri`) depends on `rotor-core` by
  relative path — no GitLab access required to build:
  ```toml
  # apps/enigma/src-tauri/Cargo.toml
  rotor-core = { path = "../../../cryptorotor/rotor_core" }
  ```

- **WASM consumers** use `rotor_wasm`. Build it at the enigma commit you want,
  then consume the output as static files:
  ```bash
  ./build_wasm.sh    # build_web/ (web: <script>/dynamic import) + build/ (bundler)
  ```
  **toto's Django telegraph chat** does exactly this: its `deploy.py` copies the
  `build_web/` package from a `rotor_wasm_dir` config-yaml prop (pointing at this
  checkout) into its tracked telegraph static dir — no GitLab involved. The
  `rotor:wasm` CI job runs the same script as a build gate and attaches the output
  to pipelines/tags for provenance only.

- **Python consumers** use `rotor-py` via maturin (`cd rotor_py && maturin develop`).

## Versioning

Vendored from CryptoRotor **tag `v0.1.0`**. To update, re-vendor from the upstream
CryptoRotor history and bump this note. `Cargo.lock` in this directory is committed
for reproducible builds of the three crates.

## Consumers

Both consumers depend on the crates by relative path, expecting this repo as a
sibling checkout of the app repo:

| repo | crates | how |
|---|---|---|
| **enigma** | `rotor-core`, `gervasius` | `apps/enigma/src-tauri/Cargo.toml`, `protasius/Cargo.toml` |
| **zinnia** | `gervasius` (via Padova) | not yet pinned here — still carried in its `packages/rakotis` subtree |

The layout the paths assume:

```
dev/
├── rotor/crypto_rotor/   ← this repo
├── enigma/enigma/
└── zinnia/
```

`gervasius` currently exists in two forked copies — this one has `seal.rs`
(X25519 sealing), zinnia's has `gervazy.rs` (the legacy-format sniffer its
sealed-file detection needs). Neither is a superset; merging them is the
prerequisite for zinnia pinning this repo.
