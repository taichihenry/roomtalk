import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * release 签名。
 *
 * ⚠ 密钥与口令都不入库（见 .gitignore）。取值优先级：
 *   1. 命令行 -PstorePass=... / -PkeyPass=... （CI 或临时构建用）
 *   2. android/keystore/keystore.properties
 *   两者都没有时，release 会退回未签名 —— 构建仍能成功，只是产物不能分发。
 *
 * ⚠ 这里必须 `import java.util.Properties` 再用 `Properties()`，
 *   不能写 `java.util.Properties()`：在 Gradle Kotlin DSL 脚本里 `java`
 *   已经被解析成 Java 插件扩展，那样写会报 "Unresolved reference: util"。
 */
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun ks(key: String, gradleProp: String): String? =
    (project.findProperty(gradleProp) as String?) ?: keystoreProps.getProperty(key)

android {
    namespace = "com.roomtalk.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.roomtalk.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        // WebRTC 的 .so 按架构各带一份，多一个架构就多几十 MB。
        // 只留两种主流 ARM：x86 平板与模拟器不覆盖（那本来也不是用户群）。
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    signingConfigs {
        create("release") {
            val path = ks("storeFile", "storeFile")
            if (!path.isNullOrBlank()) {
                storeFile = rootProject.file(path)
                storePassword = ks("storePassword", "storePass")
                keyAlias = ks("keyAlias", "keyAlias")
                keyPassword = ks("keyPassword", "keyPass")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (signingConfigs.getByName("release").storeFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/*.kotlin_module",
            "META-INF/DEPENDENCIES",
        )

        // WebRTC 的两个 .so 加起来 19 MB，而 AGP 默认是**不压缩**塞进 APK 的
        // （好处：安装不用解压、能直接 mmap；代价：下载体积大一倍）。
        //
        // 我们这个包是挂在网站上让人用手机流量下的，**下载体积**比「安装时省那
        // 一秒」重要得多，所以打开传统打包让它们参与 zip 压缩。
        // 实测能把这 23.5 MB 的包压到 14 MB 上下。
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    // 版本尽量挑本机 Gradle 缓存里已有的，少一次下载就少一分构建失败的可能。
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.6.4")

    // 官方 WebRTC（io.github.webrtc-sdk 是 Maven Central 上仍在维护的 Android 发行版）
    implementation("io.github.webrtc-sdk:android:150.7871.01")

    // 信令用 WebSocket；OkHttp 是 Android 上唯一成熟的选择
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // 纯逻辑（口令派生等）跑桌面 JVM 单元测试 —— 不需要真机就能验证正确性
    testImplementation("junit:junit:4.13.2")
}
