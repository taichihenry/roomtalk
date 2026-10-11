package com.roomtalk.android.net

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.roomtalk.android.core.Dc
import com.roomtalk.android.core.RoomId
import com.roomtalk.android.core.SIGNAL_URL
import com.roomtalk.android.core.Trust
import com.roomtalk.android.core.Wire
import com.roomtalk.android.core.fmtBytes
import com.roomtalk.android.core.safeFileName
import com.roomtalk.android.core.uniqueFileIn
import com.roomtalk.android.rtc.PeerEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.SurfaceViewRenderer
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 会话总控：把「信令 + WebRTC + 通话状态机」串起来。
 * 对应网页端 `public/app.js` 的核心部分，几个关键约定必须保持一致。
 *
 * 三条铁律（都是从线上事故里换来的，改动前先读 README 第六节）：
 *
 * ① 通话态只认 [callKind]（null | "audio" | "video"）。**绝不**从「有没有轨道」
 *    反推 —— 视频通话里关摄像头，轨道还在，用轨道判断会在那一刻集体错乱。
 *    [stopLocalMedia] 是通话态的**唯一复位点**：挂断 / 退房 / 被请出 / 对方离开
 *    都必须走它，否则摄像头指示灯会一直亮着。
 *
 * ② 呼叫期间**不推流、不广播媒体状态**。`ensureMic/ensureCam` 只采集；
 *    只有对方接听（[answerIncoming] 或收到 ring-answer）才 `publishLocal()`。
 *    这是「未接听就泄露音视频」那个隐私 bug 的修复点。
 *
 * ③ 对方掉线时给宽限期，**通话中给 20 秒**（对齐产品承诺的重连窗口），
 *    聊天态只给 1.5 秒。线上重连要走「退避 + WS 握手 + 重新注册」，1.5 秒必现误杀；
 *    而本地开发环境几十毫秒就重连完，这个 bug 在本地永远复现不出来。
 */
class RoomSession(private val context: Context) {

    interface Cb {
        fun status(text: String)
        fun message(text: String, mine: Boolean)

        /**
         * 一条语音消息。
         * @param path 本地那份音频（自己发的是录音文件，对方发的是落盘到缓存目录的）。点一下播放。
         * @param dur  录制时长（毫秒），用来画气泡上的「0:07」
         */
        fun voice(path: String, dur: Long, mine: Boolean)

        /**
         * 一条文件消息。
         * @param path 本地那份文件。点一下可以打开 / 另存为 —— 和网页端「点一下另存」对齐。
         * @param name 原始文件名（显示用）
         */
        fun file(path: String, name: String, size: Long, mine: Boolean)

        fun peerInfo(text: String)
        /** 通话态变化：null = 不在通话 */
        fun callState(kind: String?)
        /** 有人打进来，显示接听浮层 */
        fun ringing(kind: String, name: String)
        /** 撤掉浮层 */
        fun ringDismissed()
        /** 通话已接通（双方都进入通话界面后由界面挂渲染器） */
        fun callLive(kind: String, hasRemoteVideo: Boolean)
        /** 计时文本 mm:ss */
        fun timer(text: String)
        /** 我方是否铺满（false = 对方铺满），供界面切换大小窗 */
        fun stage(remoteMain: Boolean)
        /** 需要把本地/远端渲染器接进引擎 */
        fun attachRenderers()
        fun flipAvailable(available: Boolean)
        /** 我是不是房主（= 第一个进房的人）。只有房主能「请出房间」。 */
        fun host(isHost: Boolean)
        /**
         * 信任条。[kind] 取 "" / "first" / "ok" / "warn"；[text] 为空表示整条收起。
         * 判定逻辑与网页端 [onPeerIdentity] 完全一致。
         */
        fun trust(kind: String, text: String)
        fun toast(text: String)
        /** 退回入口页，并把原因显示出来（null = 正常退出） */
        fun backToGate(reason: String?)
    }

    var cb: Cb? = null

    private val main = Handler(Looper.getMainLooper())

    /** 信令里的 SDP 处理是挂起的（要等 setRemoteDescription/setLocalDescription 回调），
     *  统一放这个 scope 里串行执行，避免两条 SDP 同时进来时互相踩。 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val engine = PeerEngine(context)

    private var signaling: Signaling? = null

    private var room = ""
    private var selfId = ""
    private var remotePeerId: String? = null
    private var peerName = ""
    private var isHost = false

    /** 设备身份与信任记忆（TOFU）。见 [Trust] 顶部的说明。 */
    private val trust = Trust(context)

    /** 对方递过来的设备标识，用来判「是不是上次那台设备」。 */
    private var peerDeviceId = ""

    /** 通话态的唯一真相：null | "audio" | "video" */
    private var callKind: String? = null

    /** 我发起的呼叫还没被接听（此时**不许**推流、不许广播媒体状态） */
    private var callRinging = false

    /** 对方正在呼我，浮层还挂着 */
    private var incomingKind: String? = null

    private var callStartedAt = 0L
    private var timerTick: Runnable? = null
    private var callOutTimer: Runnable? = null
    private var peerLeftTimer: Runnable? = null

    /** 我铺满（true）还是对方铺满（false）。
     *  用自定义 setter 顺带同步给引擎 —— 否则界面以为换了、画布却没换。 */
    private var localMain = false
        set(value) {
            field = value
            engine.setStageLocalMain(value)
        }

    /**
     * 信令连接身份。**持久化**，不是每次启动随机生成 —— 服务端靠它认领
     * 「你自己的旧连接」，理由见 [com.roomtalk.android.core.Trust.clientId]。
     */
    private val clientId: String = trust.clientId()
    private var started = false

    /** 正在后台派生口令 / 建工厂。防止连点两次各起一套（会留下第二台 PeerConnection）。 */
    @Volatile
    private var entering = false

    /** 本次进房是否已经做过「这间房是不是空的」那次自查。见 T_ROOM_JOINED。 */
    private var hostWipeDone = false

