# WebRTC 的类会被 JNI 与 native 层按名字回调，混淆掉就等于把桥炸了。
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# OkHttp 在 Android 上会尝试用 Conscrypt / BouncyCastle 之类的可选实现
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# org.json 是系统自带的，别被打包进去
-dontwarn org.json.**
