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
        versionCode = 2
        versionName = "1.0.1"

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
        // 实测：debug 23.5 MB → release 11.17 MB（R8 + 资源收缩也各出一份力）。
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

/*
 * 每次构建都把签名密钥同步一份到本机备份目录。
 *
 * 为什么塞进构建里，而不是写成「记得手动抄一份」：
 *   出包这一刻，密钥**一定在场、而且就是当前在用的那一把** —— 这是唯一一个
 *   「不会忘」的时机。而丢了密钥的代价是**永久性**的：安卓靠签名一致判断
 *   是不是同一个 App，换新密钥出的包系统会当成另一个 App、拒绝覆盖安装，
 *   存量用户必须卸载重装（聊天记录一起清掉）。
 *
 * ⚠ 只复制，不删除：备份目录里可能有从别处恢复的文件，构建任务不该动它。
 * ⚠ 备份目录不可用（外接盘没插 / 换了机器 / CI）时**只警告、绝不中断构建** ——
 *   备份失败不该拦住出包。
 */
val keystoreDir = rootProject.file("keystore")
val keystoreBackupDir = File("E:/密钥备份/" + rootProject.name.lowercase())

tasks.register("backupSigningKey") {
    group = "roomtalk"
    description = "把 android/keystore 下的密钥与口令同步到 E:/密钥备份（只复制，不删除）"

    doLast {
        if (!keystoreDir.isDirectory) {
            logger.lifecycle("[备份密钥] 没有 $keystoreDir，跳过")
            return@doLast
        }
        try {
            keystoreBackupDir.mkdirs()
            var copied = 0
            keystoreDir.listFiles()?.forEach { f ->
                // 只往外抄真正的密钥材料。别的文件（临时文件、误放的截图）不碰 ——
                // 备份目录是「最不该多东西」的地方。
                val looksLikeKey = f.isFile && (
                    f.name.endsWith(".jks") || f.name.endsWith(".keystore") ||
                        f.name == "keystore.properties"
                    )
                if (!looksLikeKey) return@forEach

                val out = File(keystoreBackupDir, f.name)
                // 内容一致就不动它，避免每次构建都刷新文件时间戳
                if (out.exists() && out.length() == f.length() &&
                    out.readBytes().contentEquals(f.readBytes())
                ) return@forEach

                f.copyTo(out, overwrite = true)
                copied++
                logger.lifecycle("[备份密钥] 已更新 → $out")
            }

            val notes = File(keystoreBackupDir, "README-密钥说明.txt")
            if (!notes.exists()) {
                logger.warn("[备份密钥] ⚠ $notes 不存在，建议补一份恢复说明（指纹、别名、还原步骤）")
            }
            logger.lifecycle("[备份密钥] 完成：$keystoreBackupDir（本次更新 $copied 个文件）")
        } catch (e: Exception) {
            logger.warn("[备份密钥] ⚠ 备份失败，但**不影响本次构建**：${e.message}")
        }
    }
}

// 挂在 preBuild 上：assembleDebug / assembleRelease 都会先走它。
// 用 matching 而不是 named，是为了在 AGP 版本变化、任务改名时不至于直接报错。
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn("backupSigningKey") }

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
