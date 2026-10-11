package com.roomtalk.android.core

import java.io.File
import java.util.Locale

/**
 * 传输用到的几个纯函数。
 *
 * 单独拎出来是因为收发两侧都要用（接收端给**对方**递来的名字洗路径，发送端给自己
 * 选中的文件洗名字），两处各写一份必然慢慢长出差异 —— 而其中一份是安全相关
 * （防目录穿越），差异化的后果是「有一侧的洞没堵上」。
 */

/**
 * 把外部递来的文件名洗成能安全落在某个目录里的名字。
 *
 * 两道清洗，缺一不可：
 *   · **去掉路径**：只取最后一段。`../../databases/x` 这种名字如果在拼接时
 *     没被拦，就能把文件写到目标目录**外面**去。
 *   · **去掉控制字符与文件系统保留字符**：`\n` 会让文件名在列表里变成两行、
 *     `:` `*` `?` 在某些文件系统上直接建不出来。
 *
 * 另外去掉开头的点：`.` 开头的文件在安卓上是隐藏文件，用户收到之后会找不到。
 */
fun safeFileName(raw: String): String {
    val flat = raw.replace('\\', '/').substringAfterLast('/')
    val cleaned = flat.map { c ->
        if (c.isISOControl() || c == ':' || c == '*' || c == '?' || c == '"' ||
            c == '<' || c == '>' || c == '|'
        ) '_' else c
    }.joinToString("").trim().trimStart('.')
    // 120 个字符对文件系统够宽，又不至于让界面上的名字长到没法看
    return cleaned.take(120).ifBlank { "文件" }
}

/**
 * 同名不覆盖：`报告.pdf` 已经有了就写 `报告(1).pdf`。
 *
 * ⚠ 必须是「新建文件」的语义。如果直接用同名覆盖，用户收到第二份同名文件时
 *   第一份就没了 —— 而聊天记录里两条气泡指着同一个路径，点哪条都是新内容。
 */
fun uniqueFileIn(dir: File, name: String): File {
    val first = File(dir, name)
    if (!first.exists()) return first
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    for (i in 1..999) {
        val f = File(dir, "$stem($i)$ext")
        if (!f.exists()) return f
    }
    // 999 个重名还没轮到，那就交给时间戳，别再往后数了
    return File(dir, "$stem-${System.currentTimeMillis()}$ext")
}

/**
 * 一行看得懂的体积。
 *
 * ⚠ 显式给 Locale.US：有些地区的数字分隔符是逗号，`%.1f` 会算出「1,5 MB」，
 *   看着像「一千五百 MB」。体积是给人对照的，不该随系统语言变形。
 */
fun fmtBytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", n / 1024.0)
    else -> String.format(Locale.US, "%.1f MB", n / (1024.0 * 1024.0))
}

/** 语音时长 `0:07`。最小值锁 1 秒 —— 显示 `0:00` 会让人以为这条是空的。 */
fun fmtDur(ms: Long): String {
    val s = maxOf(1L, Math.round(ms / 1000.0))
    return "${s / 60}:${String.format(Locale.US, "%02d", s % 60)}"
}