    private val name: String =
        (Build.MANUFACTURER?.takeIf { it.isNotBlank() }?.let { m -> "$m ${Build.MODEL}" } ?: Build.MODEL)
            .take(24)

    /* ============================== 对外操作 ============================== */

    fun enter(passphrase: String) {
        if (entering) return
        entering = true
        cb?.status("正在进入…")

        /*
         * ⚠ 这里有两件重活，一件都不能留在主线程上：
         *   ① RoomId.derive —— PBKDF2 十万轮 HMAC-SHA256（和网页端算法逐位对齐，
         *      轮数不能降）。Android 的 HmacSHA256 走 Conscrypt，每轮都是一次 JNI，
         *      十万轮在低端机上能到几百毫秒甚至更久。
         *   ② engine.initFactory —— EglBase + 采集线程 + 音频设备模块 + PeerConnectionFactory。
         *
         * 两件叠在一起放在主线程，输入点击就会被拖住；低端机能直接踩到 ANR 门槛
         * （用户看到的就是「点一下进入就闪一下没了」）。所以派生挪后台，
         * 建工厂仍在主线程（WebRTC 的 GL/音频初始化留在主线程更稳），但整体兜在
         * try/catch 里 —— 失败要给得出话，而不是把一个闪退丢给用户。
         */
        Thread({
            val roomId = try {
                RoomId.derive(passphrase)
            } catch (t: Throwable) {
                Log.e(TAG, "口令派生失败", t)
                main.post {
                    entering = false
                    cb?.backToGate("口令处理失败：${brief(t)}")
                }
                return@Thread
            }

            main.post {
                // 后台算的这段时间里用户可能已经退出了
                if (!entering) return@post
                try {
                    room = roomId
                    started = true
                    remotePeerId = null
                    isHost = false
                    peerName = ""
                    // 新的一次进房，重置「已检查过房间是不是干净的」标记（见 T_ROOM_JOINED）
                    hostWipeDone = false

                    engine.initFactory()
                    engine.onLocalSdp = { type, sdp -> sendSignalDescription(type, sdp) }
                    engine.onLocalIce = { c -> sendSignalCandidate(c) }
                    engine.onDcMessage = { text -> onDcMessage(text) }
                    engine.onDcBinary = { bytes -> onDcBinary(bytes) }
                    engine.onDcOpen = { onChannelReady() }
                    engine.onRemoteTrack = { onRemoteTrack() }
                    engine.onConnectionChange = { st -> onConnState(st) }

                    signaling = Signaling(
                        url = SIGNAL_URL,
                        onOpen = { onSignalOpen() },
                        onMessage = { m -> onServerMessage(m) },
                        onLost = { cb?.status("连接中断，正在重试…") },
                    ).also { it.start() }
                } catch (t: Throwable) {
                    // 这里接住的都是 Java/Kotlin 层的失败（UnsatisfiedLinkError、
                    // SecurityException、IllegalStateException…）。native 崩溃接不住，
                    // 那类只能靠 CrashLog 留下的记录。
                    Log.e(TAG, "进入房间失败", t)
                    teardown()
                    cb?.backToGate("进入房间失败：${brief(t)}")
                } finally {
                    entering = false
                }
            }
        }, "rt-enter").start()
    }

    /** 把异常压成一行人话，够用户转述、也够我们定位类型。 */
    private fun brief(t: Throwable): String {
        val msg = t.message?.take(120)?.replace('\n', ' ')
        val head = t.javaClass.simpleName
        return if (msg.isNullOrBlank()) head else "$head: $msg"
    }

    /** 退出房间（顶栏 ✕）。通话中会先挂断，免得对方对着空房间干等。 */
    fun leave() {
        if (callKind != null || callRinging) endCall(silent = false)
        if (remotePeerId != null) signaling?.send(Wire.leave(room))
        teardown()
        // 房间的记忆不跟着我走：同一口令的房间用完了就该是干净的（见 [Trust.wipeRoom]）
        trust.wipeRoom(room)
        cb?.backToGate(null)
    }

    /** 界面销毁时收摊。 */
    fun destroy() {
        teardown()
        scope.cancel()
        engine.releaseEverything()
    }

    val inRoom: Boolean get() = started
    val inCallNow: Boolean get() = callKind != null

    /* ------------------------- 麦克风 / 摄像头开关 -------------------------
     *
     * ⚠ 这两个开关是**自己记账**的，不去读 `engine.hasMicEnabled()` 反推。
     *
     * 为什么：那个 getter 读的是 native 侧轨道的 enabled 位。轨道还没建出来
     * （进了房但没通话）、或者建失败时，它恒为 false —— 于是 `!false` 每次都被
     * 算成「开」，按钮点上去永远不变色：用户以为自己静音了，其实麦克风还开着。
     * 真机上表现为「点麦克风没反应、点扬声器却正常」，就是这么来的。
     *
     * 自己记账还顺手保证了另一件事：**对端收到的媒体状态和本地按钮永远一致**，
     * 不会出现一边显示红、一边显示绿的错位。
     */

    /** 麦克风意图状态。界面画按钮、广播给对端，用的都是它。 */
    private var micWanted = true

    /** 摄像头意图状态。 */
    private var camWanted = false

    /** 麦克风当前是否开着（界面画按钮状态用）。 */
    val micOn: Boolean get() = micWanted

    /** 摄像头当前是否开着。 */
    val camOn: Boolean get() = camWanted

    /**
     * 界面层建 SurfaceViewRenderer 时要用（必须与采集/解码共用同一个 EglBase）。
     * [enter] 之后才非空。
     */
    val eglContext: EglBase.Context? get() = engine.eglContext

