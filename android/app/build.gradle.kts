// fix-3
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Ondertekening:
// - Zijn de omgevingsvariabelen ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS en
//   ANDROID_KEY_PASSWORD gezet (in GitHub Actions uit de repository-secrets), dan wordt daarmee getekend.
// - Anders: de meegeleverde ONTWIKKEL-sleutel signing/pdfreader-dev.jks. Die is openbaar (staat in de repo)
//   en bewijst dus niets over wie de APK maakte; hij zorgt er alleen voor dat elke nieuwe APK over de vorige
//   heen geïnstalleerd kan worden. Zie README, sectie "Android-app".
val envKeystore: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() && File(it).isFile }
val devKeystore = rootProject.file("signing/pdfreader-dev.jks")
val devPassword = "pdfreader-dev" // alleen voor de openbare ontwikkel-sleutel

// versionCode moet bij elke update hoger worden: in CI het runnummer van de workflow.
val runNumber: Int = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1

android {
    namespace = "io.github.bruindav.pdfreader"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.bruindav.pdfreader"
        minSdk = 26
        targetSdk = 35
        versionCode = runNumber
        versionName = "fix-3.$runNumber"
    }

    signingConfigs {
        create("release") {
            if (envKeystore != null) {
                storeFile = File(envKeystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            } else {
                storeFile = devKeystore
                storePassword = devPassword
                keyAlias = "pdfreader-dev"
                keyPassword = devPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        // Lint mag de release-build niet blokkeren; fouten zie je in het rapport.
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-ktx:1.13.1")
}
