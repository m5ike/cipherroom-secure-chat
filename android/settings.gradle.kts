// M5cet for Android (6.0) — the native app and framework.
// Build: ./gradlew assembleDebug (or `npm run android:build` from the repo root).
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "m5cet-android"
include(":app")
