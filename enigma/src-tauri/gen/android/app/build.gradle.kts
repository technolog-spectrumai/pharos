import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// ── Release signing ──────────────────────────────────────────────────────────
//
// Credential precedence, per key (storeFile, storePassword, keyAlias,
// keyPassword) — mirrored in Python by tools/android/android_signing/signing.py; keep
// the two in lockstep (its check_gradle() asserts these names appear here):
//
//   1. a ${VAR} placeholder in gen/android/keystore.properties;
//   2. the well-known environment variable — VESPER_KEYSTORE_FILE,
//      VESPER_KEYSTORE_PASSWORD, VESPER_KEY_ALIAS, VESPER_KEY_PASSWORD;
//   3. a literal in keystore.properties (gitignored, never committed);
//   4. $XDG_CONFIG_HOME/vesper-builder/signing.properties (default
//      ~/.config/…), which must be chmod 600 — outside every repo.
//
// Two deliberate refusals:
//
//   * FAIL CLOSED. With no usable credentials, a *release* build stops with
//     the error below instead of quietly producing
//     app-universal-release-unsigned.apk. Debug builds are untouched and keep
//     using the SDK's debug signing.
//   * NO DEBUG KEY. ~/.android/debug.keystore ships with the SDK and its
//     password is published. An APK signed with it can never be updated by a
//     real release, and anyone can forge an update for it. Naming it — by path
//     or by the androiddebugkey alias — fails the release build outright.

val keystorePropertiesFile: File = rootProject.file("keystore.properties")

val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

// The machine-global fallback (rule 4). Ignored with a warning unless 0600 —
// it may hold passwords and, unlike the env, it persists.
val localSigningFile: File = run {
    val xdg = providers.environmentVariable("XDG_CONFIG_HOME").orNull?.trim().orEmpty()
    val base = if (xdg.isEmpty()) File(System.getProperty("user.home"), ".config") else File(xdg)
    File(base, "vesper-builder/signing.properties")
}

var localSigningProblem: String? = null
val localSigningProperties = Properties().apply {
    if (localSigningFile.isFile) {
        val lax = try {
            val perms: Set<PosixFilePermission> =
                Files.getPosixFilePermissions(localSigningFile.toPath())
            perms.any { p -> p.name.startsWith("GROUP_") || p.name.startsWith("OTHERS_") }
        } catch (_: UnsupportedOperationException) {
            false // non-POSIX filesystem: nothing to check
        }
        if (lax) {
            localSigningProblem =
                "${localSigningFile.absolutePath} is readable by group/other. " +
                    "Run: chmod 600 ${localSigningFile.absolutePath}"
        } else {
            localSigningFile.inputStream().use { load(it) }
        }
    }
}

val requiredSigningKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")

val envForSigningKey = mapOf(
    "storeFile" to "VESPER_KEYSTORE_FILE",
    "storePassword" to "VESPER_KEYSTORE_PASSWORD",
    "keyAlias" to "VESPER_KEY_ALIAS",
    "keyPassword" to "VESPER_KEY_PASSWORD",
)

// `storePassword=${MY_VAR}` — the whole value must be a single placeholder.
val signingPlaceholder = Regex("^\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}$")

/** Unresolved-placeholder errors, collected so the message can name the VAR. */
val placeholderProblems = mutableListOf<String>()

fun signingProperty(name: String): String {
    val raw = (keystoreProperties.getProperty(name) ?: "").trim()
    val placeholder = signingPlaceholder.matchEntire(raw)
    if (placeholder != null) {
        val variable = placeholder.groupValues[1]
        val fromEnv = providers.environmentVariable(variable).orNull?.trim().orEmpty()
        if (fromEnv.isNotEmpty()) return fromEnv
        // Unset env var: fall through to the 0600 local config before
        // erroring — `signing android create` writes placeholders repo-side
        // and the real values there. Mirrors signing.py.
        val fromLocal = (localSigningProperties.getProperty(name) ?: "").trim()
        if (fromLocal.isNotEmpty()) return fromLocal
        placeholderProblems +=
            "$name is set to \${$variable} in ${keystorePropertiesFile.name} " +
                "but \$$variable is not set in the environment, and " +
                "${localSigningFile.absolutePath} does not provide $name either."
        return ""
    }
    val fromEnv = providers.environmentVariable(envForSigningKey.getValue(name))
        .orNull?.trim().orEmpty()
    if (fromEnv.isNotEmpty()) return fromEnv
    if (raw.isNotEmpty()) return raw
    return (localSigningProperties.getProperty(name) ?: "").trim()
}

/** storeFile resolved like the Python mirror: ~ expanded, relative to gen/android. */
fun resolveStoreFile(raw: String): File {
    val expanded = if (raw == "~" || raw.startsWith("~/")) {
        File(System.getProperty("user.home"), raw.removePrefix("~").removePrefix("/"))
    } else {
        File(raw)
    }
    return if (expanded.isAbsolute) expanded else File(rootProject.projectDir, raw)
}

fun isDebugKeystore(store: File): Boolean {
    if (store.name == "debug.keystore") return true
    val sdkDefault = File(System.getProperty("user.home"), ".android/debug.keystore")
    return store.canonicalFile == sdkDefault.canonicalFile
}

/** Whether storeFile's value came from keystore.properties (relative paths
 *  are legal there, resolved against gen/android) or from the env/local file
 *  (machine-global, so a relative path is ambiguous and refused). */
