# WebRTC 的类会被 JNI 与 native 层按名字回调，混淆掉就等于把桥炸了。
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# ⚠⚠⚠ jni_zero —— WebRTC M120+ 的 JNI 绑定运行时。**漏了这一条必崩，而且崩得极其误导。**
#
# 它的类是给 native 侧在 JNI_OnLoad 阶段按【类名】FindClass 找的，Java 侧代码
# 不直接引用 —— 于是 R8 把整个 org.jni_zero 包当死代码清掉（实测清得一个不剩）。
#
# 清掉之后的症状：**不是** Java 异常（try/catch 抓不到），**不是** ANR，
# 而是 ART 主动 abort 的原生崩溃，进程被直接抹掉：
#
#     JNI DETECTED ERROR IN APPLICATION: java_class == null
#         in call to GetStaticMethodID
#         from java.lang.String java.lang.Runtime.nativeLoad(String, ClassLoader, Class)
#     libc: Fatal signal 6 (SIGABRT) in tid 1 (main)
#     backtrace: libjingle_peerconnection_so.so
#
# 触发点就是 PeerConnectionFactory.initialize() —— 也就是点「进入房间」那一下。
#
# 实测（webrtc-sdk 150.7871.01 / R8 8.7.18 / 华为 nova 5 Pro / Android 10）：
#   没有本规则：dex 里 org/jni_zero 的类数 = 0        → 必崩
#   加上本规则：dex 里 org/jni_zero 的类数 > 0        → 正常
-keep class org.jni_zero.** { *; }
-keep interface org.jni_zero.** { *; }
-dontwarn org.jni_zero.**

# jni_zero 靠这三个注解在 native 侧做双向绑定：某个类/方法被注解了，
# 就说明 native 会按名字回来找它。注解本身被 keep 了才解析得动下面两条。
-keep @org.jni_zero.JNINamespace class *
-keepclasseswithmembers class * {
    @org.jni_zero.CalledByNative <methods>;
}
-keepclasseswithmembers class * {
    @org.jni_zero.CalledByNativeForTesting <methods>;
}

# OkHttp 在 Android 上会尝试用 Conscrypt / BouncyCastle 之类的可选实现
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# org.json 是系统自带的，别被打包进去
-dontwarn org.json.**
