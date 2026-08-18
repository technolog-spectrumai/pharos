import java.io.File
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
// Credentials live in gen/android/keystore.properties, which is gitignored and
// never committed; keystore.properties.example documents the four keys. The
// rules below are mirrored in Python by tools/enigma_builder/signing.py — keep
// the two in lockstep.
//
// Two deliberate refusals:
//
//   * FAIL CLOSED. With no usable keystore.properties, a *release* build stops
//     with the error below instead of quietly producing
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

val requiredSigningKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")

fun signingProperty(name: String): String =
    (keystoreProperties.getProperty(name) ?: "").trim()

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

/** Why a release build cannot be signed, or null when it can. */
val releaseSigningProblem: String? = run {
    if (!keystorePropertiesFile.exists()) {
        "${keystorePropertiesFile.absolutePath} does not exist.\n" +
            "Copy keystore.properties.example next to it as keystore.properties " +
            "and fill in: ${requiredSigningKeys.joinToString(", ")}.\n" +
            "It is gitignored — never commit it, or the keystore it names."
    } else {
        val missing = requiredSigningKeys.filter { signingProperty(it).isEmpty() }
        val alias = signingProperty("keyAlias")
        val rawStore = signingProperty("storeFile")
        when {
            missing.isNotEmpty() ->
                "${keystorePropertiesFile.absolutePath} is missing " +
                    "${missing.joinToString(", ")} — all of " +
                    "${requiredSigningKeys.joinToString(", ")} are required."

            alias == "androiddebugkey" || isDebugKeystore(resolveStoreFile(rawStore)) ->
                "${keystorePropertiesFile.absolutePath} points at the Android " +
                    "DEBUG key (storeFile '$rawStore', keyAlias '$alias').\n" +
                    "The debug key ships with the SDK and its password is " +
                    "publicly known: it must never sign a release. An APK " +
                    "signed with it cannot be updated by a real release, and " +
                    "anyone can forge an update for it.\n" +
                    "Generate a release keystore instead:\n" +
                    "  keytool -genkeypair -v -keystore enigma-release.jks " +
                    "-alias enigma -keyalg RSA -keysize 4096 -validity 10000"

            !resolveStoreFile(rawStore).isFile ->
                "storeFile '$rawStore' from ${keystorePropertiesFile.absolutePath} " +
                    "does not exist (resolved to ${resolveStoreFile(rawStore).absolutePath})."

            else -> null
        }
    }
}

android {
    compileSdk = 36
    namespace = "com.spectrumaipl.enigma"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.spectrumaipl.enigma"
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
gradle.taskGraph.whenReady { graph ->
    val problem = releaseSigningProblem
    if (problem != null) {
        val producers = listOf("assemble", "bundle", "package")
        val wantsRelease = graph.allTasks.any { task ->
            task.project.path == project.path &&
                task.name.contains("Release") &&
                producers.any { task.name.startsWith(it) }
        }
        if (wantsRelease) {
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