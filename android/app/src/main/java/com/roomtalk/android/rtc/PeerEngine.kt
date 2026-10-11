package com.roomtalk.android.rtc

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.util.Log
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraEnumerator
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.Logging
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoCapturer
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.AudioDeviceModule
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * WebRTC 引擎：管一台 [PeerConnection] 的生死，以及本地麦克风/摄像头的采集与发送。
 *
 * 这里有两条从网页端搬过来的铁律，务必别改回去：
 *
 * ① **采集与发送是两件事。** `ensureMic()` / `ensureCam()` 只把轨道建出来（能本地
 *    预览），**不 addTrack**；只有 [publishLocal] 才真正开始往对端推。原因是用户
 *    实测报过的隐私 bug：一按「发起通话」对方还没接听就能听到看到你 —— 根因就是
 *    采集即发送。所以「按了发起」绝不能等于「开始推流」。
 *
 * ② **通话态判据只看 callKind，不看有没有轨道。** 视频通话里关摄像头，轨道还在、
 *    只是 disabled —— 拿「有没有视频轨」判断「是否在通话」会在那一刻集体错乱。
 *
 * ③ **WebRTC 的回调一律不在主线程上。** `PeerConnection.Observer` 在 signaling
 *    线程派发、`DataChannel.Observer` 在 network 线程派发，而它们往上走
 *    （onConnectionChange / onRemoteTrack / onDcMessage / onChannelReady…）
 *    最后几乎都会去改 TextView、动 SurfaceViewRenderer —— 那是**只有主线程**能做的事。
 *
 *    越界的后果不是普通的闪退。Android 抛 CalledFromWrongThreadException，它从 JNI
 *    回调里逃出去时会被 WebRTC 的 `sdk/android/src/jni/jvm.cc` 当成致命错误直接
 *    abort 整个进程：
 *
 *        Fatal error in: ../../../sdk/android/src/jni/jvm.cc, line 81
 *        Check failed: false
 *        libc: Fatal signal 6 (SIGABRT) in tid ... (signaling_threa)
 *
 *    这是 **native 崩溃**，Java 层的 try/catch 和 UncaughtExceptionHandler 一个都
 *    接不到（v1.0.1 加的那套崩溃兜底对它完全无效）。所以下面**每一个** native
 *    回调都套了 [main].post —— 新增回调时不许省。
 */
class PeerEngine(private val context: Context) {

    /**
     * 把 native 回调送回主线程。见类注释③ —— 这不是「顺手优化」，是保命的。
     *
     * 刻意用全限定名而不 import：文件末尾对 CoroutineScope 也是这么写的，
     * 少两行 import 就少一分将来被误删的可能。
     */
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    /** 对端轨道到了 —— 是否接进渲染器由上层按通话态决定（未接通时只攒着）。 */
    var onRemoteTrack: (() -> Unit)? = null

    /** 需要发给对端的信令（SDP / ICE），上层负责走 WebSocket 转出去。 */
    var onLocalSdp: ((type: String, sdp: String) -> Unit)? = null
    var onLocalIce: ((IceCandidate) -> Unit)? = null

    /** DataChannel 上的文本消息（控制消息：msg / media / ring / xfer ctl…）。 */
    var onDcMessage: ((String) -> Unit)? = null

    /**
     * DataChannel 上的**二进制**分片（文件 / 语音的正文）。
     *
     * 与文本一样切回主线程再回调 —— 这不是「顺手」，是为了**保序**：
     * 文本走 `main.post`，二进制若在别处就地处理，两者就会落到两条队列上，
     * 接收端会出现「分片先到、begin 后到」的错位（状态机还没建好就收数据）。
     * 两条都进主线程队列，FIFO 天然把顺序固定住。
     */
    var onDcBinary: ((ByteArray) -> Unit)? = null
    var onDcOpen: (() -> Unit)? = null
    var onDcClosed: (() -> Unit)? = null

    /** 连接状态变化，用于界面提示与「重连不打断通话」的判断。 */
    var onConnectionChange: ((PeerConnection.PeerConnectionState) -> Unit)? = null

    private var factory: PeerConnectionFactory? = null
    private var eglBase: EglBase? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private var adm: AudioDeviceModule? = null