fun storeFileIsFromPropertiesFile(): Boolean {
    val raw = (keystoreProperties.getProperty("storeFile") ?: "").trim()
    if (raw.isEmpty() || signingPlaceholder.matchEntire(raw) != null) return false
    // A literal in the file loses to the env var (rule 2 beats rule 3).
    val fromEnv = providers.environmentVariable("VESPER_KEYSTORE_FILE").orNull?.trim().orEmpty()
    return fromEnv.isEmpty()
}

/** Why a release build cannot be signed, or null when it can. */
val releaseSigningProblem: String? = run {
    val missing = requiredSigningKeys.filter { signingProperty(it).isEmpty() }
    val alias = signingProperty("keyAlias")
    val rawStore = signingProperty("storeFile")
    val fromFile = storeFileIsFromPropertiesFile()
    when {
        localSigningProblem != null -> localSigningProblem

        placeholderProblems.isNotEmpty() -> placeholderProblems.joinToString("\n")

        missing.size == requiredSigningKeys.size ->
            "No release signing credentials found.\n" +
                "Provide them via ${keystorePropertiesFile.absolutePath} (copy " +
                "keystore.properties.example), the VESPER_KEYSTORE_* / " +
                "VESPER_KEY_* environment variables, or " +
                "${localSigningFile.absolutePath} (chmod 600).\n" +
                "Required: ${requiredSigningKeys.joinToString(", ")}."

        missing.isNotEmpty() ->
            "Release signing is missing ${missing.joinToString(", ")} — all " +
                "of ${requiredSigningKeys.joinToString(", ")} are required " +
                "(from keystore.properties, the environment, or " +
                "${localSigningFile.absolutePath})."

        !fromFile && !rawStore.startsWith("~") && !File(rawStore).isAbsolute ->
            "storeFile '$rawStore' came from the environment or " +
                "${localSigningFile.absolutePath} and must be an absolute " +
                "path or start with ~/."

        alias == "androiddebugkey" || isDebugKeystore(resolveStoreFile(rawStore)) ->
            "Release signing points at the Android DEBUG key (storeFile " +
                "'$rawStore', keyAlias '$alias').\n" +
                "The debug key ships with the SDK and its password is " +
                "publicly known: it must never sign a release. An APK " +
                "signed with it cannot be updated by a real release, and " +
                "anyone can forge an update for it.\n" +
                "Generate a release keystore instead:\n" +
                "  keytool -genkeypair -v -keystore vesper-release.jks " +
                "-alias vesper -keyalg RSA -keysize 4096 -validity 10000"

        !resolveStoreFile(rawStore).isFile ->
            "storeFile '$rawStore' does not exist (resolved to " +
                "${resolveStoreFile(rawStore).absolutePath})."

        else -> null
    }
}

android {
    compileSdk = 36
    namespace = "com.spectrumaipl.vesper"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.spectrumaipl.vesper"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        // Created only when the credentials are complete and not the debug key;
        // otherwise the release buildType below gets no config at all and the
        // task-graph gate refuses the build.
        if (releaseSigningProblem == null) {
            create("release") {
                storeFile = resolveStoreFile(signingProperty("storeFile"))
                storePassword = signingProperty("storePassword")
                keyAlias = signingProperty("keyAlias")
                keyPassword = signingProperty("keyPassword")
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

// Fail closed: refuse to *start* a release build we cannot sign, rather than
// spending the Rust compile and handing back an -unsigned.apk. Checked on the
// task graph so it fires before any work, and only for this module's release
// packaging tasks — a debug build never trips it.
// The unsigned-release escape hatch. Set ONLY by scripts/build_android.sh
// --allow-unsigned-release (via ORG_GRADLE_PROJECT_vesperAllowUnsignedRelease,
// the one env→property bridge that survives the tauri CLI, which forwards
// nothing to Gradle). Read ONLY here, never inside signingConfigs — so it can
// waive *unsigned*, but can never change WHICH key signs, and in particular
// can never fall back to the debug key: a debug keystore still refuses above.
val allowUnsignedRelease = (findProperty("vesperAllowUnsignedRelease") as? String) == "true"

gradle.taskGraph.whenReady {
    // Kotlin DSL: the Action overload makes the graph the receiver — a named
    // `graph ->` parameter fails script compilation against the Closure
    // overload, which is exactly how this gate once shipped broken.
    val problem = releaseSigningProblem
    if (problem != null) {
        val producers = listOf("assemble", "bundle", "package")
        val wantsRelease = allTasks.any { task ->
            task.project.path == project.path &&
                task.name.contains("Release") &&
                producers.any { p -> task.name.startsWith(p) }
        }
        if (wantsRelease && allowUnsignedRelease && !problem.contains("DEBUG key")) {
            logger.warn(
                "\n*** UNSIGNED RELEASE ***\n" +
                    "Building WITHOUT a release signature on explicit request\n" +
                    "(--allow-unsigned-release). This artifact installs nowhere\n" +
                    "and must never be distributed.\n"
            )
        } else if (wantsRelease) {
            throw GradleException(
                "\n\nRelease signing is not configured — refusing to build an " +
                    "unsigned release.\n\n$problem\n\n" +
                    "Debug builds are unaffected: `tauri android build --debug` " +
                    "still uses the SDK debug key.\n"
            )
        }
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")