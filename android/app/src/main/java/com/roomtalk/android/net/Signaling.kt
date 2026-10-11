package com.roomtalk.android.net

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.roomtalk.android.core.Wire
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 信令 WebSocket（wss）—— 只负责「连通、保活、自动重连」三件事。
 *
 * 业务层拿到的是解析好的 [JSONObject]，以及一个「连接又好了」的回调：
 * 重连成功后**必须重新 join**（服务端不认旧身份），那是调用方的事 ——
 * 所以这里回调 [onOpen] 而不是自己发 join，避免把两件事混在传输层。
 *
 * 保活刻意**不用** OkHttp 的 `pingInterval`：那是 WebSocket 协议级的 PING 帧，
 * 依赖运行时自动回 PONG；而服务端注册的是**应用层**的精确字符串自动应答
 * （`{"type":"ping"}` → `{"type":"pong"}`）。跟网页端保持一致，走应用层心跳。
 */
class Signaling(
    private val url: String,
    private val onOpen: () -> Unit,
    private val onMessage: (JSONObject) -> Unit,
    private val onLost: () -> Unit,
) {

    private val client = OkHttpClient.Builder()
        // 长连接不能有读超时，否则闲下来就被自己掐断
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val main = Handler(Looper.getMainLooper())

    private var ws: WebSocket? = null
    private var running = false
    private var attempt = 0
    private var pongMissed = false

    /** 开始（并在断开后自动）连接。 */
    fun start() {
        running = true
        attempt = 0
        open()
    }

    fun stop() {
        running = false
        main.removeCallbacksAndMessages(null)
        val w = ws
        ws = null
        try { w?.close(1000, "client-close") } catch (_: Throwable) { }
    }

    val isOpen: Boolean get() = ws != null

    fun send(text: String): Boolean = ws?.send(text) ?: false

    private fun open() {
        if (!running) return
        main.removeCallbacksAndMessages(null)
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                pongMissed = false
                main.post {
                    if (!running) return@post
                    onOpen()
                    schedulePing()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val obj = try { JSONObject(text) } catch (e: Exception) {
                    Log.w(TAG, "收到非 JSON 消息，已忽略", e)
                    return
                }
                // 保活回音在传输层就消化掉，不往业务层抛
                if (obj.optString("type") == "pong") {
                    pongMissed = false
                    return
                }
                main.post { if (running) onMessage(obj) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { retry("连接被关闭") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { retry(t.message ?: "连接失败") }
            }
        })
    }

    /**
     * 应用层心跳：每 25 秒一条。
     *
     * 上一轮心跳没等到 pong 就不再傻等 —— 直接判死重连。这个判断很重要：
     * 手机切网、进电梯时 TCP 可能既不报错也不关闭，表现为「界面还显示在线，
     * 但消息全发不出去」。没有这条判据，用户会一直对着一个假连接说话。
     */
    private fun schedulePing() {
        if (!running) return
        main.postDelayed({
            if (!running) return@postDelayed
            if (pongMissed) {
                Log.w(TAG, "心跳无应答，判定连接已死")
                retry("心跳无应答")
                return@postDelayed
            }
            pongMissed = true
            send(Wire.PING_RAW)
            schedulePing()
        }, PING_EVERY_MS)
    }

    private fun retry(why: String) {
        if (!running) return
        try { ws?.cancel() } catch (_: Throwable) { }
        ws = null
        main.removeCallbacksAndMessages(null)
        onLost()

        // 退避 1→2→4→8→16→20 秒封顶。产品对外承诺的是「20 秒内自动重连」，
        // 所以最后一档就压在 20 秒，不要再往上加。
        val delay = DELAYS[minOf(attempt, DELAYS.size - 1)]
        attempt++
        Log.i(TAG, "信令断开（$why），${delay}ms 后重连（第 $attempt 次）")
        main.postDelayed({ if (running) open() }, delay)
    }

    private companion object {
        const val TAG = "RoomTalk.Signal"
        const val PING_EVERY_MS = 25_000L
        val DELAYS = longArrayOf(1_000, 2_000, 4_000, 8_000, 16_000, 20_000)
    }
}