    private var pc: PeerConnection? = null
    private var dc: DataChannel? = null

    private var audioSource: org.webrtc.AudioSource? = null
    private var audioTrack: org.webrtc.AudioTrack? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var capturer: VideoCapturer? = null
    private var capturerFacingFront = true

    private var rendererBig: SurfaceViewRenderer? = null
    private var rendererSmall: SurfaceViewRenderer? = null

    /** 我铺满（true）还是对方铺满（false）—— 与网页端 S.stageMain 同义 */
    private var stageLocalMain = false

    private var stream: MediaStream? = null

    /** Perfect Negotiation 用到的三个状态位，与网页端同名同义。 */
    private var polite = true
    private var makingOffer = false
    private var ignoreOffer = false
    private var settingAnswer = false

    /** 采集期申请（防两次快速点击各建一套采集，留下关不掉的摄像头）。 */
    @Volatile private var micStarting = false

    val hasMic: Boolean get() = audioTrack != null
    val hasCam: Boolean get() = videoTrack != null

    /** PeerConnection 是否还在（判断「已经在连了，别重建」用）。 */
    val hasPeer: Boolean get() = pc != null

    /** 数据通道是否已开。 */
    val isChannelOpen: Boolean get() = dc?.state() == DataChannel.State.OPEN

    fun hasMicEnabled(): Boolean = audioTrack?.enabled() ?: false
    fun hasCamEnabled(): Boolean = videoTrack?.enabled() ?: false

    /**
     * 给界面层用的 GL 上下文。
     *
     * ⚠ SurfaceViewRenderer.init() 必须传**这一个**：采集、解码、上屏三者共用同一
     * 个 EglBase，画面才出得来。各建各的 EglBase 会出现「有声音没画面」。
     * [initFactory] 之后才非空。
     */
    val eglContext: EglBase.Context? get() = eglBase?.eglBaseContext

    /* ============================ 生命周期 ============================ */

    /** 建工厂（幂等）。EglBase 与采集线程全局一份就够。 */
    fun initFactory() {
        if (factory != null) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions(),
        )
        val egl = EglBase.create()
        eglBase = egl
        textureHelper = SurfaceTextureHelper.create("rt-capture", egl.eglBaseContext)

