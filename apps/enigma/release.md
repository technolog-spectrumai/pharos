# Enigma26 Release Process

This is the maintainer checklist for producing Enigma26 desktop and Android
release artifacts. For toolchain setup and lower-level build notes, see
[build.md](build.md). For end-user installation, see [install.md](install.md).

## Release Goals

A release artifact should be:

- built from a known commit;
- versioned consistently across every file that carries the version (§2);
- signed when Android release artifacts are produced;
- smoke-tested on the target platform;
- distributed with checksums and enough metadata to diagnose install failures.

## 1. Pick The Release Shape

Decide what is being shipped:

- Desktop only: `.deb` / `.rpm` — `desktop:` enabled in `build.yaml`.
- Android sideload/test distribution: a signed `.apk`.
- Android store distribution: a signed `.aab` uploaded to the store, plus an
  APK only when the store or test channel needs one.
- Both desktop and Android: enable both sections; one `./build.sh`
  builds them in turn. See [build.md](build.md#building-buildyaml).

Every one of those choices is a line in [build.yaml](build.yaml) at the repo
root — the only place a build is configured. Choose the edition there before
building:

```yaml
apps:
  enigma:
    edition: professional     # basic | standard | professional
```

Omitting `edition` builds the base `build_config.yaml`, so keep it explicit for
repeatable releases. The edition is not in the artifact's name: record which
`build.yaml` (commit) a release was built from.

## 2. Prepare The Checkout

Start from the Enigma26 repo root:

```bash
cd /path/to/enigma
git status --short
npm ci
```

Do not release from a dirty tree unless every change is intentional. The
`dist/enigma/` output folder can contain old artifacts, so do not use "whatever
is already in dist" as the release set.

The version is a property of the code, not a build-time choice: it is bumped
with the change that earns it — `build.yaml` has no key for it. It is
currently **0.1.6**, and it must be the same number in all of:

- root `package.json`, `apps/enigma/package.json`,
  `packages/rakotis/package.json`;
- `apps/enigma/src-tauri/tauri.conf.json` (authoritative for the native bundle)
  and `apps/enigma/src-tauri/Cargo.toml`;
- `apps/enigma/src-tauri/build_config.yaml` and **every**
  `apps/enigma/src-tauri/configs/*.yaml` — not only the editions being shipped.
  `build.rs` asserts that the config it bakes equals `tauri.conf.json`, so a
  config left behind fails the build for that edition rather than shipping the
  wrong version.

Android's generated
`apps/enigma/src-tauri/gen/android/app/tauri.properties` is regenerated from
`tauri.conf.json` and tracks that version — 0.1.3 produced `1003`, so 0.1.6
produces:

```text
tauri.android.versionName=0.1.6
tauri.android.versionCode=1006
```

`versionCode` must increase for every Android update with the same
`applicationId`, or Android refuses the install as a downgrade.

## 3. Run Pre-Release Checks

Run the normal test gates before packaging:

```bash
npm test
npm run build -w rakotis
npm run build -w enigma
( cd apps/enigma/src-tauri && cargo test )
( cd rutile/crates/rotor/gervasius && cargo test )
( cd protasius && cargo test )
python apps/enigma/e2e.py
```

For Android, also smoke-test on at least one real phone or emulator:

```bash
adb devices
npm run tauri android dev
adb logcat -s RustStdoutStderr enigma
```

## 4. Build Desktop Artifacts

With `desktop: { enabled: true, profile: release, bundles: [deb, rpm] }` under
`apps.enigma` in `build.yaml`:

```bash
./build.sh
```

Expected release output (copied to `dist/enigma/` as well):

```text
apps/enigma/src-tauri/target/release/bundle/
  deb/*.deb
  rpm/*.rpm
```

Which formats appear is `desktop.bundles` in `build.yaml` (`bundle.targets` in
`tauri.conf.json` when that key is omitted) — check the "Built" list the
command prints before a release.

An `.rpm` built on Ubuntu links against Ubuntu's glibc and webkit2gtk: it is a
package format, not a cross build, and will very likely refuse to start on
Fedora. Build each distribution's package on that distribution.

## 5. Configure Android Release Signing

Android release builds must be signed. Enigma26 deliberately fails closed when a
release key is missing or when the Android SDK debug key is used for a release.

Preferred flow:

```bash
SIGN="python3 rutile/scripts/android_signing/signing_cli.py"
$SIGN status --gen apps/enigma/src-tauri/gen/android
$SIGN create
./build.sh      # android: { enabled: true, profile: release, abis: [aarch64, x86_64] }
$SIGN verify <apk-or-aab>
```

After the first real signed release has been inspected, pin its upload-key
fingerprint:

```bash
$SIGN pin --pin-file apps/enigma/deploy/android-release-key.properties --from <signed-release.apk>
git add apps/enigma/deploy/android-release-key.properties
```

That pinned fingerprint is public metadata. It exists so a swapped, regenerated,
or lost keystore becomes a build failure instead of an update that strands
existing installs.

Secrets must stay outside source control. Each of the four values
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) is resolved on its
own, highest first:

1. a `${VAR}` placeholder in `gen/android/keystore.properties`, read from the
   environment;
2. the well-known environment variables `ENIGMA_KEYSTORE_FILE`,
   `ENIGMA_KEYSTORE_PASSWORD`, `ENIGMA_KEY_ALIAS`, `ENIGMA_KEY_PASSWORD`;
3. a literal in `keystore.properties`;
4. `~/.config/enigma-builder/signing.properties`, which is refused unless it is
   mode `0600`.