    /**
     * 界面层把两块画布交进来：`big` = 铺满整屏那块，`small` = 角落小窗那块。
     * 大小窗互换**不动布局、只换轨道**（见 [PeerEngine.attachRenderers]）。
     */
    fun attachRenderers(big: SurfaceViewRenderer, small: SurfaceViewRenderer) {
        engine.attachRenderers(big, small)
        engine.setStageLocalMain(localMain)
    }

    /** 界面销毁时把画布收回去（SurfaceView 必须先 release，否则会漏 EGL 上下文）。 */
    fun detachRenderers() {
        engine.releaseRenderers()
    }

    /* ============================== 发起通话 ============================== */

    fun startCall(kind: String) {
        if (callKind != null) { cb?.toast("正在通话中，请先挂断"); return }
        if (incomingKind != null) { cb?.toast("对方正在来电，请先接听或拒绝"); return }
        if (!dcReady()) { cb?.toast("还没和对方接通"); return }

        // 呼叫期间只采集、不发送 —— 见类注释②
        if (!engine.ensureMic(publish = false)) { cb?.toast("无法使用麦克风，请检查权限"); return }
        micWanted = true
        if (kind == "video" && !engine.ensureCam(publish = false)) {
            engine.setMicEnabled(false)
            micWanted = false
            engine.closeAll()
            cb?.toast("无法使用摄像头，请检查设备与权限")
            return
        }
        camWanted = kind == "video"

        callKind = kind
        callRinging = true
        localMain = false
        engine.setSpeaker(speakerPreferred)
        engine.sendDc(Dc.ring(kind, name))
        cb?.callState(kind)
        cb?.status(if (kind == "video") "正在呼叫（视频）…" else "正在呼叫（语音）…")
        cb?.attachRenderers()
        cb?.flipAvailable(kind == "video" && engine.hasMultipleCameras())

        // 30 秒无人接听就自动收摊：不设上限的话，麦克风会一直开着
        val out = Runnable {
            if (callRinging) {
                endCall(silent = false)
                cb?.toast("对方没有接听")
            }
        }
        callOutTimer = out
        main.postDelayed(out, 30_000)
        pushMediaState()   // 呼叫中：内部会直接 return，不广播
    }

    /* ============================== 来电 ============================== */

    fun answerIncoming() {
        val kind = incomingKind ?: return
        incomingKind = null
        cb?.ringDismissed()

        // 接听这个动作**就是**用户的手势与同意 —— 到这里才真正开始采集并发送
        if (!engine.ensureMic(publish = true)) {
            engine.sendDc(Dc.ringAnswer(kind, false))
            cb?.toast("麦克风没打开，已拒绝这通电话")
            return
        }
        micWanted = true
        if (kind == "video" && !engine.ensureCam(publish = true)) {
            cb?.toast("摄像头没打开，已按语音接通")
        }
        camWanted = kind == "video" && engine.hasCam
        callKind = if (kind == "video" && engine.hasCam) "video" else "audio"
        callRinging = false
        localMain = false
        engine.setSpeaker(speakerPreferred)
        engine.sendDc(Dc.ringAnswer(kind, true))
        beginCallTiming()
        engine.bindRemoteIfLive(true)
        val liveKind = callKind ?: "audio"
        cb?.callState(liveKind)
        cb?.attachRenderers()
        cb?.callLive(liveKind, engine.hasCam)
        cb?.flipAvailable(liveKind == "video" && engine.hasMultipleCameras())
        cb?.toast("已接通")
        pushMediaState()
    }

    fun rejectIncoming() {
        val kind = incomingKind ?: return
        incomingKind = null
        cb?.ringDismissed()
        engine.sendDc(Dc.ringAnswer(kind, false))
        engine.closeAll()
        cb?.status("等待对方接入")
    }

    /* ============================== 挂断 ============================== */

    fun endCall(silent: Boolean) {
        val wasInCall = callKind != null || callRinging
        if (!silent) engine.sendDc(Dc.bye())
        stopLocalMedia()
        if (wasInCall) cb?.toast(if (silent) "通话已结束" else "已挂断")
    }

    /** 通话态的唯一复位点。 */
    private fun stopLocalMedia() {
        callKind = null
        callRinging = false
        incomingKind = null
        cancelCallOutTimer()
        stopTimer()
        localMain = false
        engine.closeAll()
        engine.setMicEnabled(false)
        // 下一通电话从「麦克风开、摄像头关」这个默认档重新开始
        micWanted = true
        camWanted = false
        cb?.callState(null)
        cb?.ringDismissed()
        cb?.status(if (remotePeerId != null) "已连接" else "等待对方接入")
        cb?.flipAvailable(false)
        pushMediaState()
    }

    fun toggleMic(): Boolean {
        if (callKind == null) { cb?.toast("先发起或接听一个通话"); return micWanted }
        micWanted = !micWanted
        engine.setMicEnabled(micWanted)
        Log.i(TAG, "麦克风 → ${if (micWanted) "开" else "关（静音）"}")
        pushMediaState()
        return micWanted
    }

    fun toggleCam(): Boolean {
        if (callKind != "video") { cb?.toast("当前不是视频通话"); return camWanted }
        camWanted = !camWanted
        engine.setCamEnabled(camWanted)
        Log.i(TAG, "摄像头 → ${if (camWanted) "开" else "关"}")
        pushMediaState()
        return camWanted
    }

    fun flipCamera() {
        if (callKind != "video") return
        if (!engine.flipCamera()) cb?.toast("切换摄像头失败（设备可能不支持）")
    }

    /** 免提偏好，跨通话记住。进通话时按它把设备调到用户上次选的档。 */
    private var speakerPreferred = true

    /** 免提开关。返回切换后的状态。 */
    fun toggleSpeaker(): Boolean {
        speakerPreferred = !speakerPreferred
        engine.setSpeaker(speakerPreferred)
        return speakerPreferred
    }

    /** 当前的免提状态（界面初次进通话时用来摆好按钮）。 */
    val speakerOn: Boolean get() = engine.speakerOn

