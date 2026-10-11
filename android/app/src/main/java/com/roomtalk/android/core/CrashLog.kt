package com.roomtalk.android.core

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 崩溃自留地。
 *
 * 为什么需要它：这个 App 是「网页上点一下就下载安装」分发的，**没有应用商店的崩溃收集**，
 * 用户也不可能为了报个 bug 去开发者选项里开 USB 调试、再用 adb 抓 logcat。
 * 结果就是「一闪就退，什么都没留下」—— 除了让用户再猜一次，什么也修不了。
 *
 * 所以崩溃必须**自己记下来**：
 *   · 进程死之前，把完整堆栈 + 机型/系统/架构/版本写进 `filesDir/crash-last.txt`
 *   · 用户重开一次 App，界面直接把这份记录摆出来，点一下就复制走
 *
 * ⚠ 只记**最后一次**，不追加。崩溃日志的价值在于「最近一次到底怎么死的」，
 *   堆一屋子历史记录只会让用户不知道该发哪一段。
 *
 * ⚠ 这里只能接住 **Java/Kotlin 层**的未捕获异常。native（SIGSEGV 之类）崩溃
 *   走不到这里 —— 那种情况得靠 `adb logcat` 或 tombstone。
 */
object CrashLog {

    private const val FILE_NAME = "crash-last.txt"

    @Volatile
    private var installed = false

    /** 装上兜底处理器。**越早越好** —— 放在 `Application`/`Activity.onCreate` 的最前面。 */
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        val prev = Thread.getDefaultUncaughtExceptionHandler()

        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            // 写日志本身绝不能再抛异常，否则会把真正的崩溃原因盖掉
            try {
                File(app.filesDir, FILE_NAME).writeText(describe(app, thread, error))
            } catch (_: Throwable) {
            }
            // 交回系统默认处理：进程该照常死掉。这里**不能**假装没事继续跑 ——
            // 那会让应用停在一个「状态已经错乱」的界面上，比直接退更糟。
            if (prev != null) {
                prev.uncaughtException(thread, error)
            } else {
                Process.killProcess(Process.myPid())
            }
        }
    }

    /** 上一次崩溃的记录（没有则 null）。 */
    fun last(context: Context): String? {
        val f = File(context.filesDir, FILE_NAME)
        if (!f.exists()) return null
        return try {
            f.readText().ifBlank { null }
        } catch (_: Throwable) {
            null
        }
    }

    fun clear(context: Context) {
        try {
            File(context.filesDir, FILE_NAME).delete()
        } catch (_: Throwable) {
        }
    }

    private fun describe(app: Context, thread: Thread, error: Throwable): String {
        val sw = StringWriter()
        error.printStackTrace(PrintWriter(sw))
        val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
        return buildString {
            appendLine("时间    : $ts")
            appendLine("线程    : ${thread.name}")
            appendLine("异常    : ${error.javaClass.name}")
            appendLine("信息    : ${error.message ?: "(无)"}")
            appendLine("机型    : ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("系统    : Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            appendLine("ABI     : ${Build.SUPPORTED_ABIS.joinToString(", ")}")
            appendLine("App 版本: ${versionName(app)}")
            appendLine("-".repeat(48))
            appendLine(sw.toString())
        }
    }

    private fun versionName(app: Context): String = try {
        val pm = app.packageManager
        @Suppress("DEPRECATION")
        pm.getPackageInfo(app.packageName, 0).versionName ?: "?"
    } catch (_: Throwable) {
        "?"
    }
}
