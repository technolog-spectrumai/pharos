# Enigma26 Installation

This guide is for installing Enigma26 artifacts that were produced by the release
process in [release.md](release.md). For building from source, see
[build.md](build.md).

## Choose The Right File

Use the artifact for your platform:

- Ubuntu / Debian: `.deb`
- Fedora / RHEL: `.rpm`
- Linux portable build, when produced: `.AppImage`
- Android direct install: signed `.apk`
- Android store upload: `.aab`

Do not try to install an `.aab` directly on Android. It is a publishing format;
phones install APKs.

Before installing a downloaded release, compare its checksum with `SHA256SUMS`:

```bash
sha256sum -c SHA256SUMS
```

## Linux

Install a Debian package:

```bash
sudo apt install ./Enigma26_0.1.6_amd64.deb
```

Install an RPM package:

```bash
sudo dnf install ./Enigma26-0.1.6-1.x86_64.rpm
```

Run an AppImage, when one is shipped:

```bash
chmod +x ./Enigma26_0.1.6_amd64.AppImage
./Enigma26_0.1.6_amd64.AppImage
```

If a desktop package refuses to start after installation, run the app from a
terminal and keep the output. Missing WebKitGTK or a package built on the wrong
Linux distribution is usually the first thing to check.

## Android: Install From The Device

Use the signed release APK, for example:

```text
enigma-universal-release.apk
```

Steps:

1. Download or copy the APK to the Android device.
2. Open it from Files, Downloads, a browser, or the app that received it.
3. If Android asks, allow that source to install unknown apps.
4. Tap Install.
5. Open Enigma26 and grant camera or microphone permission only when using QR
   scanning or calls.

On Android 8.0 and newer, the unknown-app permission is per source. Allowing a
browser does not automatically allow a file manager or chat app to install APKs.

On managed work phones, school phones, or enterprise profiles, the administrator
may block unknown-app installs entirely. In that case, use the approved app
store, MDM channel, or `adb` if the device policy permits it.

## Android: Install With adb

Enable Developer options and USB debugging on the phone, then connect it:

```bash
adb devices
adb install -r ./enigma-universal-release.apk
```

Useful inspection commands:

```bash
adb shell pm list packages | grep enigma
adb shell am start -n com.spectrumaipl.enigma26/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

Uninstalling removes Enigma26's local vault, room state, and device-local data:

```bash
adb uninstall com.spectrumaipl.enigma26
```

Only uninstall as a last resort on a real user's device. Enigma26 is serverless, so
there is no central account that can restore local encrypted state.

## Why An APK May Fail To Install

### The APK Is Unsigned

Android requires installable APKs to be signed. Enigma26's release build fails
closed: with no release keystore configured the build is refused before any
work starts, and the Android SDK debug key is refused for a release outright. The only way to obtain an
unsigned release artifact is to ask for it with `--allow-unsigned-release`, and
that artifact is for packaging inspection — it installs nowhere and must not be
shared.

What to do:

```bash
python3 scripts/android_signing/signing_cli.py verify <apk>
bash scripts/build_android.sh enigma release aarch64,x86_64
```

Share only a signed release APK.

### The Existing App Was Signed With Another Key

Common adb symptom:

```text
INSTALL_FAILED_UPDATE_INCOMPATIBLE
```

Android treats an update as valid only when the installed app and the new APK
have the same package id and compatible signing certificate. A debug APK cannot
update a release APK, and a release APK signed by a new keystore cannot update an
older release signed by the original keystore.

What to do:

- install an APK signed with the same release key as the existing app;
- use a separate intentionally configured package id only for throwaway test
  builds outside the fixed release path;
- uninstall only if losing local data is acceptable.

### The APK Version Is Older Than The Installed Version

Common adb symptom:

```text
INSTALL_FAILED_VERSION_DOWNGRADE
```

Android compares `versionCode`, not only the visible version name. If the device
already has a higher `versionCode`, a normal install is blocked.

What to do:

- build a new release with a higher Android `versionCode`;
- for a disposable test device, uninstall the existing app and install again.

### The APK Does Not Match The Device ABI

Common adb symptom:

```text
INSTALL_FAILED_NO_MATCHING_ABIS
```

The default Enigma26 Android build targets `aarch64`, which is right for most
modern phones but wrong for an `x86_64` emulator and wrong for old 32-bit
devices.

What to do:

```bash
bash scripts/build_android.sh enigma release aarch64,x86_64
# or, when all targets are installed:
bash scripts/build_android.sh enigma release all
```

For an emulator, include `x86_64`.

### The Device Is Too Old

Enigma26's generated Android project currently declares:

```text
minSdk = 24
targetSdk = 36
```

Android devices below API 24 cannot install the app. API 24 is Android 7.0.

What to do:

- use Android 7.0 or newer;
- do not try to bypass this with signing or installer settings.

### Android Blocks Unknown Apps

Symptoms include a generic "App not installed", a security warning, or a prompt
that sends you to settings.

What to do:

- allow "Install unknown apps" for the source app that opens the APK;
- verify checksums and the release signing fingerprint before proceeding;
- on managed devices, ask the administrator to approve the app or distribute it
  through the managed store;
- use `adb install` for internal testing when USB debugging is allowed.

### The File Is An AAB, Not An APK

An `.aab` will not install when opened on a phone.

What to do:

- use the `.apk` for direct install;
- upload the `.aab` to Google Play or another store that accepts app bundles;
- use bundletool only when you intentionally need generated APKs from an AAB.

### The Download Is Corrupt Or Incomplete

Common symptoms are package parse errors, a zero-byte file, or an installer that
fails before showing the app name.

What to do:

```bash
sha256sum -c SHA256SUMS
```

Download the APK again if the checksum does not match. Also confirm the device
has enough free internal storage.

### Play Protect Or Developer Verification Warns

Sideloaded APKs can show extra warnings, especially for apps outside an app
store or from an unverified developer.

What to do:

- prefer the official release channel when available;
- verify the checksum and signing fingerprint;
- avoid forwarding APKs without the matching release notes and checksums.

### The App Installs But Does Not Work Correctly

Installation success only proves the package was accepted by Android. If Enigma26
opens blank, crashes, cannot scan QR codes, or cannot join calls:

- update or enable Android System WebView / Chrome;
- grant camera permission for QR scanning;
- grant microphone permission for voice calls;
- capture logs with `adb logcat -s RustStdoutStderr enigma`;
- test with a clean profile on a disposable device before touching a real user's
  install.

## Repo-Specific Android Checks

Confirm what is actually inside an APK before distributing it:

```bash
python3 scripts/android_signing/signing_cli.py verify <apk>
```

The report should show:

- package id, fixed to `com.spectrumaipl.enigma26` in the generated Gradle file;
- visible version and Android `versionCode`;
- signer classification: signed release, debug, or unsigned;
- SHA-256 signing certificate fingerprint.

Once a release fingerprint has been pinned in
`apps/enigma/deploy/android-release-key.properties`, a build signed with any
other keystore fails instead of shipping — so a mismatch between that file and
the fingerprint printed above means the artifact did not come from the release
path. The full command set: `signing_cli.py --help`
([scripts/android_signing/](scripts/android_signing)).

Edition names and output filenames are not separate Android identities. Android
uses the APK's `applicationId` plus the signing key, and Enigma26 fixes the
release `applicationId` to `com.spectrumaipl.enigma26`.

## Official Android References

- Android app signing:
  <https://developer.android.com/studio/publish/app-signing>
- APK vs Android App Bundle:
  <https://developer.android.com/guide/app-bundle/faq>
- Alternative distribution and unknown-app opt-in:
  <https://developer.android.com/distribute/marketing-tools/alternative-distribution>
- PackageInstaller failure categories:
  <https://developer.android.com/reference/android/content/pm/PackageInstaller>
- Android developer verification FAQ:
  <https://developer.android.com/developer-verification/guides/faq>