With the environment or that local file supplying everything,
`keystore.properties` can be absent entirely; the committed
`keystore.properties.example` is the only half that belongs in the repo. No
password is ever passed on an argv. Command reference: `signing_cli.py --help`
([rutile/scripts/android_signing/](rutile/scripts/android_signing)).

## 6. Build Android Artifacts

Set this under `apps.enigma` in `build.yaml` and run `./build.sh`:

```yaml
android:
  enabled: true
  profile: release
  abis: [aarch64, x86_64]
```

It runs `rutile/scripts/build_android.sh enigma release aarch64,x86_64`.

Expected output — every selected ABI is packed into one `universal` artifact,
so these paths do not change with the ABI list:

```text
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/universal/release/app-universal-release.apk
  bundle/universalRelease/app-universal-release.aab
```

Important defaults:

- `android.profile` defaults to `debug` and `android.abis` to `[aarch64]`.
- Debug APKs are installable for testing but are not releasable.
- `allow_unsigned_release: true` is only for inspecting packaging output. That APK
  should be treated as installable nowhere and must never be distributed.

## 7. Collect And Verify Artifacts

`./build.sh` clears the previous desktop bundle directory before it builds,
fails if the build leaves no package, and — with `output_dir: dist` in
`build.yaml` — copies what it built into `dist/enigma/`, Android artifacts
renamed from Tauri's generic `app-…` to `enigma-…`. It prints the list under
"Built".

It also writes `dist/enigma/SHA256SUMS`, over **everything** in that directory —
including older installers left there by earlier builds. Treat that file as an
index of the directory, not as a manifest of this release, and publish checksums
for the exact files you ship:

```bash
( cd dist/enigma && sha256sum -- Enigma26_<ver>_amd64.deb enigma-universal-release.apk )
```

Before sharing Android files, verify package, version, signer, and fingerprint:

```bash
python3 rutile/scripts/android_signing/signing_cli.py verify dist/enigma/enigma-universal-release.apk
```

For manual SDK inspection:

```bash
apksigner verify --verbose --print-certs <release.apk>
aapt2 dump badging <release.apk> | head
```

## 8. Smoke-Test The Install

Use a clean test device or emulator:

```bash
adb install -r apps/enigma/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
adb shell pm list packages | grep enigma
adb shell am start -n com.spectrumaipl.enigma26/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

If the device already has a debug build, an unsigned build, or a build signed
with another key, Android may refuse the update. Uninstalling can fix the test
device, but it removes the local Enigma26 vault and room state.

## 9. Publish

For direct distribution:

- ship only the signed release APK;
- include `SHA256SUMS`;
- include the release signing fingerprint from verification output;
- point users to [install.md](install.md).

For Google Play or another store:

- upload the signed `.aab` when the store expects bundles;
- keep the upload keystore and password backed up long-term;
- remember that store-generated device APKs may be signed by the store's app
  signing key, while Enigma's local pin records the upload key used by this
  build.

Tag the commit after artifacts are verified:

```bash
git tag -a v0.1.6 -m "Enigma26 0.1.6"
git push origin v0.1.6
```

## Known Release Friction Points

### Android Signing Identity

Android updates are keyed by `(applicationId, signing certificate)`. Losing the
release keystore, changing it without an accepted rotation path, or accidentally
using the debug key means existing users cannot update in place.

What to do:

- create and back up the release keystore before the first release;
- pin the first release fingerprint in
  `apps/enigma/deploy/android-release-key.properties`;
- verify every release artifact before upload or sharing;
- never distribute debug-signed or unsigned releases.

### Android Package ID Is Fixed

The generated Android Gradle file declares:

```text
applicationId = "com.spectrumaipl.enigma26"
```

Basic, Standard, and Professional APKs do not install side by side; they update
or replace the same Android package. Treat the package id printed by
`signing_cli.py verify` as the authority.

### AAB Is Not A Direct Installer

An `.aab` is for publishing. A phone installs APKs. For sideloading, distribute
the signed release APK; for app stores, upload the AAB and let the store generate
device-specific APKs.

### ABI Coverage

The default Android build is `aarch64`, which covers modern ARM64 phones but not
the common `x86_64` emulator and not older 32-bit phones.

What to do:

- use `aarch64,x86_64` for phone plus emulator testing;
- use `all` only when the full target set is installed and the artifact size is
  acceptable;
- diagnose `INSTALL_FAILED_NO_MATCHING_ABIS` by rebuilding for the device ABI.

### Stale Artifact Collection

`dist/enigma/` can contain artifacts from earlier names, versions,
and signing states. A filename like `enigma-universal-release.apk` is not enough
proof that the file came from the current commit.

What to do:

- start from an empty `dist/enigma/`, or checksum only the files you ship;
- verify the exact APK/AAB that will be shared.

### Regenerated Android Project

`tauri android init` can regenerate files under
`apps/enigma/src-tauri/gen/android/`. Enigma26 has custom signing gates in the
generated Gradle project, mirrored by `rutile/scripts/android_signing/signing.py`.

What to do:

- run `python3 rutile/scripts/android_signing/signing_cli.py status --gen apps/enigma/src-tauri/gen/android`
  after regenerating Android files;
- verify that release signing still fails closed when credentials are missing;
- keep signing logic in Gradle and `signing.py` in lockstep.

## Official Android References

- Android app signing:
  <https://developer.android.com/studio/publish/app-signing>
- Prepare an Android app for release:
  <https://developer.android.com/studio/publish/preparing>
- APK vs Android App Bundle:
  <https://developer.android.com/guide/app-bundle/faq>
- Alternative distribution and unknown-app opt-in:
  <https://developer.android.com/distribute/marketing-tools/alternative-distribution>
- PackageInstaller failure categories:
  <https://developer.android.com/reference/android/content/pm/PackageInstaller>
