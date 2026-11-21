package net.massa.gossip.share

import android.content.Context
import java.io.File

/**
 * The APK this copy of Gossip was installed from, when another phone can
 * install it alone. A Play Store install is split by ABI and density: its
 * base APK is incomplete, so it cannot be shared.
 */
object ShareableApk {

    const val FILE_NAME = "Gossip.apk"

    /** The installed APK, or null when the install is split. */
    fun installed(context: Context): File? {
        val info = context.applicationInfo
        if (!info.splitSourceDirs.isNullOrEmpty()) return null
        return File(info.sourceDir).takeIf { it.isFile && it.canRead() }
    }

    fun versionName(context: Context): String =
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
}