    /**
     * 请出房间。
     *
     * 权限判据是「我是不是房主」，但**真正的判据在服务端**（那里也是同样一条
     * 产品约定：房主 = 第一个进房的人，谁先退出谁让位）。这里先看一眼只是为了
     * 少发一条注定被拒的消息，别让用户白点一下。
     */
    fun kickPeer(note: String? = null) {
        if (!isHost) {
            cb?.toast("只有先进入房间的一方能请人出去")
            return
        }
        val target = remotePeerId
        if (target == null) {
            cb?.toast("房间里还没有别人")
            return
        }
        val dev = peerDeviceId
        signaling?.send(Wire.kick(room, target))
        // ⚠ 只有开着「自动请出」才记进黑名单：关掉它的语义就是「我想自己看着办、
        //   可能还要把人放回来」，这时候往名单里塞人等于自相矛盾。
        if (dev.isNotBlank() && trust.autoKick) trust.addBlocked(room, dev)

        finishPeerGone(note ?: "已把对方请出房间")
        cb?.trust("", "")
    }

    /** 点画面：把大小窗对调。 */
    fun swapStage() {
        localMain = !localMain
        cb?.stage(remoteMain = !localMain)
    }

    fun sendMessage(text: String): Boolean {
        if (text.isBlank()) return false
        if (!dcReady()) { cb?.toast("还没和对方接通"); return false }
        val ok = engine.sendDc(Dc.msg(text))
        if (ok) cb?.message(text, true) else cb?.toast("没发出去")
        return ok
    }

    /* ============================== 信令 ============================== */

    private fun onSignalOpen() {
        signaling?.send(Wire.join(room, clientId, name))
        cb?.status("正在进入房间…")
    }

    private fun onServerMessage(m: JSONObject) {
        when (m.optString("type")) {
            Wire.T_SELF -> {
                selfId = m.optString("peerId")
                val ice = Wire.parseIceServers(m.optJSONArray("iceServers"))
                iceServers = ice
            }

            Wire.T_ROOM_JOINED -> {
                isHost = m.optBoolean("host", false)
                // host=true 意味着这间房是**我这次进来才建起来的** —— 也就是我进来之前
                // 它是空的，说明上一拨人早就散了。按「房间腾空即清空」的规矩，这间房
                // 在本机不该还留着记忆，顺手抹掉。
                //
                // 为什么非要有这道自愈：靠「离开房间」触发的那次清理，在**关掉标签页 /
                // 杀掉应用 / 崩溃 / 断网变僵尸**这些最常见的离场方式下根本不会执行 ——
                // 那些记忆会一直留着，直到某天一台毫不相干的设备撞上旧黑名单被自动
                // 请出去。只在每次进房的第一条 room-joined 上做，避免重连时误清。
                if (isHost && !hostWipeDone) {
                    hostWipeDone = true
                    trust.wipeRoom(room)
                }
                cb?.host(isHost)
                cb?.status("等待对方接入")
            }

            Wire.T_HOST -> {
                isHost = m.optBoolean("host", false)
                cb?.host(isHost)
            }

            Wire.T_ROOM_ERROR -> {
                teardown()
                cb?.backToGate(m.optString("reason").ifBlank { "无法进入这个房间" })
            }

            Wire.T_PEERS -> {
                val arr = m.optJSONArray("peers") ?: return
                if (arr.length() == 0) return
                val p = arr.optJSONObject(0) ?: return
                peerName = p.optString("name")
                cb?.peerInfo(peerText())
                // 房里已经有人 → 他是主叫方，我被动应答（polite）
                preparePeer(p.optString("id"), amCaller = false)
            }

            Wire.T_PEER_JOINED -> {
                val p = m.optJSONObject("peer") ?: return
                if (peerLeftTimer != null && callKind != null) {
                    cb?.toast("对方已重新接入，通话继续")
                }
                cancelPeerLeftTimer()
                peerName = p.optString("name")
                cb?.peerInfo(peerText())
                preparePeer(p.optString("id"), amCaller = true)
            }

            Wire.T_PEER_LEFT -> {
                if (m.optString("peerId") != remotePeerId) return
                // 「主动退房」= 不会再回来了，不给宽限期；「断线」= 可能马上重连回来
                val leftOnPurpose = m.optString("reason") == Wire.REASON_LEAVE
                handlePeerLeft(leftOnPurpose)
            }

            Wire.T_KICKED -> {
                teardown()
                // 被请出去 = 这一次会面到此为止，房间的记忆一并不留（见 [Trust.wipeRoom]）
                trust.wipeRoom(room)
                cb?.backToGate("对方把你请出了这个房间")
            }

            Wire.T_SIG -> {
                val payload = m.optJSONObject("payload") ?: return
                applyRemoteSignal(m.optString("senderId"), payload)
            }

            Wire.T_PEER_RENAMED -> {
                if (m.optString("peerId") == remotePeerId) {
                    peerName = m.optString("name")
                    cb?.peerInfo(peerText())
                }
            }
        }
    }

    private var iceServers: List<String> = DEFAULT_ICE

    private fun preparePeer(peerId: String, amCaller: Boolean) {
        if (peerId.isBlank()) return
        if (remotePeerId == peerId && engine.hasPeer) return
        remotePeerId = peerId
        engine.createPeer(iceServers, isPolite = !amCaller, amCaller = amCaller)
        cb?.status("已找到对方，正在建立连接…")
        // 渲染器可能在通话开始后才就绪，这里先要求界面把已挂载的接一遍
        cb?.attachRenderers()
    }

    private fun sendSignalDescription(type: String, sdp: String) {
        val to = remotePeerId ?: return
        signaling?.send(Wire.signalDescription(room, to, type, sdp))
    }

    private fun sendSignalCandidate(c: IceCandidate) {
        val to = remotePeerId ?: return
        signaling?.send(
            Wire.signalCandidate(room, to, c.sdp, c.sdpMid, c.sdpMLineIndex),
        )
    }

