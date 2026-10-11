package com.roomtalk.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.text.InputType
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.isVisible
import com.roomtalk.android.core.CrashLog
import com.roomtalk.android.core.Dc
import com.roomtalk.android.core.fmtBytes
import com.roomtalk.android.core.fmtDur
import com.roomtalk.android.core.safeFileName
import com.roomtalk.android.core.uniqueFileIn
import com.roomtalk.android.net.RoomSession
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import java.io.File
import java.io.FileOutputStream

/**
 * 三屏一浮层，全靠 visibility 切换：
 *
 *   gate（输入口令） → room（聊天 + 发起通话） → call（全屏通话） → 来电浮层
 *
 * 不用 Fragment：三屏之间没有各自独立的状态要保存，切来切去只是显示/隐藏，
 * 用 Fragment 事务反而要处理「回来时视图被重建、渲染器 EGL 上下文失效」这类麻烦。
 */
class MainActivity : AppCompatActivity(), RoomSession.Cb {

    private companion object {
        /** 语音短于这个时长就丢掉 —— 与网页端一致（那边还额外看 600 字节） */
        const val MIN_VOICE_MS = 500L

        /** 手指上滑超过这个距离 → 松手取消（和微信一个量级，太灵敏会误取消） */
        const val CANCEL_SLOP_DP = 60f

        /**
         * 安卓录出来的一律是 mp4/aac。
         *
         * 选它而不是 opus/webm：Android 自带的 MediaRecorder 也只有这一套编码器；
         * 而 Chrome 和 Safari 都放得了 AAC —— 这是两端唯一的公约数。
         * 反过来（安卓收到 webm/opus）能不能播要看系统版本，所以网页端那边
         * 也把顺序调成优先 mp4（见 public/app.js 的 pickAudioMime）。
         */
        const val VOICE_MIME = "audio/mp4"

        const val TAG_UI = "RoomTalk.UI"
    }

    private lateinit var session: RoomSession

    /* ---------------- 各屏的视图 ---------------- */

    private lateinit var screenGate: View
    private lateinit var screenRoom: View
    private lateinit var screenCall: View
    private lateinit var ringOverlay: View
    private lateinit var toastView: TextView

    private lateinit var passInput: EditText
    private lateinit var passToggle: TextView

    /** 口令当前是否明文显示。默认 false —— 进房前多半有人站在旁边。 */
    private var passVisible = false

    private lateinit var peerInfo: TextView
    private lateinit var statusText: TextView
    private lateinit var msgList: LinearLayout
    private lateinit var msgScroll: ScrollView
    private lateinit var msgInput: EditText
    private lateinit var btnVoice: ImageView
    private lateinit var btnAttach: ImageView
    private lateinit var holdTalk: TextView
    private lateinit var recHud: TextView

    /* 信任条（TOFU）。房主的三个动作都在这里，顶栏刻意不放。 */
    private lateinit var trustBar: View
    private lateinit var trustText: TextView
    private lateinit var trustKeep: TextView
    private lateinit var trustKick: TextView
    private lateinit var trustUnblock: TextView
    private lateinit var autokickWrap: View
    private lateinit var autokickBox: CheckBox

    private lateinit var videoStage: View
    private lateinit var audioFace: View
    private lateinit var renderBig: SurfaceViewRenderer
    private lateinit var renderSmall: SurfaceViewRenderer
    private lateinit var callTitle: TextView
    private lateinit var callTimerTop: TextView
    private lateinit var callPeerBig: TextView
    private lateinit var callStateText: TextView
    private lateinit var btnMic: ImageView
    private lateinit var btnCam: ImageView
    private lateinit var btnFlip: ImageView
    private lateinit var btnSpeaker: ImageView

    private lateinit var ringName: TextView
    private lateinit var ringTitle: TextView

    /* ---------------- 状态 ---------------- */

    /** 渲染器只 init 一次：重复 init 会把 EGL 表面拆了重建，画面会闪黑一下。 */
    private var renderersReady = false

    /** 当前通话是不是视频（决定显示视频舞台还是头像占位）。 */
    private var callIsVideo = false

    /** 对方显示名（从 peerInfo 里截出来，去掉「· 未开麦」这类角标）。 */
    private var peerLabel = ""

    /** 我是不是房主（= 第一个进房的人）。只有房主能请人出去。 */
    private var amHost = false

    /** 信任条的当前状态，重算显隐时要用。 */
    private var trustKind = ""
    private var trustMsg = ""

    /** 权限弹窗回来后要执行的动作。同时只可能有一个（用户不可能同时发起两通电话）。 */
    private var pendingAction: (() -> Unit)? = null

    private val toastHide = Runnable { toastView.isVisible = false }

    /* ---------------- 语音消息 / 文件 ---------------- */

    /** 输入栏是否处于「按住说话」模式。 */
    private var voiceMode = false

    /** 正在录的那支 recorder。null = 没在录。 */
    private var recorder: MediaRecorder? = null

    /** 正在录的目标文件。 */
    private var recFile: File? = null

    /** 本次录音的起点（用 elapsedRealtime，不受用户改系统时间影响）。 */
    private var recStartedAt = 0L

    /** 手指是否已经上滑到「松手取消」的区域。 */
    private var recCancelArmed = false

    /** 到点自动停的定时任务（语音最长 60 秒）。 */
    private var recStopTask: Runnable? = null

    /**
     * 录音提示条的刷新。
     *
     * 200ms 一次而不是跟秒数走：秒针跳变本身不需要这么频繁，但「上滑到取消区」的
     * 反馈必须是即时的 —— 手指一滑过阈值，用户得马上看到提示从「松手发送」变成
     * 「松手取消」，否则他会以为滑了没用。滑过阈值时另外还会立刻刷一次（见
     * [onHoldTalkTouch]），不必等这个 tick。
     */
    private val recTick = object : Runnable {
        override fun run() {
            if (recorder == null) return
            val ms = SystemClock.elapsedRealtime() - recStartedAt
            recHud.text = recHudText(ms)
            recHud.postDelayed(this, 200)
        }
    }