        /*
         * 显式建音频设备模块，**不**让工厂自己造一个默认的。两个理由：
         *
         * ① 打开硬件回声消除 + 降噪。通话应用不开这两个基本没法用 ——
         *    对方会听到自己的回声，且地铁/风扇底噪会一路传过去。
         * ② 声明 USAGE_VOICE_COMMUNICATION。系统的音量键与音频路由是按
         *    「用途」分档的，不声明的话音量键调的是「媒体音量」，用户按了没反应，
         *    会以为我们的音量坏了。
         *
         * ⚠ 这个类在 org.webrtc.audio 包里，不在 org.webrtc 下（网上很多老代码
         *   写的是 org.webrtc.JavaAudioDeviceModule，那是对着旧版本 SDK 的）。
         */
        val audioModule = JavaAudioDeviceModule.builder(context)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .createAudioDeviceModule()
        adm = audioModule

        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
    }

    /* ============================== 音频路由 ============================== */

    /** 当前是不是免提。默认开（和网页端一致 —— 手机浏览器里就是外放）。 */
    var speakerOn: Boolean = true
        private set

    /**
     * 免提开关。
     *
     * ⚠ AudioManager 是整个进程（乃至整个系统）共享的，我们改的是全局音频模式，
     *   所以**收摊时必须复位**（见 [resetAudioRoute]），否则挂断之后这台手机的
     *   音频路由还停在「通话」状态，别的应用声音会变得又小又闷。
     */
    @Suppress("DEPRECATION")
    fun setSpeaker(on: Boolean) {
        speakerOn = on
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.isSpeakerphoneOn = on
        } catch (t: Throwable) {
            Log.w(TAG, "切换扬声器失败", t)
        }
    }

    /** 通话结束后把全局音频模式还回去。 */
    @Suppress("DEPRECATION")
    private fun resetAudioRoute() {
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
            am.isSpeakerphoneOn = false
            am.mode = AudioManager.MODE_NORMAL
        } catch (_: Throwable) {
        }
    }

    /** 建/重建 PeerConnection。ICE 用服务端下发的列表（我们只有 STUN，没有 TURN）。 */
    fun createPeer(iceServerUrls: List<String>, isPolite: Boolean, amCaller: Boolean) {
        initFactory()
        disposePeer()
        polite = isPolite
        makingOffer = false
        ignoreOffer = false

        val iceServers = iceServerUrls.filter { it.isNotBlank() }.map {
            PeerConnection.IceServer.builder(it).createIceServer()
        }
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            // 与网页端一致：候选持续收集，网络切换后还能自己找回通路
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

        val f = factory ?: error("工厂未初始化")
        pc = f.createPeerConnection(config, observer)

        // 数据通道只由**主叫方**创建（和网页端一致：两端都建会出现两条通道）
        if (amCaller) {
            val init = DataChannel.Init().apply { ordered = true }
            dc = pc?.createDataChannel("chat", init)
            bindChannel(dc)
        }
    }

    fun disposePeer() {
        try { dc?.close() } catch (_: Throwable) { }
        try { dc?.unregisterObserver() } catch (_: Throwable) { }
        dc = null
        try { pc?.close() } catch (_: Throwable) { }
        pc = null
    }

    /** 收摊：停采集、断开渲染、释放工厂。挂断 / 退房 / 被请出都走它。 */
    fun closeAll() {
        disposePeer()
        stopCapture()
        audioSource?.dispose(); audioSource = null
        audioTrack?.dispose(); audioTrack = null
        // 通话结束 → 立刻收回「对端画面上屏」的许可（下次接通要重新给）
        remoteRenderAllowed = false
        // 并把全局音频模式还回去，否则挂断后整个手机的声音都还是「通话」档
        resetAudioRoute()
        rendererBig?.let { detachRenderer(it) }
        rendererSmall?.let { detachRenderer(it) }
    }

    /** 解绑渲染器（Activity 销毁时必须调，否则 SurfaceView 会泄漏 EGL 上下文）。 */
    fun detachRenderer(renderer: SurfaceViewRenderer) {
        try { videoTrack?.removeSink(renderer) } catch (_: Throwable) { }
        try { remoteVideoTrack?.removeSink(renderer) } catch (_: Throwable) { }
        try { renderer.release() } catch (_: Throwable) { }
        if (rendererBig === renderer) rendererBig = null
        if (rendererSmall === renderer) rendererSmall = null
    }

    /** 界面销毁时一次性收走两块画布（只摘渲染器，<b>不动</b> PeerConnection）。 */
    fun releaseRenderers() {
        rendererBig?.let { detachRenderer(it) }
        rendererSmall?.let { detachRenderer(it) }
        rendererBig = null
        rendererSmall = null
    }

    /**
     * 对端画面到了 —— 是否真正上屏由 [isLive] 决定。
     * 未接通时轨道会被 WebRTC 收下，但画面不上屏（见 [remoteRenderAllowed]）。
     */
    fun bindRemoteIfLive(isLive: Boolean) {
        remoteRenderAllowed = isLive
        applyStage()
    }

    fun releaseEverything() {
        closeAll()
        try { textureHelper?.dispose() } catch (_: Throwable) { }
        textureHelper = null
        try { factory?.dispose() } catch (_: Throwable) { }
        factory = null
        // ⚠ ADM 要在工厂之后释放：工厂析构时会去用 ADM 把音频线程停掉，
        //   反过来的话会在退出应用时偶发 native 崩溃。
        try { adm?.release() } catch (_: Throwable) { }
        adm = null
        try { eglBase?.release() } catch (_: Throwable) { }
        eglBase = null
    }

    /* ========================== 音频 / 视频采集 ========================== */

    /**
     * 打开麦克风（幂等）。**只采集，不发送** —— 见类注释①。
     * @param publish 是否立即挂进 PeerConnection 开始推送。呼叫期间必须传 false。
     */
    fun ensureMic(publish: Boolean = false): Boolean {
        val f = factory ?: return false
        if (audioTrack != null) {
            audioTrack?.setEnabled(true)
            if (publish) attachAudioIfNeeded()
            return true
        }
        if (micStarting) return false
        micStarting = true
        try {
            val src = f.createAudioSource(MediaConstraints())
            val track = f.createAudioTrack("rt-audio0", src)
            audioSource = src
            audioTrack = track
            if (publish) attachAudioIfNeeded()
            return true
        } catch (t: Throwable) {
            Log.w(TAG, "麦克风打不开", t)
            return false
        } finally {
            micStarting = false
        }
    }

    /**
     * 打开摄像头（幂等），同样只采集不发送。
     *
     * 两阶段切换：**先把新摄像头要到手，成功了再放掉旧的**。手机不能同时开前后
     * 两颗（camera2 并发只在部分 Android 11+ 有），所以顺序反过来必然黑屏一瞬。
     */
    fun ensureCam(publish: Boolean = false, front: Boolean = capturerFacingFront): Boolean {
        if (videoTrack != null) {
            videoTrack?.setEnabled(true)
            if (publish) attachVideoIfNeeded()
            return true
        }
        val created = createCapture(front) ?: return false
        videoSource = created.first
        videoTrack = created.second
        capturerFacingFront = front
        applyStage()          // 本地预览立刻上屏（未接通时画布上就只有自己）
        if (publish) attachVideoIfNeeded()
        return true
    }

    /** 真正开始发送：把已采集的轨道挂进 PeerConnection（会触发一次重新协商）。 */
    fun publishLocal() {
        attachAudioIfNeeded()
        attachVideoIfNeeded()
    }

    private fun attachAudioIfNeeded() {
        val p = pc ?: return
        val t = audioTrack ?: return
        if (alreadySending(t)) return
        try {
            p.addTrack(t, listOf(STREAM_ID))
        } catch (e: Throwable) {
            Log.w(TAG, "挂音频轨失败", e)
        }
    }

    private fun attachVideoIfNeeded() {
        val p = pc ?: return
        val t = videoTrack ?: return
        if (alreadySending(t)) return
        try {
            val sender = p.addTrack(t, listOf(STREAM_ID))
            // 与网页端默认档「流畅」对齐：600 kbps。改档只动这一处。
            tuneBitrate(sender, DEFAULT_MAX_BITRATE)
        } catch (e: Throwable) {
            Log.w(TAG, "挂视频轨失败", e)
        }
    }

    private fun alreadySending(track: MediaStreamTrack): Boolean =
        pc?.senders?.any { it.track()?.id() == track.id() } == true

    private fun tuneBitrate(sender: RtpSender?, maxBitrate: Int) {
        try {
            val params = sender?.parameters ?: return
            val encodings = params.encodings ?: return
            if (encodings.isEmpty()) return          // 首次协商前 encodings 可能为空
            encodings[0].maxBitrateBps = maxBitrate
            sender.setParameters(params)
        } catch (e: Throwable) {
            Log.w(TAG, "设置码率上限失败", e)
        }
    }

    private fun createCapture(front: Boolean): Pair<VideoSource, VideoTrack>? {
        val f = factory ?: return null
        val helper = textureHelper ?: return null
        val enumerator = Camera2Enumerator(context)
        val name = pickDevice(enumerator, front) ?: run {
            Log.w(TAG, "没有可用摄像头")
            return null
        }
        val cap = try {
            enumerator.createCapturer(name, null)
        } catch (t: Throwable) {
            Log.w(TAG, "创建采集器失败: $name", t)
            return null
        } ?: return null

        return try {
            val src = f.createVideoSource(false)
            cap.initialize(helper, context, src.capturerObserver)
            cap.startCapture(CAPTURE_W, CAPTURE_H, CAPTURE_FPS)
            src.adaptOutputFormat(CAPTURE_W, CAPTURE_H, CAPTURE_FPS)
            val track = f.createVideoTrack("rt-video0", src)
            capturer = cap
            src to track
        } catch (t: Throwable) {
            Log.w(TAG, "启动采集失败", t)
            try { cap.dispose() } catch (_: Throwable) { }
            null
        }
    }

    private fun pickDevice(enumerator: CameraEnumerator, front: Boolean): String? {
        val names = enumerator.deviceNames
        if (names.isEmpty()) return null
        for (n in names) {
            if (enumerator.isFrontFacing(n) == front) return n
        }
        return names[0]      // 单摄设备：正/反面都要不到时，有什么用什么
    }

    /** 有没有第二颗摄像头（决定要不要露出「翻转」按钮）。 */
    fun hasMultipleCameras(): Boolean = Camera2Enumerator(context).deviceNames.size >= 2

    private fun stopCapture() {
        try { capturer?.stopCapture() } catch (_: Throwable) { }
        try { capturer?.dispose() } catch (_: Throwable) { }
        capturer = null
        try { videoTrack?.dispose() } catch (_: Throwable) { }
        videoTrack = null
        try { videoSource?.dispose() } catch (_: Throwable) { }
        videoSource = null
    }

    /**
     * 前后摄像头切换。
     *
     * 顺序是「先建新的、成了再放旧的」：手机不能同时开两颗，但**也不能先关旧的**
     * —— 那样一旦新摄像头拿不到，用户就被丢在黑屏上。失败就退回原朝向。
     */
    fun flipCamera(): Boolean {
        if (videoTrack == null) return false
        val target = !capturerFacingFront
        val oldCap = capturer
        val oldSrc = videoSource
        val oldTrack = videoTrack

        val created = try {
            createCaptureFresh(target)
        } catch (t: Throwable) {
            Log.w(TAG, "切换摄像头失败（保留原画面）", t)
            null
        }
        if (created == null) return false

        val (newSrc, newTrack) = created
        // 换轨道：sender 换到新轨（对端不断流），渲染器随后也改接新轨
        try {
            pc?.senders?.firstOrNull { it.track()?.kind() == "video" }?.setTrack(newTrack, true)
        } catch (t: Throwable) {
            Log.w(TAG, "替换视频轨失败", t)
        }

        videoSource = newSrc
        videoTrack = newTrack
        capturerFacingFront = target
        // 一次性把渲染器从旧轨摘下来、接到新轨（顺带按新朝向重设镜像）
        applyStage()

        try { oldCap?.stopCapture() } catch (_: Throwable) { }
        try { oldCap?.dispose() } catch (_: Throwable) { }
        try { oldTrack?.dispose() } catch (_: Throwable) { }
        try { oldSrc?.dispose() } catch (_: Throwable) { }
        return true
    }

    /** 与 [createCapture] 同逻辑，但不去动实例字段（切换时新旧要并存一会儿）。 */
    private fun createCaptureFresh(front: Boolean): Pair<VideoSource, VideoTrack>? {
        val f = factory ?: return null
        val helper = textureHelper ?: return null
        val enumerator = Camera2Enumerator(context)
        val name = pickDevice(enumerator, front) ?: return null
        val cap = enumerator.createCapturer(name, null) ?: return null
        val src = f.createVideoSource(false)
        cap.initialize(helper, context, src.capturerObserver)
        cap.startCapture(CAPTURE_W, CAPTURE_H, CAPTURE_FPS)
        src.adaptOutputFormat(CAPTURE_W, CAPTURE_H, CAPTURE_FPS)
        val track = f.createVideoTrack("rt-video0", src)
        return src to track
    }

    fun setMicEnabled(on: Boolean) { audioTrack?.setEnabled(on) }
    fun setCamEnabled(on: Boolean) { videoTrack?.setEnabled(on) }

    /* ============================== 渲染 ============================== */

    /**
     * 挂上两块画布：`big` 是铺满整屏的那块，`small` 是角落小窗那块。
     *
     * 大小窗的切换**不移动视图、只换轨道**：把「我」接到大画布上就是「我铺满」，
     * 不需要改 layoutParams。这样点画面互换是零布局开销的，也不会因为来回改
     * 尺寸把 SurfaceView 重建掉（那会黑一下）。
     */
    fun attachRenderers(big: SurfaceViewRenderer, small: SurfaceViewRenderer) {
        rendererBig = big
        rendererSmall = small
        applyStage()
    }

    /** 我是否铺满（默认 false = 对方铺满，与网页端一致）。 */
    fun setStageLocalMain(localMain: Boolean) {
        stageLocalMain = localMain
        applyStage()
    }

    private fun applyStage() {
        val big = rendererBig ?: return
        val small = rendererSmall ?: return
        val local = videoTrack
        // 未接通时 remote 一律按 null 处理 → 画布上只剩自己（隐私兜底）
        val remote = if (remoteRenderAllowed) remoteVideoTrack else null

        try { local?.removeSink(big); local?.removeSink(small) } catch (_: Throwable) { }
        try { remote?.removeSink(big); remote?.removeSink(small) } catch (_: Throwable) { }

        if (stageLocalMain) {
            local?.addSink(big)
            remote?.addSink(small)
        } else {
            remote?.addSink(big)
            local?.addSink(small)
        }
        // 只有「自己的前置画面」才镜像；后置、以及对方的画面都不镜像
        val front = capturerFacingFront
        try { big.setMirror(stageLocalMain && front) } catch (_: Throwable) { }
        try { small.setMirror(!stageLocalMain && front) } catch (_: Throwable) { }
    }

    /**
     * 对端视频轨。**每次现问 PeerConnection，不缓存** —— 这样无论 SDK 实际走的是
     * `onTrack` / `onAddTrack` / `onAddStream` 哪一条回调（各版本不一样），
     * 都不会出现「回调没来 → 画面永远黑着」。
     */
    private val remoteVideoTrack: VideoTrack?
        get() = try {
            pc?.receivers?.firstNotNullOfOrNull { it.track() as? VideoTrack }
        } catch (_: Throwable) {
            null
        }

    /**
     * 是否允许把**对端画面**接上屏。
     *
     * 未接通前必须为 false：万一对方是旧版本、仍在「还没人接听」时就推流，
     * 这边也不会把画面显示出来（网页端那个隐私 bug 的接收端兜底）。
     * 本地自己的预览不受这个开关影响 —— 那是用户自己的脸，本来就要看得见。
     */
    private var remoteRenderAllowed = false

    /* ============================ DataChannel ============================ */

    fun sendDc(text: String): Boolean {
        val c = dc ?: return false
        return try {
            c.send(DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false))
        } catch (t: Throwable) {
            Log.w(TAG, "数据通道发送失败", t)
            false
        }
    }

    /**
     * 发一个二进制分片。`binary = true` 这个标志必须给对 —— 给成 false，对端会按
     * UTF-8 去解，收到一堆乱码，而且**不会报任何错**。
     *
     * ⚠ 与 [sendDc] 一样，调用方必须在主线程。分片正文不经 native 复用，
     *   但保持「发送全在主线程」这条约定能让背压判定（[dcBufferedAmount]）
     *   和发送顺序都不必再去考虑竞态。
     */
    fun sendDcBinary(bytes: ByteArray): Boolean {
        val c = dc ?: return false
        return try {
            c.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), true))
        } catch (t: Throwable) {
            Log.w(TAG, "二进制发送失败（${bytes.size}B）", t)
            false
        }
    }

    /**
     * 数据通道里还没发出去的字节数 —— 传输时的背压依据。
     *
     * 为什么必须有：`send()` 不会阻塞，也不会有上限保护，一口气灌几十 MB
     * 会把缓冲顶爆并抛错。发送方盯住这个值（超过高水位就等一等），
     * 才能把大文件平稳推过去。
     */
    fun dcBufferedAmount(): Long = try {
        dc?.bufferedAmount() ?: 0L
    } catch (_: Throwable) {
        0L
    }

    private fun bindChannel(channel: DataChannel?) {
        val c = channel ?: return
        dc = c
        c.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(amount: Long) { }

            override fun onStateChange() {
                // 状态在当前线程读掉，通知才回主线程 —— 见类注释③。
                // 这个回调在 network 线程上，onDcOpen 会一路走到 cb.status()（改 TextView）。
                val open = c.state() == DataChannel.State.OPEN
                main.post { if (open) onDcOpen?.invoke() else onDcClosed?.invoke() }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                // ⚠ buffer 里的 ByteBuffer 由 native 复用：**必须在本线程就复制走**。
                //   等回到主线程再读，读到的已经是后面某一条消息的内容了。
                val data = buffer.data
                val bytes = ByteArray(data.remaining())
                data.get(bytes)
                val binary = buffer.binary
                main.post {
                    if (binary) onDcBinary?.invoke(bytes)
                    else onDcMessage?.invoke(String(bytes, Charsets.UTF_8))
                }
            }
        })
    }

    /* ============================ 协商（Perfect Negotiation） ============================ */

    /**
     * 收到对端的 SDP。做法与网页端 `applySignal()` 一一对应 —— 两端都要遵守
     * 同一套「谁让步」的约定，否则同时改媒体时会互相顶死。
     */
    suspend fun onRemoteDescription(type: String, sdp: String) {
        val p = pc ?: return
        val isOffer = type.equals("offer", ignoreCase = true)
        val readyForOffer = !makingOffer &&
            (p.signalingState() == PeerConnection.SignalingState.STABLE || settingAnswer)
        val offerCollision = isOffer && !readyForOffer

        ignoreOffer = !polite && offerCollision
        if (ignoreOffer) return

        settingAnswer = !isOffer
        val desc = SessionDescription(
            if (isOffer) SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER, sdp,
        )
        p.setRemoteDescriptionSuspend(desc)
        settingAnswer = false

        if (isOffer) {
            val answer = p.createAnswerSuspend(MediaConstraints())
            p.setLocalDescriptionSuspend(answer)
            answer.description?.let { onLocalSdp?.invoke("answer", it) }
        }
    }

    /**
     * 收到对端的 ICE 候选。
     *
     * 刻意**不用**挂起：`addIceCandidate` 拿不到「加成功没有」的可靠回执，
     * 硬包一层 suspend 只是假装的同步。候选加失败通常也无害（UDP 丢包，
     * 后续候选会补上），所以这里只记日志，不往上抛。
     */
    fun onRemoteCandidate(candidate: IceCandidate) {
        val p = pc ?: return
        try {
            p.addIceCandidate(candidate)
        } catch (t: Throwable) {
            // 被忽略的 offer 对应的候选失败是预期的，不当错误刷屏
            if (!ignoreOffer) Log.w(TAG, "添加 ICE 候选失败", t)
        }
    }

    private suspend fun negotiate() {
        val p = pc ?: return
        if (makingOffer) return
        makingOffer = true
        try {
            val offer = p.createOfferSuspend(MediaConstraints())
            p.setLocalDescriptionSuspend(offer)
            offer.description?.let { onLocalSdp?.invoke("offer", it) }
        } catch (t: Throwable) {
            Log.w(TAG, "发起协商失败", t)
        } finally {
            makingOffer = false
        }
    }

    /* ============================== 观察者 ============================== */

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) { }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) { }

        override fun onIceConnectionReceivingChange(receiving: Boolean) { }

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) { }

        override fun onIceCandidate(candidate: IceCandidate?) {
            // IceCandidate 是普通 Java 对象，跨线程持有没问题（不是 native 复用的 buffer）
            candidate?.let { c -> main.post { onLocalIce?.invoke(c) } }
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) { }

        override fun onAddStream(stream: MediaStream?) { }

        override fun onRemoveStream(stream: MediaStream?) { }

        override fun onDataChannel(channel: DataChannel?) {
            // 对端（主叫方）建的通道：这里必须接住，否则聊天永远不通。
            // bindChannel 会写 [dc] 字段并注册观察者，统一放主线程做，免得和
            // 主线程读 isChannelOpen 撞在一起。
            if (channel == null) return
            main.post { bindChannel(channel) }
        }

        override fun onRenegotiationNeeded() {
            // 加轨道、改码率都会走到这里 —— 用协程串起来，避免并发协商。
            // scope 挂在 Dispatchers.Main 上，launch 本身就完成了跨线程切换。
            scope.launch { negotiate() }
        }

        /** 对端加了轨道（新版 SDK 走这条）。这里不缓存轨道，只叫上层来取一次。 */
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
            // ⚠ track() 必须在回调线程读（native 侧随时可能变）；读到的结论再回主线程通知
            val isVideo = receiver?.track() is VideoTrack
            if (isVideo) main.post { onRemoteTrack?.invoke() }
        }

        /**
         * 旧回调。两个坑：
         *
         * ① 参数是**单个** [RtpTransceiver]，不是数组 —— 写成数组会报
         *    「onTrack overrides nothing」。
         * ② 刻意**不去读** transceiver 里的 receiver：`RtpTransceiver.getReceiver()`
         *    在 Kotlin 里是合成属性，写 `receiver()` 会编译不过。而上层本来就是
         *    从 `PeerConnection.receivers` 现问轨道（见 [remoteVideoTrack]），
         *    所以这里只需要「叫一声」，不需要传任何东西。
         */
        override fun onTrack(transceiver: RtpTransceiver?) {
            if (transceiver != null) main.post { onRemoteTrack?.invoke() }
        }

        /**
         * ⚠⚠ **这就是「点语音通话必闪退」的那个崩点。**
         *
         * 本回调在 signaling 线程上派发（线程名 `signaling_threa` —— 15 字符被截断，
         * 与启动时的 `onSignalingThreadReady` 是同一个 tid）。它往上走：
         *
         *     onConnectionChange → RoomSession.onConnState → cb.status()
         *       → MainActivity.status() → TextView.setText()
         *       → ViewRootImpl.checkThread() → CalledFromWrongThreadException
         *       → 穿出 JNI → WebRTC jvm.cc 的 CHECK(false) → abort() → SIGABRT
         *
         * 实测崩溃现场（华为 nova 5 Pro / Android 10 / v1.0.1）：
         *
         *     11:23:37.520 18776 18928 I RoomTalk.Session: 连接状态: CONNECTED
         *     11:23:37.549 18776 18928 W System.err: CalledFromWrongThreadException
         *     11:23:37.550 18776 18928 E rtc: Fatal error in ... jvm.cc, line 81
         *     11:23:37.551 18776 18928 F libc: Fatal signal 6 (SIGABRT)
         *
         * 之所以「进房间不崩、一发起通话才崩」：PeerConnection 是通话时才建的，
         * 状态回调自然也只有那时才开始来。
         */
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            newState?.let { s -> main.post { onConnectionChange?.invoke(s) } }
        }

        override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent?) { }
    }

    private val scope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate,
    )

    private companion object {
        const val TAG = "RoomTalk.RTC"
        const val STREAM_ID = "rt"
        const val CAPTURE_W = 1280
        const val CAPTURE_H = 720
        const val CAPTURE_FPS = 30

        /** 与网页端「流畅」档一致（600 kbps） */
        const val DEFAULT_MAX_BITRATE = 600_000
    }
}