    private fun applyRemoteSignal(senderId: String, payload: JSONObject) {
        if (senderId != remotePeerId) return
        val desc = payload.optJSONObject("description")
        if (desc != null) {
            val type = desc.optString("type")
            val sdp = desc.optString("sdp")
            scope.launch {
                try {
                    engine.onRemoteDescription(type, sdp)
                } catch (t: Throwable) {
                    Log.w(TAG, "处理远端 SDP 失败", t)
                }
            }
            return
        }
        val cand = payload.optJSONObject("candidate")
        if (cand != null) {
            val c = IceCandidate(
                cand.optString("sdpMid").takeIf { it.isNotBlank() },
                if (cand.has("sdpMLineIndex")) cand.optInt("sdpMLineIndex") else 0,
                cand.optString("candidate"),
            )
            engine.onRemoteCandidate(c)
        }
    }

    private fun handlePeerLeft(leftOnPurpose: Boolean) {
        cancelPeerLeftTimer()
        val grace = if (leftOnPurpose) 0L else if (callKind != null) GRACE_IN_CALL_MS else GRACE_CHAT_MS
        if (grace == 0L) {
            finishPeerGone()
            return
        }
        if (callKind != null) cb?.toast("对方连接中断，正在等待重连…")
        val r = Runnable { finishPeerGone() }
        peerLeftTimer = r
        main.postDelayed(r, grace)
    }

    private fun finishPeerGone(toast: String = "对方已离开") {
        peerLeftTimer = null
        dropRx()
        cancelCallOutTimer()
        engine.disposePeer()
        engine.closeAll()
        remotePeerId = null
        peerName = ""
        peerDeviceId = ""
        callKind = null
        callRinging = false
        incomingKind = null
        stopTimer()
        cb?.callState(null)
        cb?.ringDismissed()
        cb?.peerInfo("")
        cb?.trust("", "")
        cb?.status("等待对方接入")
        cb?.toast(toast)
    }

    /* ============================== 数据通道 ============================== */

    private fun dcReady(): Boolean = remotePeerId != null && engine.isChannelOpen

    private fun onChannelReady() {
        // 递名片：让对端认出（或认不出）本机。
        // ⚠ 必须用**持久化**的 id（见 Trust.deviceId）。如果每次随机，对方就算点过
        //   「记住这台设备」，下次也会看到「对方换了一台设备」的误报 —— 狼来了几次
        //   之后，真正该警惕的那次也没人信了。
        engine.sendDc(Dc.identity(trust.deviceId()))
        if (engine.hasMic || engine.hasCam) pushMediaState()
        cb?.status("已连接")
    }

    private fun onDcMessage(text: String) {
        val m = try { JSONObject(text) } catch (e: Exception) { return }
        when (m.optString("t")) {
            Dc.T_MSG -> cb?.message(m.optString("text"), false)

            Dc.T_MEDIA -> {
                // 对方开/关麦与镜头：用于界面上那个「对方未开麦」角标
                m.optJSONObject("media")?.let { mm ->
                    remoteAudio = mm.optBoolean("audio")
                    remoteVideo = mm.optBoolean("video")
                }
                cb?.peerInfo(peerText())
            }

            Dc.T_RING -> {
                if (callKind != null) {
                    // 正在通话，没空接第二个 —— 直接回绝并说明
                    engine.sendDc(Dc.ringAnswer(m.optString("kind"), false))
                    return
                }
                incomingKind = m.optString("kind").ifBlank { "audio" }
                cb?.ringing(incomingKind!!, m.optString("name"))
            }

            Dc.T_RING_ANSWER -> onRingAnswer(m)

            Dc.T_ID -> onPeerIdentity(m.optString("id"))

            Dc.T_XFER -> onXferCtl(m)

            Dc.T_BYE -> when {
                // 已经在通话 / 我们正在呼叫 → 正常收摊
                callKind != null || callRinging -> endCall(silent = true)
                // 呼叫方在我们接听前自己撤了（例如 30 秒无人接听的自动挂断）
                incomingKind != null -> {
                    incomingKind = null
                    cb?.ringDismissed()
                    cb?.status("对方取消了通话")
                }
            }
        }
    }

    private fun onRingAnswer(m: JSONObject) {
        if (!callRinging) return
        if (!m.optBoolean("accept", false)) {
            endCall(silent = true)
            cb?.toast("对方拒绝了通话请求")
            return
        }
        // 对方接听的那一刻，才是我们「开始发送」的时刻
        callRinging = false
        cancelCallOutTimer()
        engine.publishLocal()
        engine.bindRemoteIfLive(true)
        beginCallTiming()
        cb?.callLive(callKind ?: "audio", engine.hasCam)
        cb?.toast("已接通")
        pushMediaState()
    }

    private fun onRemoteTrack() {
        // 未接通时绝不上屏（接收端兜底）：这样即使对方是旧版本，也看不到你的画面
        engine.bindRemoteIfLive(callKind != null && !callRinging)
        if (callKind == "video") cb?.callLive("video", true)
    }

    private fun onConnState(st: PeerConnection.PeerConnectionState) {
        Log.i(TAG, "连接状态: $st")
        if (st == PeerConnection.PeerConnectionState.CONNECTED) {
            cb?.status(if (callKind != null) "通话中" else "已连接")
        }
    }

    /** 媒体状态广播。⚠ 呼叫中必须闭嘴：对方还没接听就收到，会把发起方错摆成大窗。 */
    fun pushMediaState() {
        if (callRinging) return
        if (!engine.isChannelOpen) return
        engine.sendDc(Dc.media(micWanted, camWanted, "smooth"))
    }

    private var remoteAudio = false
    private var remoteVideo = false

