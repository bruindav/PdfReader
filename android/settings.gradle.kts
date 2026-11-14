// fix-3
// PdfReader Android-app: dunne WebView-schil rond https://bruindav.github.io/PdfReader/
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "PdfReader"
include(":app")
