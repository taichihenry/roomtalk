package com.roomtalk.android.core

import android.content.Context
import android.util.Log
import java.util.UUID

/**
 * 设备身份与信任记忆（TOFU：Trust On First Use）。
 *
 * 解决的是纯口令方案唯一的硬伤：**口令只证明「知道这串字」，不证明「你是这个人」**。
 * 如果 A/B 和 C/D 碰巧约定了同一串口令，A 光看口令没法分辨进来的是 B 还是 C ——
 * 这不是实现缺陷，是信息论层面的必然：两个人的知识完全相同时无法区分。
 *
 * 所以网页端退一步，用「设备标识」做一层**弱**身份：
 *   ① 每台设备有一个难以猜中的随机串（存在本地，跨会话不变）；
 *   ② 进房时双方互相递名片；
 *   ③ 用户可以对「第一次见到的设备」点一下「记住」；
 *   ④ 下次进来如果名片对不上，就明确警告，并给出「请出房间」的入口。
 *
 * ⚠ 它**不是密码学身份**：不像密钥那样能证明「我就是我」，只是一个难以猜中的
 *   随机串。这是共享口令方案能做到的上限，别把它宣传成「认证」。
 *
 * ⚠ 拉黑名单是**本机**的、按房间存的（和网页端 localStorage 的行为一致）。
 *   服务端没有任何拉黑概念，它只认 `kick` 这一个动作 —— 换台设备就换了一份名单。
 */
class Trust(context: Context) {

    private val sp = context.getSharedPreferences("rt_trust", Context.MODE_PRIVATE)

    /**
     * 本机设备标识。
     *
     * ⚠ **必须持久化**，不能每次启动重新生成：对方一旦点过「记住这台设备」，
     *   我们下次报一个不同的名字，对方就会看到「⚠️ 对方换了一台设备」的**误报**。
     *   狼来了几次之后，真正该警惕的那次也没人信了。
     */
    fun deviceId(): String {
        val cur = sp.getString(KEY_DID, null)
        if (!cur.isNullOrBlank()) return cur
        val v = UUID.randomUUID().toString()
        sp.edit().putString(KEY_DID, v).apply()
        return v
    }

    /**
     * 信令连接身份。服务端拿它认出「这是你自己上一次的那条连接」。
     *
     * ⚠ **必须持久化，而且必须与 [deviceId] 分开**：
     *
     *   · 持久化 —— 服务端在房间满时会先踢掉「clientId 与自己相同」的旧连接
     *     （见 cloudflare/src/room.js 的 _join）。若每次进程重启都换一个随机串，
     *     这套机制永远不会触发：崩溃 / 强杀留下的半死连接（TCP 假死，readyState
     *     仍是 1）会一直占着 2 人房的名额，用户明明一个人，却被回一句
     *     「这个口令已经被两个人占用了」。网页端的等价物是 sessionStorage 的 rt.cid。
     *
     *   · 分开 —— clientId 是明文交给**服务器**的；deviceId 是给**对端**看的名片。
     *     两者一旦共用，服务器就能把「哪条连接」和「哪台设备」对上号。对一个
     *     卖点就是「服务器不知道你们是谁」的产品，这是白送的额外信息，不该给。
     */
    fun clientId(): String {
        val cur = sp.getString(KEY_CID, null)
        if (!cur.isNullOrBlank()) return cur
        val v = UUID.randomUUID().toString()
        sp.edit().putString(KEY_CID, v).apply()
        return v
    }

    /** 这个房间里我记住的那台设备（null = 第一次）。 */
    fun trusted(room: String): String? = sp.getString("trust.$room", null)

    fun setTrusted(room: String, id: String) {
        if (id.isBlank()) return
        sp.edit().putString("trust.$room", id).apply()
    }

    /** 这个房间里被我请出去过的设备。 */
    fun blocked(room: String): List<String> =
        sp.getString("block.$room", null)
            ?.split(',')
            ?.map { it.trim() }
            ?.filter { it.isNotBlank() }
            ?: emptyList()

    fun addBlocked(room: String, id: String) {
        if (id.isBlank()) return
        val list = blocked(room).toMutableList()
        if (list.contains(id)) return
        list.add(id)
        // 只留最近 20 条，和网页端一致 —— 本地存储不该无限长
        val trimmed = if (list.size > MAX_BLOCK) list.subList(list.size - MAX_BLOCK, list.size) else list
        sp.edit().putString("block.$room", trimmed.joinToString(",")).apply()
    }

    fun clearBlocked(room: String) {
        sp.edit().remove("block.$room").apply()
    }

    /**
     * 把这个房间留在本机的东西全部抹掉。
     *
     * 口令是共享秘密，而房间号是它的派生值 —— 同一串口令永远落到同一间房，也就
     * 永远落到同一组 `trust.<room>` / `block.<room>` 上。于是「上一拨人用完走了、
     * 下一拨人拿同一口令开房」时，后来的人会踩到前一拨人的记忆：轻则把熟人认成
     * 陌生人，重则让一台素不相识的设备因为落在旧黑名单里被**自动请出**（对方只会
     * 看到自己莫名其妙被踢）。
     *
     * ⚠ 只清**按房间**的那两条。[deviceId]、[clientId]、[autoKick] 都是**设备级**的，
     *   跟进哪个房间无关 —— 一并清掉等于让设备改名，反倒会给对方制造
     *   「对方换了一台设备」的误报。
     *
     * 代价是明确的、也已确认过：「记住这台设备」的跨会话保护随之失效，下次进同一个
     * 房间会被当作第一次见。隐私优先的取舍。
     */
    fun wipeRoom(room: String) {
        if (room.isBlank()) return
        sp.edit().remove("trust.$room").remove("block.$room").apply()
        // 留一行日志**不是为了调试、是为了能被验证**：这条路径（离房清空）在真机上
        // 只能靠日志看到它真的跑了 —— 界面上的效果是「什么都没发生」。
        // 出了「我怎么又把你当陌生人了」这种反馈时，也能一眼确认是不是这条路径导致的。
        Log.i(TAG, "已清除本房间的记忆 room=${room.take(8)}…")
    }

    /**
     * 「自动请出」。默认开 —— 防的是「被请出去的人又摸回来」。
     * 误请过人之后可以关掉，把对方放回来。
     */
    var autoKick: Boolean
        get() = sp.getBoolean(KEY_AUTOKICK, true)
        set(value) {
            sp.edit().putBoolean(KEY_AUTOKICK, value).apply()
        }

    private companion object {
        const val TAG = "RoomTalk.Trust"
        const val KEY_DID = "did"
        const val KEY_CID = "cid"
        const val KEY_AUTOKICK = "autokick"
        const val MAX_BLOCK = 20
    }
}