    /* ======================= 文件 / 语音传输（与网页端同协议） =======================
     *
     * 三段式：begin（控制消息） → 若干裸二进制分片 → end（控制消息）。
     * 与网页端 `sendXfer` / `onXferCtl` 是同一套线协议，两端可以互发。
     *
     * 三个设计取舍，都是踩过或推演过才定下的：
     *
     * ① **分片直接写盘，不在内存里攒。** 网页端把分片攒进数组再拼 Blob，是因为
     *    浏览器里没有「随收随写」这种 API；安卓这边没必要跟着学 —— 100MB 的
     *    分片列表在手机上足够触发 OOM，而边收边写盘的峰值内存只有一个分片。
     *
     * ② **接收在主线程做（含 64KB 的 write）。** 看着有点重，但它换来的是
     *    「文本和二进制走同一条队列」，顺序天然正确（详见 PeerEngine.onDcBinary 的
     *    说明）。单次 write 是几十微秒级的，100MB 摊到 1600 次也感知不到；
     *    反过来如果为了这点开销另起一条线程，就要额外处理 begin 与分片的竞态。
     *
     * ③ **发送在后台线程，但每一次 `send` 都甩回主线程执行。** 读取文件（可能几十 MB）
     *    不能压在主线程上；而 `DataChannel.send` 与旧代码的约定是「只在主线程调」。
     *    两者兼顾的办法就是 [sendOnMain]：后台线程算好分片，主线程负责发。
     */

    /** 正在收的那一笔。null = 当前没有传输。 */
    private var rx: Rx? = null

    private class Rx(
        val id: String,
        val kind: String,
        /** 显示名（原文件名；语音没有名字） */
        val name: String,
        val size: Long,
        val dur: Long,
        val file: File,
        val out: OutputStream,
    ) {
        var got: Long = 0

        fun close() {
            try { out.close() } catch (_: Throwable) { /* 已经关了 */ }
        }
    }

    /** 收到传输控制消息。 */
    private fun onXferCtl(m: JSONObject) {
        when (m.optString("phase")) {
            Dc.PHASE_BEGIN -> beginRx(m)
            Dc.PHASE_END -> finishRx()
            Dc.PHASE_ABORT -> {
                rx?.close()
                rx = null
                cb?.toast("对方取消了这次传输")
            }
        }
    }

    private fun beginRx(m: JSONObject) {
        // 上一笔还没收完又来了新的 → 旧的作废（正常不会发生，但不能让它占着句柄）
        rx?.close()
        rx = null

        val id = m.optString("id")
        val size = m.optLong("size", -1L)
        if (id.isBlank() || size < 0) return
        if (size > XFER_MAX_BYTES) {
            cb?.toast("对方要发的东西太大了（${fmtBytes(size)}），超过 100MB 上限")
            // ⚠ 要回一条 abort：不回的话对方会一直等在那里把字节灌进虚空
            engine.sendDc(Dc.xferAbort(id))
            return
        }

        val kind = m.optString("kind").ifBlank { Dc.KIND_FILE }
        val mime = m.optString("mime")
        val rawName = m.optString("name")
        val dir = File(context.cacheDir, RECV_DIR).apply { mkdirs() }

        val shownName: String
        val target: File
        if (kind == Dc.KIND_VOICE) {
            shownName = ""
            target = uniqueFileIn(dir, "voice-${System.currentTimeMillis()}.${extFor(mime)}")
        } else {
            shownName = rawName.ifBlank { "文件" }
            // ⚠ 对端给的名字是不可信输入，必须先洗掉路径分隔符再落盘，
            //   否则 `../../xxx` 这种能写到缓存目录外面去。
            target = uniqueFileIn(dir, safeFileName(shownName))
        }

        val out = try {
            FileOutputStream(target)
        } catch (t: Throwable) {
            Log.w(TAG, "无法落盘接收的文件", t)
            cb?.toast("接收失败：写不进缓存目录")
            engine.sendDc(Dc.xferAbort(id))
            return
        }
        rx = Rx(id, kind, shownName, size, m.optLong("dur", 0L), target, out)

        if (kind == Dc.KIND_FILE && size > PROGRESS_MIN_BYTES) {
            cb?.status("正在接收 $shownName…")
        }
    }

    /** 收到一个二进制分片。与文本同队列，所以这边的 rx 一定已经建好了。 */
    private fun onDcBinary(bytes: ByteArray) {
        val r = rx ?: return              // 没有 begin（或已取消）→ 丢掉，别当成正文
        try {
            r.out.write(bytes)
            r.got += bytes.size
        } catch (t: Throwable) {
            Log.w(TAG, "写入分片失败", t)
            r.close()
            rx = null
            cb?.toast("接收中写出错，这条没收下来")
        }
    }

    private fun finishRx() {
        val r = rx ?: return
        rx = null
        r.close()
        Log.i(TAG, "收到 ${r.kind} ${r.name} 共 ${r.got}/${r.size} 字节 → ${r.file.name}")

        if (r.got < r.size) {
            // 少了字节就绝不当成完整文件交给用户 —— 半截的 apk / 图片比没有更误导
            r.file.delete()
            cb?.toast("传输不完整（收到 ${fmtBytes(r.got)} / ${fmtBytes(r.size)}）")
            cb?.status(if (remotePeerId != null) "已连接" else "等待对方接入")
            return
        }
        cb?.status(if (remotePeerId != null) "已连接" else "等待对方接入")
        if (r.kind == Dc.KIND_VOICE) cb?.voice(r.file.absolutePath, r.dur, false)
        else cb?.file(r.file.absolutePath, r.name, r.got, false)
    }

