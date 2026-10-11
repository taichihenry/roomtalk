package com.roomtalk.android.core

import android.content.Context
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
     * 「自动请出」。默认开 —— 防的是「被请出去的人又摸回来」。
     * 误请过人之后可以关掉，把对方放回来。
     */
    var autoKick: Boolean
        get() = sp.getBoolean(KEY_AUTOKICK, true)
        set(value) {
            sp.edit().putBoolean(KEY_AUTOKICK, value).apply()
        }

    private companion object {
        const val KEY_DID = "did"
        const val KEY_AUTOKICK = "autokick"
        const val MAX_BLOCK = 20
    }
}
