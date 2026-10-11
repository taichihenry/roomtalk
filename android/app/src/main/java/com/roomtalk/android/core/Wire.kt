package com.roomtalk.android.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * 信令服务器地址。
 *
 * 用 punycode 写「8.中国」而不是直接写中文域名：证书和 DNS 本来存的就是
 * punycode 形式，用 ASCII 形式可以完全绕开 IDN 在不同实现里「转不转、怎么转」
 * 的差异 —— 服务器那边也把 punycode 当作规范形式，不会触发 301。
 */
const val SIGNAL_URL = "wss://8.xn--fiqs8s/ws"

/**
 * 与网页端共享的线协议。
 *
 * ⚠ 这些字符串是与服务端 / 网页端**逐字**约定的，改任何一处都要两端同时改，
 *   否则会静默失效（没有报错，只是「连不上」或「消息石沉大海」）。
 */
object Wire {

    /** 保活消息。必须**逐字**是这样：服务端注册的是精确字符串匹配的自动应答，
     *  差一个空格就会退化成「每次心跳都唤醒 Durable Object」，白白烧额度。 */
    const val PING_RAW = "{\"type\":\"ping\"}"

    /* ---------------- 客户端 → 服务端 ---------------- */
    const val T_JOIN = "join"
    const val T_LEAVE = "leave"
    const val T_SIGNAL = "signal"
    const val T_KICK = "kick"
    const val T_RENAME = "rename"

    /* ---------------- 服务端 → 客户端 ---------------- */
    const val T_SELF = "self"
    const val T_ROOM_JOINED = "room-joined"
    const val T_HOST = "host"
    const val T_ROOM_ERROR = "room-error"
    const val T_PEERS = "peers"
    const val T_PEER_JOINED = "peer-joined"
    const val T_PEER_LEFT = "peer-left"
    const val T_KICKED = "kicked"
    const val T_SIG = "sig"
    const val T_PEER_RENAMED = "peer-renamed"

    /** peer-left 的原因：主动退房（不会回来了） / 连接断开（可能还会重连回来） */
    const val REASON_LEAVE = "leave"

    fun join(room: String, clientId: String, name: String): String =
        JSONObject()
            .put("type", T_JOIN)
            .put("room", room)
            .put("clientId", clientId)
            .put("name", name.take(24))
            .toString()

    fun leave(room: String): String =
        JSONObject().put("type", T_LEAVE).put("room", room).toString()

    fun rename(name: String): String =
        JSONObject().put("type", T_RENAME).put("name", name.take(24)).toString()

    fun kick(room: String, peerId: String): String =
        JSONObject().put("type", T_KICK).put("room", room).put("peerId", peerId).toString()

    /** SDP：payload 形如 {"description":{"type":"offer","sdp":"..."}} */
    fun signalDescription(room: String, to: String, type: String, sdp: String): String =
        signal(room, to, JSONObject().put("description", JSONObject().put("type", type).put("sdp", sdp)))

    /** ICE 候选：payload 形如 {"candidate":{"candidate":"...","sdpMid":..,"sdpMLineIndex":..}} */
    fun signalCandidate(
        room: String,
        to: String,
        candidate: String,
        sdpMid: String?,
        sdpMLineIndex: Int?,
    ): String {
        val c = JSONObject().put("candidate", candidate)
        sdpMid?.let { c.put("sdpMid", it) }
        sdpMLineIndex?.let { c.put("sdpMLineIndex", it) }
        return signal(room, to, JSONObject().put("candidate", c))
    }

    private fun signal(room: String, to: String, payload: JSONObject): String =
        JSONObject()
            .put("type", T_SIGNAL)
            .put("room", room)
            .put("to", to)
            .put("payload", payload)
            .toString()

    /**
     * 服务端下发的 iceServers，形如 `[{"urls":"stun:a"}, {"urls":["stun:b","stun:c"]}]`
     * （我们只拿得到 STUN，没有 TURN）。
     */
    fun parseIceServers(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        val out = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            val urls = arr.optJSONObject(i)?.opt("urls") ?: continue
            when (urls) {
                is String -> out.add(urls)
                is JSONArray -> for (j in 0 until urls.length()) out.add(urls.optString(j))
            }
        }
        return out.filter { it.isNotBlank() }
    }
}

/**
 * DataChannel 上的（端到端、不经服务器的）消息类型。
 * 与网页端 `bindDataChannel` 里的 `m.t === '...'` 一一对应。
 */
object Dc {
    const val T_MSG = "msg"
    const val T_MEDIA = "media"
    const val T_ID = "id"
    const val T_RING = "ring"
    const val T_RING_ANSWER = "ring-answer"
    const val T_BYE = "bye"

    fun msg(text: String) = JSONObject().put("t", T_MSG).put("text", text).toString()

    fun media(audio: Boolean, video: Boolean, quality: String) = JSONObject()
        .put("t", T_MEDIA)
        .put("media", JSONObject().put("audio", audio).put("video", video))
        .put("quality", quality)
        .toString()

    fun identity(id: String) = JSONObject().put("t", T_ID).put("id", id).toString()

    fun ring(kind: String, name: String) =
        JSONObject().put("t", T_RING).put("kind", kind).put("name", name).toString()

    fun ringAnswer(kind: String, accept: Boolean) =
        JSONObject().put("t", T_RING_ANSWER).put("kind", kind).put("accept", accept).toString()

    fun bye() = JSONObject().put("t", T_BYE).toString()
}