    /**
     * 发一条语音 / 一个文件。
     *
     * @param localPath 本地那份（自己这条气泡点开时用的就是它）
     * @param onDone    成功与否。**只在主线程回调** —— 界面要拿它给气泡打「失败」标。
     */
    fun sendTransfer(
        kind: String,
        name: String,
        mime: String,
        size: Long,
        dur: Long,
        localPath: String,
        onDone: ((Boolean) -> Unit)? = null,
    ) {
        if (!dcReady()) {
            cb?.toast("还没和对方接通")
            onDone?.invoke(false)
            return
        }
        if (size > XFER_MAX_BYTES) {
            cb?.toast("「$name」超过 100MB 上限，换个小点的")
            onDone?.invoke(false)
            return
        }
        if (size <= 0) {
            onDone?.invoke(false)
            return
        }

        val id = UUID.randomUUID().toString()
        val src = File(localPath)
        Thread({
            var ok = false
            try {
                ok = pumpOut(id, kind, name, mime, size, dur, src)
            } catch (t: Throwable) {
                Log.w(TAG, "发送失败", t)
            } finally {
                main.post { onDone?.invoke(ok) }
            }
        }, "rt-send").start()
    }

    /** 真正的发送循环（后台线程）。返回是否完整送达通道。 */
    private fun pumpOut(
        id: String,
        kind: String,
        name: String,
        mime: String,
        size: Long,
        dur: Long,
        src: File,
    ): Boolean {
        if (!sendOnMain { engine.sendDc(Dc.xferBegin(id, kind, name, mime, size, dur)) }) return false

        val big = size > PROGRESS_MIN_BYTES
        if (big) main.post { cb?.status("正在发送 $name…") }

        val buf = ByteArray(XFER_CHUNK)
        var sent = 0L
        var lastPct = -1

        try {
            FileInputStream(src).use { ins ->
                while (sent < size) {
                    if (!engine.isChannelOpen) return false

                    // 背压：缓冲顶到高水位就等它排下去。
                    // ⚠ 必须带超时兜底 —— 万一通道一直不通，没有上限的等待会让这条
                    //   线程永远挂着（用户看到的就是「一直卡在 42%」）。
                    var waited = 0
                    while (engine.dcBufferedAmount() > XFER_HIGH && waited < DRAIN_TIMEOUT_MS) {
                        Thread.sleep(20)
                        waited += 20
                    }
                    if (waited >= DRAIN_TIMEOUT_MS) return false

                    val n = ins.read(buf)
                    if (n <= 0) break
                    // copyOf 是必须的：buf 会被下一轮复用，而主线程是**异步**取的，
                    // 直接传 buf 会让某一分片发到别人的内容。
                    val chunk = buf.copyOf(n)
                    if (!sendOnMain { engine.sendDcBinary(chunk) }) return false
                    sent += n

                    if (big) {
                        val pct = ((sent * 100) / size).toInt()
                        if (pct != lastPct) {
                            lastPct = pct
                            main.post { cb?.status("正在发送 $name $pct%") }
                        }
                    }
                }
            }
            if (sent < size) return false
            if (!sendOnMain { engine.sendDc(Dc.xferEnd(id)) }) return false
        } finally {
            main.post { cb?.status(if (remotePeerId != null) "已连接" else "等待对方接入") }
        }
        return true
    }

