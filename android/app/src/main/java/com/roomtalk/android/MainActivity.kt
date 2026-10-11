package com.roomtalk.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
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
import androidx.core.view.isVisible
import com.roomtalk.android.core.CrashLog
import com.roomtalk.android.net.RoomSession
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer

/**
 * 三屏一浮层，全靠 visibility 切换：
 *
 *   gate（输入口令） → room（聊天 + 发起通话） → call（全屏通话） → 来电浮层
 *
 * 不用 Fragment：三屏之间没有各自独立的状态要保存，切来切去只是显示/隐藏，
 * 用 Fragment 事务反而要处理「回来时视图被重建、渲染器 EGL 上下文失效」这类麻烦。
 */
class MainActivity : AppCompatActivity(), RoomSession.Cb {

    private lateinit var session: RoomSession

    /* ---------------- 各屏的视图 ---------------- */

    private lateinit var screenGate: View
    private lateinit var screenRoom: View
    private lateinit var screenCall: View
    private lateinit var ringOverlay: View
    private lateinit var toastView: TextView

    private lateinit var passInput: EditText

    private lateinit var peerInfo: TextView
    private lateinit var statusText: TextView
    private lateinit var msgList: LinearLayout
    private lateinit var msgScroll: ScrollView
    private lateinit var msgInput: EditText

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

        peerInfo = findViewById(R.id.peerInfo)
        statusText = findViewById(R.id.statusText)
        msgList = findViewById(R.id.msgList)
        msgScroll = findViewById(R.id.msgScroll)
        msgInput = findViewById(R.id.msgInput)

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
        msgScroll.post { msgScroll.fullScroll(View.FOCUS_DOWN) }
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

    /* ============================== 通话按钮状态 ============================== */

    private fun updateMicIcon(on: Boolean) {
        btnMic.setImageResource(if (on) R.drawable.ic_mic else R.drawable.ic_mic_off)
        btnMic.setBackgroundResource(if (on) R.drawable.bg_call_btn else R.drawable.bg_call_btn_danger)
    }

    private fun updateCamIcon(on: Boolean) {
        btnCam.setImageResource(if (on) R.drawable.ic_videocam else R.drawable.ic_videocam_off)
        btnCam.setBackgroundResource(if (on) R.drawable.bg_call_btn else R.drawable.bg_call_btn_danger)
    }

    /** 免提开=正常；关（走听筒）=压暗。关掉不是出错，所以不用红色。 */
    private fun updateSpeakerIcon(on: Boolean) {
        btnSpeaker.alpha = if (on) 1f else 0.5f
    }

    /* ============================== RoomSession.Cb ============================== */

    override fun status(text: String) {
        statusText.text = text
    }

    override fun message(text: String, mine: Boolean) {
        addBubble(text, mine)
    }

    override fun peerInfo(text: String) {
        peerInfo.text = text.ifBlank { getString(R.string.waiting) }
        // 「小米 14 · 未开麦」→ 只要「小米 14」
        peerLabel = text.substringBefore(" · ").trim()
        if (screenCall.isVisible) {
            callTitle.text = peerNameOrFallback()
            callPeerBig.text = peerNameOrFallback()
        }
    }

    override fun callState(kind: String?) {
        if (kind == null) {
            hideCallUi()
            return
        }
        // 呼叫一发起就切到通话页：用户要立刻看见自己的画面 / 「正在呼叫…」
        if (!screenCall.isVisible) showCallUi(kind == "video")
        callStateText.text = if (session.inCallNow) getString(R.string.in_call) else getString(R.string.calling)
        btnCam.isVisible = kind == "video"
    }

    override fun ringing(kind: String, name: String) {
        ringName.text = name.ifBlank { "对方" }
        ringTitle.text = getString(if (kind == "video") R.string.ring_video else R.string.ring_audio)
        ringOverlay.isVisible = true
    }

    override fun ringDismissed() {
        ringOverlay.isVisible = false
    }

    override fun callLive(kind: String, hasRemoteVideo: Boolean) {
        if (!screenCall.isVisible) showCallUi(kind == "video")
        ensureRenderers()
        callStateText.text = getString(R.string.in_call)
        updateMicIcon(session.micOn)
        updateCamIcon(session.camOn)
        updateSpeakerIcon(session.speakerOn)
    }

    override fun timer(text: String) {
        callTimerTop.text = text
    }

    override fun stage(remoteMain: Boolean) {
        // 大小窗对调**不用动界面**：引擎那边只是把两条轨道换了个画布接
        // （见 PeerEngine.applyStage）。所以这里没有要做的事。
    }

    override fun attachRenderers() {
        ensureRenderers()
    }

    override fun flipAvailable(available: Boolean) {
        btnFlip.isVisible = available && callIsVideo
    }

    override fun host(isHost: Boolean) {
        // 产品约定：房主 = 第一个进房的人。只有他能请人出去 / 解除拉黑。
        amHost = isHost
        refreshTrustBar()
    }

    override fun trust(kind: String, text: String) {
        trustKind = kind
        trustMsg = text
        refreshTrustBar()
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
        showToast(text)
    }

    override fun backToGate(reason: String?) {
        resetToGate()
        if (!reason.isNullOrBlank()) showToast(reason)
    }
}