/* ============================ 回调 → 挂起 ============================ */

private suspend fun PeerConnection.createOfferSuspend(c: MediaConstraints): SessionDescription =
    suspendCancellableCoroutine { cont ->
        createOffer(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription) { cont.resume(desc) }
            override fun onCreateFailure(err: String) { cont.resumeWithException(RuntimeException(err)) }
            override fun onSetSuccess() { }
            override fun onSetFailure(err: String) { }
        }, c)
    }

private suspend fun PeerConnection.createAnswerSuspend(c: MediaConstraints): SessionDescription =
    suspendCancellableCoroutine { cont ->
        createAnswer(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription) { cont.resume(desc) }
            override fun onCreateFailure(err: String) { cont.resumeWithException(RuntimeException(err)) }
            override fun onSetSuccess() { }
            override fun onSetFailure(err: String) { }
        }, c)
    }

private suspend fun PeerConnection.setLocalDescriptionSuspend(desc: SessionDescription): Unit =
    suspendCancellableCoroutine { cont ->
        setLocalDescription(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription?) { }
            override fun onCreateFailure(err: String) { }
            override fun onSetSuccess() { cont.resume(Unit) }
            override fun onSetFailure(err: String) { cont.resumeWithException(RuntimeException(err)) }
        }, desc)
    }

private suspend fun PeerConnection.setRemoteDescriptionSuspend(desc: SessionDescription): Unit =
    suspendCancellableCoroutine { cont ->
        setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription?) { }
            override fun onCreateFailure(err: String) { }
            override fun onSetSuccess() { cont.resume(Unit) }
            override fun onSetFailure(err: String) { cont.resumeWithException(RuntimeException(err)) }
        }, desc)
    }
