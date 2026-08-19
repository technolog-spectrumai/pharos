# Enigma Release Process

This is the maintainer checklist for producing Enigma desktop and Android
release artifacts. For toolchain setup and lower-level build notes, see
[build.md](build.md). For end-user installation, see [install.md](install.md).

## Release Goals

A release artifact should be:

- built from a known commit;
- versioned consistently across `package.json`, `apps/enigma/package.json`,
  `apps/enigma/src-tauri/tauri.conf.json`, and
  `apps/enigma/src-tauri/build_config.yaml`;
- signed when Android release artifacts are produced;
- smoke-tested on the target platform;
- distributed with checksums and enough metadata to diagnose install failures.

## 1. Pick The Release Shape

Decide what is being shipped:

- Desktop only: `.deb` / `.rpm` from `./build_desktop.sh`.
- Android sideload/test distribution: a signed `.apk`.
- Android store distribution: a signed `.aab` uploaded to the store, plus an
  APK only when the store or test channel needs one.
- Both desktop and Android: use the Builder or `apps/enigma/deploy/build.sh`.

Choose the edition before building:

```bash
ENIGMA_EDITION=basic
ENIGMA_EDITION=standard
ENIGMA_EDITION=professional
```

Unset `ENIGMA_EDITION` builds the base `build_config.yaml`. The dev launchers
default to `professional`, but CI/release defaults do not, so make the edition
explicit for repeatable releases.

## 2. Prepare The Checkout

Start from the Enigma repo root:

```bash
cd /path/to/enigma
git status --short
npm install
```

Do not release from a dirty tree unless every change is intentional. The
checked-in `apps/enigma/deploy/dist/` directory can contain old artifacts, so do
not use "whatever is already in dist" as the release set.

Update version fields together:

- root `package.json`;
- `apps/enigma/package.json`;
- `apps/enigma/src-tauri/tauri.conf.json`;
- `apps/enigma/src-tauri/build_config.yaml`;
- edition configs under `apps/enigma/src-tauri/configs/` when those editions
  are being shipped.

Android's generated `tauri.properties` supplies:

```text
tauri.android.versionName=0.1.3
tauri.android.versionCode=1003
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
( cd cryptorotor/gervasius && cargo test )
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

```bash
./build_desktop.sh
```

Expected release output:

```text
apps/enigma/src-tauri/target/release/bundle/
  deb/*.deb
  rpm/*.rpm
```

If AppImage is enabled in `tauri.conf.json`, it will appear under the same
bundle tree.

## 5. Configure Android Release Signing

Android release builds must be signed. Enigma deliberately fails closed when a
release key is missing or when the Android SDK debug key is used for a release.

Preferred flow:

```bash
enigma-builder signing android status
enigma-builder signing android create
enigma-builder build android --release --abi aarch64,x86_64
enigma-builder signing android verify <apk-or-aab>
```

After the first real signed release has been inspected, pin its upload-key
fingerprint:

```bash
enigma-builder signing android pin --from <signed-release.apk>
git add apps/enigma/deploy/android-release-key.properties
```

That pinned fingerprint is public metadata. It exists so a swapped, regenerated,
or lost keystore becomes a build failure instead of an update that strands
existing installs.

Secrets must stay outside source control. Credentials may come from
`gen/android/keystore.properties`, environment variables, or
`~/.config/enigma-builder/signing.properties` with mode `0600`.

## 6. Build Android Artifacts

The raw script:

```bash
bash scripts/build_android.sh enigma release aarch64,x86_64
```

Expected output:

```text
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/release/app-release.apk
  bundle/release/app-release.aab
```

Important defaults:

- `npm run build:android` builds a debug APK, not a release.
- `scripts/build_android.sh enigma` defaults to `debug` and `aarch64`.
- Debug APKs are installable for testing but are not releasable.
- `--allow-unsigned-release` is only for inspecting packaging output. That APK
  should be treated as installable nowhere and must never be distributed.

## 7. Collect And Verify Artifacts

The Builder is the safest release collection path because it records
`build-info.json` and `SHA256SUMS`, and can filter out stale artifacts from
previous builds.

For a script-only release:

```bash
bash apps/enigma/deploy/build.sh both release aarch64,x86_64
( cd apps/enigma/deploy/dist && sha256sum -- * > SHA256SUMS )
```

Before sharing Android files, verify package, version, signer, and fingerprint:

```bash
enigma-builder signing android verify apps/enigma/deploy/dist/enigma-universal-release.apk
```

For manual SDK inspection:

```bash
apksigner verify --verbose --print-certs <release.apk>
aapt2 dump badging <release.apk> | head
```

## 8. Smoke-Test The Install

Use a clean test device or emulator:

```bash
adb install -r apps/enigma/src-tauri/gen/android/app/build/outputs/apk/release/app-release.apk
adb shell pm list packages | grep enigma
adb shell am start -n com.spectrumaipl.enigma/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

If the device already has a debug build, an unsigned build, or a build signed
with another key, Android may refuse the update. Uninstalling can fix the test
device, but it removes the local Enigma vault and room state.

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
git tag -a v0.1.3 -m "Enigma 0.1.3"
git push origin v0.1.3
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

### Android Edition Package IDs

Desktop edition overlays change the Tauri identifier. The current generated
Android Gradle file still declares:

```text
applicationId = "com.spectrumaipl.enigma"
```

and `scripts/build_android.sh` does not pass the edition `--config` overlay.
Until that path is reviewed and smoke-tested, do not assume Basic, Standard, and
Professional APKs can coexist on the same Android device. Treat the Android
package id printed by `enigma-builder signing android verify` as the authority.

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

`apps/enigma/deploy/dist/` can contain artifacts from earlier names, versions,
and signing states. A filename like `enigma-universal-release.apk` is not enough
proof that the file came from the current commit.

What to do:

- prefer the Builder collection flow with `build-info.json`;
- create fresh `SHA256SUMS` after collection;
- verify the exact APK/AAB that will be shared.

### Regenerated Android Project

`tauri android init` can regenerate files under
`apps/enigma/src-tauri/gen/android/`. Enigma has custom signing gates in the
generated Gradle project, mirrored by `tools/enigma_builder/signing.py`.

What to do:

- run `enigma-builder signing android status` after regenerating Android files;
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