    /**
     * 在主线程上跑一段「发数据」的代码，并等它真的跑完。
     *
     * 为什么非等不可：不等就没有背压 —— 后台线程会一路把整个文件全塞进
     * `main` 的消息队列（几十 MB 的分片对象全排在那儿），缓冲水位根本来不及反映，
     * 也就无从判断「该停下来等一等」。
     */
    private fun sendOnMain(block: () -> Boolean): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val latch = CountDownLatch(1)
        var ok = false
        main.post {
            try { ok = block() } finally { latch.countDown() }
        }
        return if (latch.await(5, TimeUnit.SECONDS)) ok else false
    }

    /**
     * 语音存成什么扩展名，由 mime 决定 —— 拿错了系统播放器就打不开。
     *
     * 安卓这边**只**产 mp4/aac，但对面可能是网页端（Chrome 给 webm/opus、
     * Safari 给 mp4），所以四种都要认。落盘扩展名和内容对不上时，
     * MediaPlayer 会直接报错，用户看到的是「点了没反应」。
     */
    private fun extFor(mime: String): String {
        val m = mime.lowercase()
        return when {
            m.contains("mp4") || m.contains("m4a") || m.contains("aac") -> "m4a"
            m.contains("webm") -> "webm"
            m.contains("ogg") -> "ogg"
            m.contains("mpeg") -> "mp3"
            else -> "bin"
        }
    }

    /* ============================== 信任（TOFU） ============================== */

    /**
     * 收到对方的「名片」。判定顺序与网页端 `onPeerIdentity` 逐条对齐：
     *
     *   ① 在我请出去过的名单里 → 房主且开着「自动请出」就再请一次；
     *      关掉了的话只报告事实，动不动手由用户定。
     *   ② 没有记录 → 第一次，**如实说明，要不要收下交给用户点**。
     *   ③ 和记录一致 → 熟人，一行极轻的确认就够。
     *   ④ 和记录不一致 → 明确警告，并给出「请出房间」的入口。
     *
     * ⚠ 首访**绝不自动记住**。「谁先进房谁就是自己人」是最糟的信任模型：
     *   一旦被冒名顶替，你反而会把它当成「已确认」，之后真正的对方来了
     *   反倒成了「设备变过」的可疑对象。
     */
    private fun onPeerIdentity(id: String) {
        if (id.isBlank()) return
        peerDeviceId = id

        if (trust.blocked(room).contains(id)) {
            when {
                // ⚠ 这种情况用 "blocked" 而不是 "warn"：拉黑名单里的人不能再给
                //   「记住这台设备」的入口 —— 一边记着它是坏设备、一边又欢迎它，
                //   是自相矛盾的。
                !isHost -> cb?.trust(
                    "blocked",
                    "⚠️ 对方是你之前请出过的设备，但你不是先进入房间的一方，无法请走它。你可以直接退出房间。",
                )
                trust.autoKick -> kickPeer("对方是你之前请出过的设备，已再次请出")
                else -> cb?.trust(
                    "blocked",
                    "⚠️ 对方是你之前请出过的设备。你已经关掉了自动请出：要赶人请点「请出房间」，想放他进来就不用管。",
                )
            }
            return
        }

        val known = trust.trusted(room)
        when {
            known.isNullOrBlank() -> cb?.trust(
                "first",
                "这是和这台设备的第一次通话。如果确认对方就是约好的人，可以点「记住这台设备」——下次它进来会显示「已确认」。",
            )
            known == id -> cb?.trust("ok", "已确认为熟悉的设备")
            else -> cb?.trust(
                "warn",
                "⚠️ 这次进来的设备和你上次通话的不是同一台。如果对方换了手机或清了应用数据，忽略即可；否则请把它请出房间。",
            )
        }
    }

    /** 「记住这台设备」。把对方此刻的设备标识记到本机（按房间分开存）。 */
    fun rememberPeer() {
        val id = peerDeviceId
        if (id.isBlank()) {
            cb?.toast("还没拿到对方的设备标识")
            return
        }
        trust.setTrusted(room, id)
        cb?.trust("ok", "已确认为熟悉的设备")
    }

    /** 「解除拉黑」：把本机在这个房间里的名单清空。 */
    fun unblockAll() {
        trust.clearBlocked(room)
        cb?.toast("已解除拉黑，对方可以再进来")
        // 名单清了，之前那条「你把他请出去过」的提示就不成立了 —— 重新判一次
        if (peerDeviceId.isNotBlank()) onPeerIdentity(peerDeviceId) else cb?.trust("", "")
    }

    /** 当前这台设备的「自动请出」偏好。 */
    val autoKick: Boolean get() = trust.autoKick

    /** 本机在这个房间里的拉黑名单长度（界面用来决定要不要露「解除拉黑」）。 */
    val blockedCount: Int get() = trust.blocked(room).size

    fun setAutoKick(on: Boolean) {
        trust.autoKick = on
    }

    private fun peerText(): String {
        val n = peerName.ifBlank { "对方" }
        return if (callKind != null || remoteAudio || remoteVideo) {
            "$n${if (remoteAudio) "" else " · 未开麦"}${if (callKind == "video" && !remoteVideo) " · 未开摄像头" else ""}"
        } else n
    }

    /* ============================== 计时与收摊 ============================== */

    private fun beginCallTiming() {
        callStartedAt = System.currentTimeMillis()
        stopTimer()
        val r = object : Runnable {
            override fun run() {
                val s = (System.currentTimeMillis() - callStartedAt) / 1000
                cb?.timer(String.format("%02d:%02d", s / 60, s % 60))
                main.postDelayed(this, 1000)
            }
        }
        timerTick = r
        main.post(r)
    }

    private fun stopTimer() {
        timerTick?.let { main.removeCallbacks(it) }
        timerTick = null
        cb?.timer("")
    }

    private fun cancelCallOutTimer() {
        callOutTimer?.let { main.removeCallbacks(it) }
        callOutTimer = null
    }

    private fun cancelPeerLeftTimer() {
        peerLeftTimer?.let { main.removeCallbacks(it) }
        peerLeftTimer = null
    }

    /**
     * 把「正在收的那一笔」作废：关句柄 + 删掉半截文件。
     *
     * 为什么必须删：对方断线时那笔传输不会有 end，留在缓存目录里的半截文件
     * 既占地方又永远不会有人来收尾 —— 一个几百 MB 的残片能一直躺在那里，
     * 直到系统自己清缓存为止。
     */
    private fun dropRx() {
        val r = rx ?: return
        rx = null
        r.close()
        try { r.file.delete() } catch (_: Throwable) { /* 删不掉就算了，别因此中断收摊 */ }
    }

    private fun teardown() {
        started = false
        dropRx()
        // 后台那趟「派生 + 建厂」还没回来时用户就退出了 —— 标记作废，
        // 免得它回来之后又把信号连接建起来（用户已经不在房间页了）
        entering = false
        cancelCallOutTimer()
        cancelPeerLeftTimer()
        stopTimer()
        callKind = null
        callRinging = false
        incomingKind = null
        remotePeerId = null
        peerName = ""
        peerDeviceId = ""
        engine.closeAll()
        engine.disposePeer()
        signaling?.stop()
        signaling = null
    }

    companion object {
        private const val TAG = "RoomTalk.Session"

        /** 本地开发环境几十毫秒就能重连，1.5 秒在线上必然误杀 —— 见类注释③ */
        private const val GRACE_IN_CALL_MS = 20_000L
        private const val GRACE_CHAT_MS = 1_500L

        /* ---------- 传输参数：前三个与网页端逐字一致，改一处必须两端同改 ---------- */

        /** 每个分片的字节数（对齐网页端 XFER_CHUNK） */
        const val XFER_CHUNK = 64 * 1024

        /** 单文件上限（对齐网页端 XFER_MAX）。再大手机上内存和时长都吃不消。 */
        const val XFER_MAX_BYTES = 100L * 1024 * 1024

        /** 单条语音最长 60 秒（和微信一个量级），「按住说话」到点会自动停 */
        const val VOICE_MAX_MS = 60_000L

        /** 通道缓冲高于它就暂停发送（对齐网页端 XFER_HIGH） */
        private const val XFER_HIGH = 1_000_000L

        /** 超过这个体量才值得显示进度 —— 几 KB 的东西闪一下反而像卡了 */
        private const val PROGRESS_MIN_BYTES = 256 * 1024L

        /** 背压等待的上限。到点还不通就直接判失败，别把发送线程永久挂住。 */
        private const val DRAIN_TIMEOUT_MS = 30_000

        /** 收到的文件落在 cacheDir 的哪个子目录 */
        private const val RECV_DIR = "recv"

        val DEFAULT_ICE = listOf(
            "stun:stun.cloudflare.com:3478",
            "stun:stun.miwifi.com:3478",
            "stun:stun.l.google.com:19302",
        )
    }
}
