// 顶层构建脚本：只声明插件版本，不在这里引入任何依赖。
//
// AGP 8.7.2 与 Gradle 8.11.1 是配对的（AGP 8.7 要求 Gradle >= 8.9）；
// JDK 用 21（本机 C:\Users\201\android-build\jdk），AGP 8.x 支持 17~21。
plugins {
    id("com.android.application") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
