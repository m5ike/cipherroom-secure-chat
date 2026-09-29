// The M5cet app. Its version follows the repository's package.json
// (6.0.0 → versionCode 60000), so the app, the server and the bundles agree.
//
// Optional build properties (gradle.properties, -P… or environment):
//   m5.server       the server the app enrols with by default (https://…)
//   m5.serverKey    the kid of the server's Android key; the app then refuses
//                   any other key at enrolment (pinning from the first start)
//   m5.keystore / m5.keystorePassword / m5.keyAlias / m5.keyPassword
//                   the release signing key (M5_KEYSTORE… in the environment)

import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

val rootPackage = file("../../package.json")
val appVersion: String = (JsonSlurper().parse(rootPackage) as Map<*, *>)["version"] as String
val appVersionCode: Int = appVersion.split(".").let { p -> p[0].toInt() * 10000 + p[1].toInt() * 100 + p[2].takeWhile { it.isDigit() }.toInt() }

fun prop(name: String, env: String): String? =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() } ?: System.getenv(env)?.takeIf { it.isNotBlank() }

android {
    namespace = "cz.m5cet.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "cz.m5cet.app"
        minSdk = 29
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersion
        buildConfigField("String", "DEFAULT_SERVER", "\"${prop("m5.server", "M5_SERVER") ?: ""}\"")
        buildConfigField("String", "SERVER_KEY_PIN", "\"${prop("m5.serverKey", "M5_SERVER_KEY") ?: ""}\"")
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        val store = prop("m5.keystore", "M5_KEYSTORE")
        if (store != null) {
            create("release") {
                storeFile = file(store)
                storePassword = prop("m5.keystorePassword", "M5_KEYSTORE_PASSWORD")
                keyAlias = prop("m5.keyAlias", "M5_KEY_ALIAS") ?: "m5cet"
                keyPassword = prop("m5.keyPassword", "M5_KEY_PASSWORD") ?: prop("m5.keystorePassword", "M5_KEYSTORE_PASSWORD")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
        getByName("debug") {
            applicationIdSuffix = ""
            isDebuggable = true
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions { unitTests.isReturnDefaultValues = true }

    packaging { resources.excludes += listOf("META-INF/*.kotlin_module", "META-INF/versions/**") }
}

dependencies {
    // Push: FCM, initialised at run time with the server's Firebase settings
    // (no google-services.json in the APK — one build serves any server).
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    // WebRTC: peer connections and the "m5cet" data channel, calls.
    implementation("io.github.webrtc-sdk:android:150.7871.01")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    // 6.1: passkeys (the user's account) through the platform's Credential Manager.
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")

    testImplementation("junit:junit:4.13.2")
    // The real org.json on the JVM (android.jar only has stubs).
    testImplementation("org.json:json:20250517")
}