    private fun recHudText(ms: Long): String {
        val hint = getString(if (recCancelArmed) R.string.rec_cancel_hint else R.string.rec_hint)
        return "● ${fmtDur(ms)} · $hint"
    }

    /**
     * 正在播的那条语音。
     *
     * ⚠ 只在界面上留**一条**播放器：同时两三个 MediaPlayer 各播各的，用户听到的是
     *   叠在一起的几段人声，而且再也分不清哪条在响。新点一条就先停掉上一条。
     */
    private var player: MediaPlayer? = null
    private var playerPath: String? = null
    private var playerBtn: ImageView? = null

    /** 「另存为」流程里等着被保存的源文件。 */
    private var pendingSave: File? = null

    /**
     * 选文件。用 OpenMultipleDocuments 而不是 GetContent：
     * 前者给的是**持久可读**的 URI，而且允许一次选多个（网页端也是多选）。
     */
    private val pickFiles = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> if (!uris.isNullOrEmpty()) onFilesPicked(uris) }

    /** 「另存为」的目的地（由系统文件选择器给出）。 */
    private val saveAs = registerForActivityResult(
        ActivityResultContracts.CreateDocument("*/*"),
    ) { dest -> onSaveTargetChosen(dest) }

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val action = pendingAction
        pendingAction = null
        if (result.isNotEmpty() && result.values.all { it }) {
            action?.invoke()
        } else {
            showToast(getString(R.string.perm_need))
            // 权限被拒 → 通话没能起来，界面得退回房间页，别把用户留在空白的通话页上
            if (!session.inCallNow) hideCallUi()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // ⚠ 第一件事就装崩溃兜底：越早装，能接住的崩溃越多。
        //   这个 App 是网页下载安装的，没有应用商店的崩溃上报，用户也不会去开
        //   USB 调试抓 logcat —— 自己不记下来，出事就真的什么都查不到。
        CrashLog.install(this)

        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        bindViews()
        wireClicks()

        session = RoomSession(this)
        session.cb = this

        resetToGate()

        // 上次崩过？把堆栈摆出来。这是唯一能让用户「把崩溃原因交出来」的通道。
        CrashLog.last(this)?.let { showCrashDialog(it) }
    }

    override fun onDestroy() {
        super.onDestroy()
        // 录音与播放都持有系统资源（麦克风、音频焦点），Activity 没了就必须收掉 ——
        // 它们不受视图生命周期管理，视图销毁并不会让它们停。
        abortRecording()
        stopPlay()
        // ⚠ 先解绑画布再销毁会话：SurfaceViewRenderer 必须先 release()，
        //   否则会把 EGL 上下文一起带进坟墓（泄漏，切几次页就崩）。
        session.detachRenderers()
        renderersReady = false
        session.cb = null
        session.destroy()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        when {
            screenCall.isVisible -> session.endCall(silent = false)
            screenRoom.isVisible -> session.leave()
            else -> super.onBackPressed()
        }
    }

    /* ============================== 绑定与接线 ============================== */

    private fun bindViews() {
        screenGate = findViewById(R.id.screenGate)
        screenRoom = findViewById(R.id.screenRoom)
        screenCall = findViewById(R.id.screenCall)
        ringOverlay = findViewById(R.id.ringOverlay)
        toastView = findViewById(R.id.toastView)

        passInput = findViewById(R.id.passInput)
        passToggle = findViewById(R.id.passToggle)

        peerInfo = findViewById(R.id.peerInfo)
        statusText = findViewById(R.id.statusText)
        msgList = findViewById(R.id.msgList)
        msgScroll = findViewById(R.id.msgScroll)
        msgInput = findViewById(R.id.msgInput)
        btnVoice = findViewById(R.id.btnVoice)
        btnAttach = findViewById(R.id.btnAttach)
        holdTalk = findViewById(R.id.holdTalk)
        recHud = findViewById(R.id.recHud)

        trustBar = findViewById(R.id.trustBar)
        trustText = findViewById(R.id.trustText)
        trustKeep = findViewById(R.id.trustKeep)
        trustKick = findViewById(R.id.trustKick)
        trustUnblock = findViewById(R.id.trustUnblock)
        autokickWrap = findViewById(R.id.autokickWrap)
        autokickBox = findViewById(R.id.autokick)

        videoStage = findViewById(R.id.videoStage)
        audioFace = findViewById(R.id.audioFace)
        renderBig = findViewById(R.id.renderBig)
        renderSmall = findViewById(R.id.renderSmall)
        callTitle = findViewById(R.id.callTitle)
        callTimerTop = findViewById(R.id.callTimerTop)
        callPeerBig = findViewById(R.id.callPeerBig)
        callStateText = findViewById(R.id.callStateText)
        btnMic = findViewById(R.id.btnMic)
        btnCam = findViewById(R.id.btnCam)
        btnFlip = findViewById(R.id.btnFlip)
        btnSpeaker = findViewById(R.id.btnSpeaker)

        ringName = findViewById(R.id.ringName)
        ringTitle = findViewById(R.id.ringTitle)
    }

    private fun wireClicks() {
        findViewById<View>(R.id.enterBtn).setOnClickListener { onEnter() }
        passInput.setOnEditorActionListener { _, _, _ -> onEnter(); true }
        passToggle.setOnClickListener { togglePassMask() }

        findViewById<View>(R.id.leaveBtn).setOnClickListener { session.leave() }

        trustKeep.setOnClickListener { session.rememberPeer() }
        trustKick.setOnClickListener { session.kickPeer() }
        trustUnblock.setOnClickListener { session.unblockAll() }
        // 复选框本身不接点击（怕它和整行的点击抢），点整行来切换
        autokickWrap.setOnClickListener {
            val next = !session.autoKick
            session.setAutoKick(next)
            autokickBox.isChecked = next
        }

        findViewById<View>(R.id.btnSend).setOnClickListener { sendCurrentMessage() }
        msgInput.setOnEditorActionListener { _, _, _ -> sendCurrentMessage(); true }

        // 语音 / 键盘 模式切换
        btnVoice.setOnClickListener { setVoiceMode(!voiceMode) }
        // 发文件
        btnAttach.setOnClickListener { pickAndSendFiles() }
        holdTalk.setOnTouchListener { v, e -> onHoldTalkTouch(v, e) }

        // 发起通话：权限必须在**动作之前**拿到。ensureMic/ensureCam 拿不到权限时
        // 只会失败，不会自己弹窗 —— 弹窗得由界面这一层负责。
        findViewById<View>(R.id.btnAudioCall).setOnClickListener {
            withPerms(Manifest.permission.RECORD_AUDIO) { session.startCall("audio") }
        }
        findViewById<View>(R.id.btnVideoCall).setOnClickListener {
            withPerms(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO) {
                session.startCall("video")
            }
        }

        btnMic.setOnClickListener {
            if (session.inCallNow) updateMicIcon(session.toggleMic()) else showToast("先发起或接听一个通话")
        }
        btnCam.setOnClickListener {
            if (session.inCallNow) updateCamIcon(session.toggleCam()) else showToast("当前不是视频通话")
        }
        btnFlip.setOnClickListener { session.flipCamera() }
        btnSpeaker.setOnClickListener { updateSpeakerIcon(session.toggleSpeaker()) }
        findViewById<View>(R.id.btnHangup).setOnClickListener { session.endCall(silent = false) }

        // 点画面上任意一块 → 大小窗对调（和网页端一致：两端各点各的，互不干扰）
        renderBig.setOnClickListener { session.swapStage() }
        renderSmall.setOnClickListener { session.swapStage() }

        findViewById<View>(R.id.ringAccept).setOnClickListener {
            // 点「接听」就是用户的手势与同意 —— 到这一步才真正打开麦克风
            withPerms(Manifest.permission.RECORD_AUDIO) { session.answerIncoming() }
        }
        findViewById<View>(R.id.ringReject).setOnClickListener { session.rejectIncoming() }
    }

    private fun onEnter() {
        val pass = passInput.text.toString()
        if (pass.isBlank()) {
            showToast("先输入一个口令")
            return
        }
        session.enter(pass)
        screenGate.isVisible = false
        screenRoom.isVisible = true
        statusText.text = getString(R.string.waiting)
    }

    /* ============================== 屏幕切换 ============================== */

    private fun resetToGate() {
        // ⚠ 先把两条「还在跑的东西」收掉再清界面：
        //   录音中的麦克风和正在播的语音都持有系统资源，光清视图是收不掉的
        //   （麦克风指示灯会一直亮着，语音会继续放下去）。
        abortRecording()
        stopPlay()
        setVoiceMode(false)
        screenGate.isVisible = true
        screenRoom.isVisible = false
        screenCall.isVisible = false
        ringOverlay.isVisible = false
        clearKeepScreenOn()
        // 清掉上一次的房间残留：消息流、状态、请出按钮
        msgList.removeAllViews()
        msgInput.setText("")
        peerLabel = ""
        peerInfo.text = getString(R.string.waiting)
        statusText.text = getString(R.string.waiting)
        btnFlip.isVisible = false
        amHost = false
        trustKind = ""
        trustMsg = ""
        refreshTrustBar()
    }

    private fun showCallUi(isVideo: Boolean) {
        callIsVideo = isVideo
        screenCall.isVisible = true
        videoStage.isVisible = isVideo
        audioFace.isVisible = !isVideo
        callTitle.text = peerNameOrFallback()
        callPeerBig.text = peerNameOrFallback()
        callStateText.text = if (session.inCallNow) getString(R.string.in_call) else getString(R.string.calling)
        callTimerTop.text = ""
        btnCam.isVisible = isVideo
        btnFlip.isVisible = isVideo && btnFlip.isVisible
        // ⚠ 通话期间强制常亮。手机贴到耳朵上屏幕一黑，不少机型会顺手把麦克风
        //   也掐掉；我们没有后台服务兜底，所以最省事也最可靠的做法就是别让它黑。
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        ensureRenderers()
    }

    private fun hideCallUi() {
        screenCall.isVisible = false
        callTimerTop.text = ""
        callStateText.text = getString(R.string.calling)
        clearKeepScreenOn()
    }

    private fun clearKeepScreenOn() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun peerNameOrFallback(): String = peerLabel.ifBlank { "对方" }

    /* ============================== 渲染器 ============================== */

    /**
     * 两块画布只 init 一次。
     *
     * ⚠ `init()` 必须传 [RoomSession.eglContext]（也就是引擎自己那个 EglBase）：
     *   采集、解码、上屏要共用同一个 GL 上下文，各建各的会出现「有声音、没画面」。
     */
    private fun ensureRenderers() {
        if (renderersReady) return
        val ctx = session.eglContext ?: return      // 还没进房间，工厂没建
        renderBig.init(ctx, null)
        renderBig.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)   // 大窗不裁切
        renderBig.setEnableHardwareScaler(true)

        renderSmall.init(ctx, null)
        renderSmall.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL) // 小窗当缩略图，铺满
        renderSmall.setEnableHardwareScaler(true)
        // ⚠ 两块都是 SurfaceView，层级不是按 layout 顺序排的。小窗必须抬到
        //   media overlay 层，否则会被大窗整个盖住（表现为「小窗永远是黑的」）。
        renderSmall.setZOrderMediaOverlay(true)

        renderersReady = true
        session.attachRenderers(renderBig, renderSmall)
    }

    /* ============================== 权限 ============================== */

    private fun withPerms(vararg perms: String, action: () -> Unit) {
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            action()
            return
        }
        pendingAction = action
        permLauncher.launch(missing.toTypedArray())
    }

    /* ============================== 气泡与小提示 ============================== */

    private fun addBubble(text: String, mine: Boolean) {
        val density = resources.displayMetrics.density
        val tv = TextView(this).apply {
            this.text = text
            textSize = 15f
            setTextColor(ContextCompat.getColor(this@MainActivity, if (mine) R.color.on_primary else R.color.text))
            setBackgroundResource(if (mine) R.drawable.bg_bubble_me else R.drawable.bg_bubble_them)
            val padH = (13 * density).toInt()
            val padV = (9 * density).toInt()
            setPadding(padH, padV, padH, padV)
            maxWidth = (resources.displayMetrics.widthPixels * 0.78f).toInt()
        }
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply {
            gravity = if (mine) Gravity.END else Gravity.START
            topMargin = (7 * density).toInt()
        }
        msgList.addView(tv, lp)
        scrollToBottom()
    }

    private fun showToast(text: String) {
        if (text.isBlank()) return
        toastView.text = text
        toastView.isVisible = true
        toastView.removeCallbacks(toastHide)
        toastView.postDelayed(toastHide, 2600)
    }

    /**
     * 把上一次的崩溃摆给用户看。
     *
     * 刻意用可选中 + 等宽的文本，并给一个「复制」按钮：要的是用户能**原样**
     * 把这堆东西发出来。少一个字都可能丢线索（比如最上面那行异常类型）。
     */
    private fun showCrashDialog(text: String) {
        val body = TextView(this).apply {
            this.text = text
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(30, 24, 30, 24)
        }
        val scroll = ScrollView(this).apply { addView(body) }

        AlertDialog.Builder(this)
            .setTitle("上次启动时崩溃了")
            .setMessage("把下面这段原样发出来，就能定位原因。")
            .setView(scroll)
            .setPositiveButton("复制") { _, _ ->
                val cm = getSystemService(ClipboardManager::class.java)
                cm?.setPrimaryClip(ClipData.newPlainText("roomtalk-crash", text))
                showToast("已复制，发给我即可")
            }
            .setNeutralButton("清除") { _, _ -> CrashLog.clear(this) }
            .setNegativeButton("先不管", null)
            .show()
    }

    private fun sendCurrentMessage() {
        val t = msgInput.text.toString()
        if (t.isBlank()) return
        if (session.sendMessage(t)) msgInput.setText("")
    }

    /* ========================= 语音模式 / 按住说话 ========================= */

    /**
     * 输入栏在「键盘」和「按住说话」两种模式间切换。
     *
     * ⚠ 这两个模式占的是**同一个位置**（都是 layout_weight=1 的那一格），
     *   所以切换时整排按钮一个都不挪 —— 用户拇指对「发起通话在哪」的位置记忆
     *   不会因为切了模式而失效。这是刻意对齐网页端的做法。
     */
    private fun setVoiceMode(on: Boolean) {
        voiceMode = on
        msgInput.isVisible = !on
        holdTalk.isVisible = on
        btnVoice.setImageResource(if (on) R.drawable.ic_kbd else R.drawable.ic_mic)
        btnVoice.contentDescription = getString(if (on) R.string.to_keyboard else R.string.to_voice)
        if (on) {
            // 语音模式下输入框已经不在了，键盘再挂着只会白占半屏
            val imm = getSystemService(InputMethodManager::class.java)
            imm?.hideSoftInputFromWindow(currentFocus?.windowToken ?: msgInput.windowToken, 0)
        }
    }

    /**
     * 「按住说话」的触摸处理。
     *
     * 为什么用 OnTouchListener 而不是 OnClickListener：这个交互的**核心信息就是
     * 「按了多久」**。点击事件只给得出「按过」，给不出时长，也拿不到「手指滑走了」
     * 这个取消意图 —— 而「上滑取消」恰恰是语音消息最需要的一条退路（按错了、
     * 想重说，不用发出去再撤回）。
     *
     * 返回 true 是必须的：ACTION_DOWN 不吃掉，后面的 MOVE / UP 一个都不会派过来。
     */
    private fun onHoldTalkTouch(v: View, e: MotionEvent): Boolean {
        val cancelDy = -(CANCEL_SLOP_DP * resources.displayMetrics.density)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                recCancelArmed = false
                startRecording()
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                val armed = e.y < cancelDy
                if (armed != recCancelArmed) {
                    recCancelArmed = armed
                    // 立刻刷新，不等下一个 tick —— 手指一滑过去就得看到文字变了
                    if (recorder != null) {
                        recHud.text = recHudText(SystemClock.elapsedRealtime() - recStartedAt)
                    }
                }
                return true
            }

            MotionEvent.ACTION_UP -> {
                stopRecording(cancel = recCancelArmed)
                return true
            }

            // 被系统打断（来电、手势返回…）：一律按取消处理。
            // 按「发送」处理的话，用户会莫名其妙发出一条自己没想发的东西。
            MotionEvent.ACTION_CANCEL -> {
                stopRecording(cancel = true)
                return true
            }
        }
        return false
    }

    private fun startRecording() {
        if (recorder != null) return
        if (session.inCallNow) {
            showToast("通话中不能发语音消息")
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            // 权限弹窗是异步的，这一按不可能录上。如实让用户再按一次，
            // 比录出一个 0 字节文件然后告诉他「说话太短」要清楚得多。
            withPerms(Manifest.permission.RECORD_AUDIO) {
                showToast("授权好了，再按住一次说话")
            }
            return
        }

        val dir = File(cacheDir, "voice").apply { mkdirs() }
        val f = File(dir, "rec-${System.currentTimeMillis()}.m4a")
        val rec = newRecorder()
        try {
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            // 64 kbps / 44.1 kHz：语音够清楚，兜满 60 秒也就 ~470KB，走 P2P 是瞬间的事。
            // 没必要为了省几百 KB 把声音压闷 —— 语音消息听不清就白发了。
            rec.setAudioEncodingBitRate(64_000)
            rec.setAudioSamplingRate(44_100)
            rec.setOutputFile(f.absolutePath)
            rec.prepare()
            rec.start()
        } catch (t: Throwable) {
            Log.w(TAG_UI, "录音起不来", t)
            try { rec.release() } catch (_: Throwable) { /* 还没拿到资源 */ }
            f.delete()
            showToast("打不开麦克风，录不了")
            return
        }

        recorder = rec
        recFile = f
        recStartedAt = SystemClock.elapsedRealtime()
        holdTalk.setBackgroundResource(R.drawable.bg_hold_talk_rec)
        holdTalk.setTextColor(Color.WHITE)
        holdTalk.text = getString(R.string.release_to_send)
        recHud.isVisible = true
        recTick.run()

        // 到点自动停：不设上限的话，用户一松手之前麦克风一直开着，
        // 而且一条 10 分钟的语音也没人听得完。
        val stop = Runnable { stopRecording(cancel = false) }
        recStopTask = stop
        recHud.postDelayed(stop, RoomSession.VOICE_MAX_MS)
    }

    /**
     * 建一支 recorder。
     *
     * API 31 起无参构造被标记废弃（新签名要求传 Context，用来做归因），
     * 但 minSdk 是 24，所以两条路都得留。用版本判断而不是一味压 @Suppress：
     * 压住的话在新系统上会退到老路径，将来真出问题时连个警告都没有。
     */
    private fun newRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(this)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }

    private fun stopRecording(cancel: Boolean) {
        val rec = recorder ?: return
        recorder = null

        recStopTask?.let { recHud.removeCallbacks(it) }
        recStopTask = null
        recHud.removeCallbacks(recTick)
        recHud.isVisible = false
        holdTalk.setBackgroundResource(R.drawable.bg_hold_talk)
        holdTalk.setTextColor(ContextCompat.getColor(this, R.color.text))
        holdTalk.text = getString(R.string.hold_to_talk)

        val dur = SystemClock.elapsedRealtime() - recStartedAt
        val f = recFile
        recFile = null
        val cancelled = cancel || recCancelArmed
        recCancelArmed = false

        // ⚠ stop() 在「还没拿到有效帧就停」时会抛（录太短就是这种）。
        //   这是预期内的，不能让它把后面的清理带走 —— 否则 recorder 既没 release、
        //   文件也没删掉，麦克风指示灯会一直亮着。
        try { rec.stop() } catch (_: Throwable) { /* 太短，预期内 */ }
        try { rec.release() } catch (_: Throwable) { /* 已经放了 */ }

        if (f == null) return
        if (cancelled) {
            f.delete()
            return
        }
        // 双阈值，和网页端一致：只要有一个不达标就当成误触。
        // 光看时长不够 —— 有些机型前几百毫秒只有静音帧，时长够了内容却是空的。
        if (dur < MIN_VOICE_MS || f.length() < 600) {
            f.delete()
            showToast(getString(R.string.voice_too_short))
            return
        }

        val capped = minOf(dur, RoomSession.VOICE_MAX_MS)
        addVoiceBubble(f.absolutePath, capped, mine = true)
        session.sendTransfer(
            kind = Dc.KIND_VOICE,
            name = "",
            mime = VOICE_MIME,
            size = f.length(),
            dur = capped,
            localPath = f.absolutePath,
        ) { ok -> if (!ok) showToast(getString(R.string.send_failed)) }
    }

    /** 离开房间 / 退出应用时把录音收干净（不发送）。 */
    private fun abortRecording() {
        if (recorder != null) stopRecording(cancel = true)
    }

    /* ============================== 语音 / 文件气泡 ============================== */

    /** 气泡外壳。语音和文件共用，保证两种气泡的圆角、内边距、贴边方向和文字气泡一致。 */
    private fun bubbleRow(mine: Boolean): LinearLayout {
        val d = resources.displayMetrics.density
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(if (mine) R.drawable.bg_bubble_me else R.drawable.bg_bubble_them)
            setPadding((12 * d).toInt(), (9 * d).toInt(), (12 * d).toInt(), (9 * d).toInt())
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = if (mine) Gravity.END else Gravity.START
                topMargin = (7 * d).toInt()
            }
        }
    }

    private fun addVoiceBubble(path: String, dur: Long, mine: Boolean) {
        val d = resources.displayMetrics.density
        val fg = ContextCompat.getColor(this, if (mine) R.color.on_primary else R.color.text)
        val row = bubbleRow(mine)

        val play = ImageView(this).apply {
            setImageResource(R.drawable.ic_play)
            imageTintList = ColorStateList.valueOf(fg)
            layoutParams = LinearLayout.LayoutParams((18 * d).toInt(), (18 * d).toInt())
        }
        // 气泡宽度随时长走 —— 微信就是靠这个让人**提前**知道「这条有点长」，
        // 而不是点开之后才发现。上限 60 秒，正好是语音的最大长度。
        val barW = (28 * d).toInt() +
            (minOf(dur, RoomSession.VOICE_MAX_MS) / 1000.0 * (1.6 * d)).toInt()
        val label = TextView(this).apply {
            text = fmtDur(dur)
            textSize = 15f
            setTextColor(fg)
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                barW, LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { marginStart = (8 * d).toInt() }
        }

        row.addView(play)
        row.addView(label)
        row.contentDescription = getString(R.string.voice_play)
        row.setOnClickListener { togglePlay(path, play) }
        msgList.addView(row)
        scrollToBottom()
    }

    private fun addFileBubble(path: String, name: String, size: Long, mine: Boolean) {
        val d = resources.displayMetrics.density
        val fg = ContextCompat.getColor(this, if (mine) R.color.on_primary else R.color.text)
        val row = bubbleRow(mine)

        val ico = ImageView(this).apply {
            setImageResource(R.drawable.ic_file)
            imageTintList = ColorStateList.valueOf(fg)
            layoutParams = LinearLayout.LayoutParams((26 * d).toInt(), (26 * d).toInt())
        }
        val nameView = TextView(this).apply {
            text = name
            textSize = 15f
            setTextColor(fg)
            maxLines = 2
            // 中间截断而不是末尾：文件名的**扩展名在最后**，
            // 末尾截断会把 `.apk` 这类最关键的辨识信息切掉。
            ellipsize = TextUtils.TruncateAt.MIDDLE
            maxWidth = (resources.displayMetrics.widthPixels * 0.5f).toInt()
        }
        val sizeView = TextView(this).apply {
            text = fmtBytes(size)
            textSize = 12f
            setTextColor(fg)
            alpha = 0.75f
        }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { marginStart = (10 * d).toInt() }
            addView(nameView)
            addView(sizeView)
        }

        row.addView(ico)
        row.addView(col)
        row.contentDescription = name
        row.setOnClickListener { showFileActions(path, name) }
        msgList.addView(row)
        scrollToBottom()
    }

    private fun scrollToBottom() {
        msgScroll.post { msgScroll.fullScroll(View.FOCUS_DOWN) }
    }

    /* ============================== 语音播放 ============================== */

    /**
     * 点语音气泡：播放 / 暂停。
     *
     * ⚠ 全局只保留一条播放器。界面上两条语音同时在放，用户听到的是叠在一起的
     *   两段人声，而且再也分不清哪条在响 —— 点第二条就必须先停第一条。
     */
    private fun togglePlay(path: String, btn: ImageView) {
        if (player != null && playerPath == path) {
            stopPlay()
            return
        }
        stopPlay()

        val mp = MediaPlayer()
        try {
            mp.setDataSource(path)
            // 同步 prepare：全都在几秒以内，而且这些文件已经在本地缓存里，
            // 不会有网络卡顿。用 async 反而要处理「回调回来时用户已经点了别的」。
            mp.prepare()
            mp.start()
        } catch (t: Throwable) {
            Log.w(TAG_UI, "播放失败：$path", t)
            try { mp.release() } catch (_: Throwable) { /* 没起来 */ }
            showToast(getString(R.string.voice_cannot_play))
            return
        }

        player = mp
        playerPath = path
        playerBtn = btn
        btn.setImageResource(R.drawable.ic_pause)
        mp.setOnCompletionListener { stopPlay() }
        mp.setOnErrorListener { _, _, _ -> stopPlay(); true }
    }

    private fun stopPlay() {
        player?.let {
            try { it.stop() } catch (_: Throwable) { /* 没在放 */ }
            try { it.release() } catch (_: Throwable) { /* 已经放了 */ }
        }
        player = null
        playerPath = null
        playerBtn?.setImageResource(R.drawable.ic_play)
        playerBtn = null
    }

    /* ============================== 文件：打开 / 另存 ============================== */

    /**
     * 点文件气泡 → 三个出口。
     *
     * 安卓没有网页那种「浏览器直接下载」的默认动作，所以必须给用户一个明确的
     * 选择：想直接用就看、想留下来就另存。第三个「复制路径」是给「系统里没装
     * 能打开它的应用」那种情况留的退路 —— 文件确实在本地，路径给他，怎么处置是他的事。
     */
    private fun showFileActions(path: String, name: String) {
        val f = File(path)
        if (!f.exists()) {
            showToast("这个文件已经不在了（缓存被清理过）")
            return
        }
        val items = arrayOf(
            getString(R.string.xfer_open),
            getString(R.string.xfer_save_as),
            getString(R.string.xfer_copy_path),
        )
        AlertDialog.Builder(this)
            .setTitle(name)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> openWithSystem(f)
                    1 -> {
                        pendingSave = f
                        // 用原文件名做默认名，用户直接确认就能存到「下载」里
                        saveAs.launch(safeFileName(name))
                    }

                    else -> {
                        getSystemService(ClipboardManager::class.java)
                            ?.setPrimaryClip(ClipData.newPlainText("roomtalk-path", path))
                        showToast("已复制文件路径")
                    }
                }
            }
            .show()
    }

    /**
     * 交给系统「用别的应用打开」。
     *
     * ⚠ 必须走 FileProvider 换成 `content://`：安卓 7.0 起把 `file://` 交给别的
     *   应用会直接抛 FileUriExposedException（而且是个很容易只在老设备上漏掉的坑）。
     */
    private fun openWithSystem(f: File) {
        val uri = try {
            FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
        } catch (t: Throwable) {
            Log.w(TAG_UI, "取 FileProvider URI 失败", t)
            showToast(getString(R.string.xfer_open_failed))
            return
        }
        val mime = contentResolver.getType(uri) ?: "*/*"
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            )
        } catch (t: Throwable) {
            // 没装能打开它的应用时，系统会抛 ActivityNotFoundException
            Log.w(TAG_UI, "没有应用能打开 $mime", t)
            showToast(getString(R.string.xfer_open_failed))
        }
    }

    /** 「另存为」选好目的地之后。 */
    private fun onSaveTargetChosen(dest: Uri?) {
        val src = pendingSave
        pendingSave = null
        if (dest == null || src == null) return

        // 可能是个上百 MB 的文件，复制绝不能压在主线程上
        Thread({
            var ok = false
            try {
                contentResolver.openOutputStream(dest)?.use { out ->
                    src.inputStream().use { ins -> ins.copyTo(out) }
                }
                ok = true
            } catch (t: Throwable) {
                Log.w(TAG_UI, "另存为失败", t)
            }
            ui { showToast(getString(if (ok) R.string.xfer_saved else R.string.xfer_save_failed)) }
        }, "rt-save").start()
    }

    /* ============================== 发文件 ============================== */

    private fun pickAndSendFiles() {
        if (!session.inRoom) {
            showToast("先进入房间")
            return
        }
        try {
            pickFiles.launch(arrayOf("*/*"))
        } catch (t: Throwable) {
            // 少数被定制过的 ROM 摘掉了系统文件选择器
            Log.w(TAG_UI, "打不开系统文件选择器", t)
            showToast(getString(R.string.pick_file))
        }
    }

    private fun onFilesPicked(uris: List<Uri>) {
        Thread({
            for (u in uris) {
                val picked = copyToOutbox(u) ?: continue
                ui {
                    addFileBubble(picked.file.absolutePath, picked.name, picked.file.length(), mine = true)
                    session.sendTransfer(
                        kind = Dc.KIND_FILE,
                        name = picked.name,
                        mime = picked.mime,
                        size = picked.file.length(),
                        dur = 0L,
                        localPath = picked.file.absolutePath,
                    ) { ok -> if (!ok) showToast(getString(R.string.send_failed)) }
                }
            }
        }, "rt-pick").start()
    }

    private class Picked(val file: File, val name: String, val mime: String)

    /**
     * 把选中的内容复制进应用缓存，作为这次发送的**本地底本**。
     *
     * 为什么不直接流式发：
     *   · 有些来源（云盘、相册）给的流**只能读一次**，中途重试就废了；
     *   · 协议要求 begin 里就报出准确的 size，而不少来源根本不提供 SIZE 列；
     *   · 自己这条气泡也得有个本地文件可点（网页端同理，Blob 就留在内存里）。
     * 先拷一份把这三件事一次解决，代价只是一份缓存占用。
     */
    private fun copyToOutbox(uri: Uri): Picked? {
        var name = "文件"
        var mime = "application/octet-stream"
        var declared = -1L
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0) c.getString(ni)?.takeIf { it.isNotBlank() }?.let { name = it }
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) declared = c.getLong(si)
                }
            }
            contentResolver.getType(uri)?.let { mime = it }
        } catch (t: Throwable) {
            Log.w(TAG_UI, "读文件信息失败", t)
        }
        if (declared > RoomSession.XFER_MAX_BYTES) {
            ui { showToast("「$name」${fmtBytes(declared)}，${getString(R.string.xfer_too_big)}") }
            return null
        }

        val dir = File(cacheDir, "outbox").apply { mkdirs() }
        val target = uniqueFileIn(dir, safeFileName(name))
        try {
            contentResolver.openInputStream(uri)?.use { ins ->
                FileOutputStream(target).use { out ->
                    val buf = ByteArray(RoomSession.XFER_CHUNK)
                    var total = 0L
                    while (true) {
                        val n = ins.read(buf)
                        if (n <= 0) break
                        total += n
                        // ⚠ 边读边卡上限：declared 可能缺失（=-1）也可能是假的，
                        //   不能只信它。真读到超了就得停 —— 否则一个几 GB 的东西
                        //   会把手机缓存盘灌满，而且协议那边也接不住。
                        if (total > RoomSession.XFER_MAX_BYTES) {
                            throw IllegalStateException("over limit")
                        }
                        out.write(buf, 0, n)
                    }
                }
            } ?: return null
        } catch (t: Throwable) {
            Log.w(TAG_UI, "复制到缓存失败", t)
            target.delete()
            ui { showToast("「$name」读不出来，已跳过") }
            return null
        }
        return Picked(target, name, mime)
    }

    /* ============================== 口令明文切换 ============================== */

    /**
     * 「显示 / 隐藏」口令。
     *
     * ⚠ 改 inputType 会把光标顶回开头，还会让输入法重新布局。所以：
     *   · 设完把光标**放回末尾** —— 用户点这一下几乎都是为了核对刚敲进去的口令，
     *     光标停在开头等于还得再点一次输入框；
     *   · 顺带把按钮文字换掉，否则「显示」看不出当前是哪个状态。
     */
    private fun togglePassMask() {
        passVisible = !passVisible
        passInput.inputType = if (passVisible) {
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        } else {
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        passToggle.text = getString(if (passVisible) R.string.pass_hide else R.string.pass_show)
        passInput.setSelection(passInput.text?.length ?: 0)
    }

    /* ============================== 通话按钮状态 ============================== */

    /**
     * 通话按钮的「开 / 关」怎么画 —— 两人都靠这一眼判断自己是不是被听见 / 被看见。
     *
     * 做法和旁边那颗挂断**完全一致**：**实心圆底 + 白色图标**。
     *   · 开 → 实心绿底（bg_call_btn_on）
     *   · 关 → 实心红底（bg_call_btn_off）
     *
     * 圆底一律填满，不用「半透明描边」那种弱提示：视频画面从上到下亮度能差好几个档，
     * 描边在亮画面里几乎看不见，而填色是整块区域，盖在什么底上都读得出来。
     * 图标恒为白色 —— 颜色只由底承担，图标只负责回答「这是哪颗键」。
     * 关掉时图标还带一道斜杠：颜色之外再给一层不依赖色觉的记号。
     */
    private fun paintCallBtn(btn: ImageView, on: Boolean, onRes: Int, offRes: Int) {
        btn.setImageResource(if (on) onRes else offRes)
        btn.setBackgroundResource(
            if (on) R.drawable.bg_call_btn_on else R.drawable.bg_call_btn_off,
        )
        btn.imageTintList = ColorStateList.valueOf(0xFFFFFFFF.toInt())
        // 更早的版本用 alpha 压暗表示「关」，现在由整块底色承担，残留的透明度要清掉
        btn.alpha = 1f
    }

    private fun updateMicIcon(on: Boolean) =
        paintCallBtn(btnMic, on, R.drawable.ic_mic, R.drawable.ic_mic_off)

    private fun updateCamIcon(on: Boolean) =
        paintCallBtn(btnCam, on, R.drawable.ic_videocam, R.drawable.ic_videocam_off)

    /** 免提开 = 外放（绿）；关 = 走听筒（红）。 */
    private fun updateSpeakerIcon(on: Boolean) =
        paintCallBtn(btnSpeaker, on, R.drawable.ic_volume, R.drawable.ic_volume_off)

    /* ============================== RoomSession.Cb ============================== */

    /**
     * 所有「回界面」的动作都从这儿过一道。
     *
     * ⚠ 这不是可选的防御，是必需品。WebRTC / OkHttp 的回调跑在它们自己的线程上
     *   （signaling、network、OkHttp 读线程），而 Android 只允许**创建视图的那个
     *   线程**（主线程）碰视图，越界会抛 CalledFromWrongThreadException ——
     *   这个异常若从 JNI 回调里逃出去，会被 WebRTC 的 `jvm.cc` 当成致命错误
     *   直接 abort 整个进程（SIGABRT），Java 层的 try/catch 一个都接不到。
     *
     * 引擎那边（见 PeerEngine 类注释③）已经统一切过主线程了，这里是**第二道**：
     * 将来谁新增一个回调忘了切，最多是晚一帧显示，而不会把整个进程带走。
     */
    private fun ui(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else runOnUiThread(block)
    }

    override fun status(text: String) {
        ui { statusText.text = text }
    }

    override fun message(text: String, mine: Boolean) {
        ui { addBubble(text, mine) }
    }

    override fun voice(path: String, dur: Long, mine: Boolean) {
        ui { addVoiceBubble(path, dur, mine) }
    }

    override fun file(path: String, name: String, size: Long, mine: Boolean) {
        ui { addFileBubble(path, name, size, mine) }
    }

    override fun peerInfo(text: String) {
        ui {
            peerInfo.text = text.ifBlank { getString(R.string.waiting) }
            // 「小米 14 · 未开麦」→ 只要「小米 14」
            peerLabel = text.substringBefore(" · ").trim()
            if (screenCall.isVisible) {
                callTitle.text = peerNameOrFallback()
                callPeerBig.text = peerNameOrFallback()
            }
        }
    }

    override fun callState(kind: String?) {
        ui {
            if (kind == null) {
                hideCallUi()
                return@ui
            }
            // 呼叫一发起就切到通话页：用户要立刻看见自己的画面 / 「正在呼叫…」
            if (!screenCall.isVisible) showCallUi(kind == "video")
            callStateText.text =
                if (session.inCallNow) getString(R.string.in_call) else getString(R.string.calling)
            btnCam.isVisible = kind == "video"
        }
    }

    override fun ringing(kind: String, name: String) {
        ui {
            ringName.text = name.ifBlank { "对方" }
            ringTitle.text = getString(if (kind == "video") R.string.ring_video else R.string.ring_audio)
            ringOverlay.isVisible = true
        }
    }

    override fun ringDismissed() {
        ui { ringOverlay.isVisible = false }
    }

    override fun callLive(kind: String, hasRemoteVideo: Boolean) {
        ui {
            if (!screenCall.isVisible) showCallUi(kind == "video")
            ensureRenderers()
            callStateText.text = getString(R.string.in_call)
            updateMicIcon(session.micOn)
            updateCamIcon(session.camOn)
            updateSpeakerIcon(session.speakerOn)
        }
    }

    override fun timer(text: String) {
        ui { callTimerTop.text = text }
    }

    override fun stage(remoteMain: Boolean) {
        // 大小窗对调**不用动界面**：引擎那边只是把两条轨道换了个画布接
        // （见 PeerEngine.applyStage）。所以这里没有要做的事。
        // 也正因为它什么都不做，才不需要 ui{} —— 哪天要做点什么，记得套上。
    }

    override fun attachRenderers() {
        // ⚠ 这条尤其要切：ensureRenderers() 会走 SurfaceViewRenderer.init()，
        //   那是在建 EGL 表面、动 View 树，离开主线程一样会炸。
        ui { ensureRenderers() }
    }

    override fun flipAvailable(available: Boolean) {
        ui { btnFlip.isVisible = available && callIsVideo }
    }

    override fun host(isHost: Boolean) {
        // 产品约定：房主 = 第一个进房的人。只有他能请人出去 / 解除拉黑。
        ui {
            amHost = isHost
            refreshTrustBar()
        }
    }

    override fun trust(kind: String, text: String) {
        ui {
            trustKind = kind
            trustMsg = text
            refreshTrustBar()
        }
    }

    /**
     * 重算信任条。规则与网页端的 `showTrust` + `reflectHostUI` 对齐：
     *
     *   · 整条    —— 房主**一直**可见（他要能提前把「自动请出」定下来）；
     *                不是房主时就只在这条有话说的时候才冒出来
     *   · 「记住」—— 只在「第一次」或「换了设备」时给；
     *                黑名单里的人不给（一边记着它是坏设备、一边又欢迎它，自相矛盾）
     *   · 「请出」—— 房主 + 有条目
     *   · 「解除」—— 房主 + 名单非空
     */
    private fun refreshTrustBar() {
        trustText.text = trustMsg
        trustText.isVisible = trustMsg.isNotBlank()
        trustKeep.isVisible = amHost && (trustKind == "first" || trustKind == "warn")
        trustKick.isVisible = amHost && trustMsg.isNotBlank()
        trustUnblock.isVisible = amHost && session.blockedCount > 0
        autokickWrap.isVisible = amHost
        autokickBox.isChecked = session.autoKick
        trustBar.isVisible = amHost || trustMsg.isNotBlank()
    }

    override fun toast(text: String) {
        ui { showToast(text) }
    }

    override fun backToGate(reason: String?) {
        ui {
            resetToGate()
            if (!reason.isNullOrBlank()) showToast(reason)
        }
    }
}
