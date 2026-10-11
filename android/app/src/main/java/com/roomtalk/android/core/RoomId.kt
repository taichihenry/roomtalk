package com.roomtalk.android.core

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 口令 → 房间号。
 *
 * ⚠ 这个函数必须和网页端 `public/app.js` 的 `deriveRoomId()` **逐位一致**，
 *   否则两端算出来是两间房，永远碰不上。网页端的定义是：
 *
 *     PBKDF2(口令, salt = "roomtalk/v1", iterations = 100000,
 *            hash = SHA-256, dkLen = 16 字节) → 小写十六进制
 *
 *   单元测试里钉了几个用 Node 的 crypto 算出来的参考值，改坏了会当场失败。
 *
 * 为什么手写 PBKDF2 而不用 `SecretKeyFactory("PBKDF2WithHmacSHA256")`：
 * 那个算法名在 Android 上 **API 26 才加进去**，本 App 的 minSdk 是 24，
 * 在 24/25 上会直接抛 NoSuchAlgorithmException。下面这份只用 `Mac("HmacSHA256")`，
 * 所有 API 版本都有，且能跑在桌面 JVM 上做单元测试。
 */
object RoomId {

    private const val SALT = "roomtalk/v1"
    private const val ITERATIONS = 100_000
    private const val DK_LEN = 16

    /** @return 32 位小写十六进制字符串（就是服务端认的房间号） */
    fun derive(passphrase: String): String {
        val dk = pbkdf2HmacSha256(
            passphrase.toByteArray(Charsets.UTF_8),
            SALT.toByteArray(Charsets.UTF_8),
            ITERATIONS,
            DK_LEN,
        )
        val sb = StringBuilder(dk.size * 2)
        for (b in dk) {
            // 不能写成 "%02x".format(b)：Byte 是有符号的，这里显式按无符号取
            val v = b.toInt() and 0xFF
            if (v < 0x10) sb.append('0')
            sb.append(v.toString(16))
        }
        return sb.toString()
    }

    /** PBKDF2-HMAC-SHA256（RFC 8018）。dcLen 小于一个哈希块时也走同一条路径，不做特化。 */
    private fun pbkdf2HmacSha256(
        password: ByteArray,
        salt: ByteArray,
        iterations: Int,
        dkLen: Int,
    ): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password, "HmacSHA256"))
        val hLen = mac.macLength                       // 32
        val blocks = (dkLen + hLen - 1) / hLen
        val out = ByteArray(blocks * hLen)
        val index = ByteArray(4)

        for (i in 1..blocks) {
            index[0] = (i ushr 24).toByte()
            index[1] = (i ushr 16).toByte()
            index[2] = (i ushr 8).toByte()
            index[3] = i.toByte()

            mac.update(salt)
            mac.update(index)
            var u = mac.doFinal()                      // U1
            val t = u.copyOf()                         // T = U1

            // doFinal 之后 Mac 会回到刚 init 的状态（密钥还在），所以循环里
            // 直接 doFinal(上一轮的 U) 就是 HMAC(密码, U)，正是 PBKDF2 要的。
            for (c in 2..iterations) {
                u = mac.doFinal(u)
                for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
            }
            System.arraycopy(t, 0, out, (i - 1) * hLen, hLen)
        }
        return out.copyOf(dkLen)
    }
}
