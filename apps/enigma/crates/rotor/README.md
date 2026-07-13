# CryptoRotor

> **Vendored inside the [enigma](../README.md) repo.** This directory is a self-contained
> nested cargo workspace and the single source of truth for the crypto layer. enigma
> consumes `rotor-core` by **path** (no GitLab access needed to build). Publishing
> `rotor_wasm` as an artifact for the toto project is the top item in [todo.md](../todo.md).

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

`compile.py` orchestrates all builds and tests.

## Build & test

```bash
# Everything: cargo check, maturin develop, smoke E2E, pytest, wasm (web target)
python3 compile.py

# Also build the bundler-target WASM package (rotor_wasm/build/)
python3 compile.py --tauri

# Individual pieces
cargo test -p rotor-core --locked          # Rust unit tests
cd rotor_py && maturin develop && pytest -q test   # Python bindings + tests
cd rotor_wasm && wasm-pack build --target web --out-dir build_web
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

- **WASM consumers** (toto's Django telegraph chat + the toto/edge apps) use
  `rotor_wasm`. Build it at the enigma commit you want, then consume the output:
  ```bash
  cd rotor_wasm
  wasm-pack build --target web     --out-dir build_web   # browser: <script> / dynamic import()
  wasm-pack build --target bundler --out-dir build       # Vite / webpack bundlers
  ```
  Delivering these as a published **enigma CI artifact** (so toto stops building its
  own `toto/rotors/` copy) is the **top item** in [todo.md](../todo.md).

- **Python consumers** use `rotor-py` via maturin (`cd rotor_py && maturin develop`).

## Versioning

Vendored from CryptoRotor **tag `v0.1.0`**. To update, re-vendor from the upstream
CryptoRotor history and bump this note. `Cargo.lock` in this directory is committed
for reproducible builds of the three crates.
