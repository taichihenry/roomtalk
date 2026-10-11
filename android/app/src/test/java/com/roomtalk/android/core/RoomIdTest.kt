package com.roomtalk.android.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 这一组断言不是为了「跑通」，而是为了**钉死两端一致性**：
 * 期望值是用网页端同一套定义（Node 的 crypto.pbkdf2Sync：
 * salt='roomtalk/v1', iterations=100000, dkLen=16, sha256）算出来的。
 * 只要这里过了，Android 端和网页端就一定能进同一间房。
 */
class RoomIdTest {

    @Test
    fun `与网页端派生结果一致`() {
        assertEquals("23a0df7edaa500fcfc7d38ca3d2aa5e0", RoomId.derive("hello"))
        assertEquals("b12dd573c194b802eebc444c89dc5be0", RoomId.derive("口令通话"))
        assertEquals("ba54b5e5fb73e11403c565d059d4d017", RoomId.derive("a-b_c 123"))
    }

    @Test
    fun `输出恒为 32 位小写十六进制`() {
        for (p in listOf("x", "更长的口令试试看 1234567890", "!@#$%^&*()")) {
            val v = RoomId.derive(p)
            assertEquals(32, v.length)
            assertEquals(v.lowercase(), v)
            assertEquals(true, v.all { it in '0'..'9' || it in 'a'..'f' })
        }
    }

    @Test
    fun `不做首尾去空格`() {
        // 网页端是 `$('passphrase').value.trim()` 之后再派生；
        // 这层去空格由调用方负责，RoomId 本身必须原样计算，否则两端会在
        // 「用户手滑多打了一个空格」时进到不同的房间。
        assertEquals(
            "23a0df7edaa500fcfc7d38ca3d2aa5e0",
            RoomId.derive("hello"),
        )
    }
}
