# Enigma Tauri App

Enigma is a Tauri v2, Vue 3, Pinia, and Rust desktop client for the Enigma chat API.

## Profile-Specific Local State

The app reads two environment variables at startup:

- `APP_PROFILE`: local storage namespace for this app instance.
- `CHAT_USER`: default chat identity for MLS operations.

Persistent app state is stored by Rust/Tauri under the current profile:

```text
app_data_dir/profiles/{APP_PROFILE}/profile_state.json
```

That file contains the configured server URL, auth token, selected offline data profile, and offline profile data entries. MLS state is stored in the same profile directory with `mls_*.bin` files.

## Run Multiple Local Instances

Start the first instance:

```bash
APP_PROFILE=alice CHAT_USER=alice cargo tauri dev
```

Start a second instance from another terminal:

```bash
APP_PROFILE=bob CHAT_USER=bob cargo tauri dev --no-dev-server
```

Alice and Bob will use separate local files:

```text
profiles/alice/profile_state.json
profiles/bob/profile_state.json
```

This means Alice and Bob can have different server URLs, auth tokens, offline data profiles, and MLS state.

## Test Offline Data Separation

1. Run Alice with `APP_PROFILE=alice CHAT_USER=alice`.
2. Open Settings.
3. In Offline Data, set Data profile name to `Alice local data` and save it.
4. Open Profile, fill the offline profile form, and save it.
5. Run Bob with `APP_PROFILE=bob CHAT_USER=bob`.
6. Open Settings.
7. Set Data profile name to `Bob local data` and save it.
8. Open Profile, fill different offline data, and save it.
9. Switch between the two running app instances.

Expected result: Alice's offline data and Bob's offline data stay separate because each instance writes to its own `APP_PROFILE` directory.

## Test Server Connection

Settings uses:

```text
GET /enigma/api/health/
```

This endpoint is public, so connection testing works even before login.
