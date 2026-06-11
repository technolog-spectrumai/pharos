# Running Enigma on the Android emulator

How the Enigma Tauri app was launched on an Android emulator for local testing
(used to verify the SQLite local-storage work and the mobile navbar fixes).

## Prerequisites (already present on this machine)

| Tool | Location / value |
|------|------------------|
| Android SDK | `~/Android/Sdk` (`ANDROID_HOME`) |
| Android NDK | `~/Android/android-ndk-r27d` (`NDK_HOME`) — also `Sdk/ndk/29.0.13846066` |
| Java | OpenJDK 17 |
| Rust targets | `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` |
| AVD | `Pixel_9` (x86_64) |
| Tauri Android project | `src-tauri/gen/android` (already initialized) |

Relevant env vars (Tauri reads these to find the SDK/NDK):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$HOME/Android/android-ndk-r27d"
```

List available AVDs / installed targets if needed:

```bash
"$ANDROID_HOME/emulator/emulator" -list-avds      # -> Pixel_9
rustup target list --installed | grep android
```

## 1. Boot the emulator

Launched headless-friendly with software GPU (works without a physical GPU) and
without persisting snapshots, so each run is a clean boot:

```bash
"$ANDROID_HOME/emulator/emulator" -avd Pixel_9 \
  -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect
```

Run it as a long-lived background process — it must stay up for the whole session.

Wait until Android finishes booting before deploying:

```bash
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 5
done
adb devices          # -> emulator-5554   device
```

## 2. Build, install and run the app

From this directory (`enigma/enigma`):

```bash
npm run tauri android dev
```

Tauri auto-detects the connected emulator and its ABI (`x86_64-linux-android`),
runs the `beforeDevCommand` (Vite dev server on `:1420`, reverse-tunneled to the
device via `adb reverse`), cross-compiles the Rust lib + the `tauri-plugin-sql`
native lib, builds the APK with Gradle, installs it and launches it. Success
looks like:

```
Performing Streamed Install
Success
Starting: Intent { cmp=com.spectrumaipl.enigma/.MainActivity }
```

Frontend edits hot-reload over the dev server (`[vite] hmr update ...`); changes
to Rust or native Android config trigger a rebuild.

> First build is slow (full Rust dependency tree for Android, incl. SQLite via
> the NDK). Later runs are incremental.

## 3. Driving / inspecting the emulator with adb

```bash
# Screenshot the current screen
adb exec-out screencap -p > /tmp/enigma.png

# Tap a point (device pixels) — e.g. the header hamburger button
adb shell input tap 993 222

# Force orientation (to test rotation): 0=portrait, 1=landscape
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1

# Screen geometry
adb shell wm size        # Physical size: 1080x2424
adb shell wm density     # Physical density: 420

# App package / relaunch
adb shell pm list packages | grep enigma   # com.spectrumaipl.enigma
adb shell am start -n com.spectrumaipl.enigma/.MainActivity
```

## 4. Shut down

Stop `npm run tauri android dev` (Ctrl-C / kill the process), then:

```bash
adb emu kill            # stop the emulator
# or: adb -s emulator-5554 emu kill
```
