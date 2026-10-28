package net.massa.gossip

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The native side of the auto-lock ([AppLock]). The app calls `configure`
 * with the timeout while an account is open and with null once none is.
 */
@CapacitorPlugin(name = "AppLock")
class AppLockPlugin : Plugin() {

    @PluginMethod
    fun configure(call: PluginCall) {
        val timeout = if (call.data.isNull("timeoutSeconds")) null else call.getInt("timeoutSeconds")
        AppLock.configure(context, timeout)
        call.resolve()
    }

    /** Locks now as the background auto-lock would: mesh, storage, then the activity. */
    @PluginMethod
    fun lockNow(call: PluginCall) {
        call.resolve()
        AppLock.lock(context)
    }

    override fun handleOnPause() {
        AppLock.onBackground(context)
    }

    // Before the window shows again, and once more on resume.
    override fun handleOnRestart() {
        AppLock.onForeground(context)
    }

    override fun handleOnResume() {
        AppLock.onForeground(context)
    }
}
