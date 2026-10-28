package net.massa.gossip.share

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pGroup
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.security.SecureRandom

/**
 * A Wi-Fi Direct group that phones without Gossip can join as an ordinary
 * Wi-Fi network: this phone is the group owner and serves the APK on it. It
 * needs Wi-Fi switched on, not connected, and works with no internet at all.
 * Bluetooth and the mesh keep running beside it.
 */
class ApkHotspot(private val context: Context, private val onLost: () -> Unit) {

    data class Network(val ssid: String, val passphrase: String, val address: InetAddress)

    class Failure(val code: String, message: String) : Exception(message)

    private val handler = Handler(Looper.getMainLooper())
    private val manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private var channel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null
    private var running = false

    /** Calls back on the main thread once the group is up with an address. */
    @SuppressLint("MissingPermission") // the plugin checks the Wi-Fi permission first
    fun start(callback: (Result<Network>) -> Unit) {
        handler.post {
            val p2p = manager
            if (p2p == null) {
                callback(Result.failure(Failure(UNSUPPORTED, "Wi-Fi Direct is not available")))
                return@post
            }
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            if (!wifi.isWifiEnabled) {
                callback(Result.failure(Failure(WIFI_OFF, "Wi-Fi is off")))
                return@post
            }
            stopNow()
            val ch = p2p.initialize(context, Looper.getMainLooper()) { if (running) lost() }
            channel = ch
            running = true
            listenForWifiOff()
            createGroup(p2p, ch, retried = false, callback)
        }
    }

    fun stop() {
        handler.post { stopNow() }
    }

    @SuppressLint("MissingPermission")
    private fun createGroup(
        p2p: WifiP2pManager,
        ch: WifiP2pManager.Channel,
        retried: Boolean,
        callback: (Result<Network>) -> Unit,
        frequency: Int? = sharedFrequency(),
    ) {
        val listener = object : WifiP2pManager.ActionListener {
            override fun onSuccess() = awaitGroup(p2p, ch, System.currentTimeMillis(), callback)

            override fun onFailure(reason: Int) {
                if (!running) return
                // BUSY: a group is already up, often one we left behind
                if (reason == WifiP2pManager.BUSY && !retried) {
                    p2p.removeGroup(ch, object : WifiP2pManager.ActionListener {
                        override fun onSuccess() = createGroup(p2p, ch, true, callback, frequency)
                        override fun onFailure(r: Int) = createGroup(p2p, ch, true, callback, frequency)
                    })
                    return
                }
                // the chip may refuse the router's channel: let it pick one
                if (frequency != null) {
                    createGroup(p2p, ch, retried, callback, frequency = null)
                    return
                }
                stopNow()
                val code = if (reason == WifiP2pManager.P2P_UNSUPPORTED) UNSUPPORTED else FAILED
                callback(Result.failure(Failure(code, "Wi-Fi Direct group failed ($reason)")))
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val builder = WifiP2pConfig.Builder()
                .setNetworkName("DIRECT-${randomString(2)}-Gossip")
                .setPassphrase(randomString(PASSPHRASE_LENGTH))
                .enablePersistentMode(false)
            if (frequency != null) {
                builder.setGroupOperatingFrequency(frequency)
            } else {
                // 2.4 GHz: every phone can join it
                builder.setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ)
            }
            p2p.createGroup(ch, builder.build(), listener)
        } else {
            p2p.createGroup(ch, listener)
        }
    }

    /**
     * The channel of the Wi-Fi network this phone is on, if the group can
     * share it. On another channel the radio hops between the two and the
     * download crawls or stalls. Only 2.4 GHz and the non-DFS 5 GHz channels
     * can host a group.
     */
    private fun sharedFrequency(): Int? {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val frequency = wifi.connectionInfo?.frequency ?: return null
        return frequency.takeIf { it in 2412..2472 || it in 5180..5240 || it in 5745..5825 }
    }

    /** The group forms after createGroup succeeds; poll until it has an address. */
    @SuppressLint("MissingPermission")
    private fun awaitGroup(
        p2p: WifiP2pManager,
        ch: WifiP2pManager.Channel,
        since: Long,
        callback: (Result<Network>) -> Unit,
    ) {
        if (!running) return
        p2p.requestGroupInfo(ch) { group: WifiP2pGroup? ->
            if (!running) return@requestGroupInfo
            val address = group?.takeIf { it.isGroupOwner }?.let { ownerAddress(it) }
            if (group != null && address != null && !group.passphrase.isNullOrEmpty()) {
                callback(Result.success(Network(group.networkName, group.passphrase, address)))
            } else if (System.currentTimeMillis() - since > GROUP_TIMEOUT_MS) {
                stopNow()
                callback(Result.failure(Failure(FAILED, "The Wi-Fi Direct group did not form")))
            } else {
                handler.postDelayed({ awaitGroup(p2p, ch, since, callback) }, POLL_MS)
            }
        }
    }

    private fun ownerAddress(group: WifiP2pGroup): InetAddress? {
        val name = group.`interface` ?: return null
        return try {
            NetworkInterface.getByName(name)?.inetAddresses?.toList()
                ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
        } catch (e: Exception) {
            Log.w(TAG, "No address on $name", e)
            null
        }
    }

    private fun listenForWifiOff() {
        val filter = IntentFilter(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                val state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1)
                if (state == WifiP2pManager.WIFI_P2P_STATE_DISABLED && running) lost()
            }
        }
        ContextCompat.registerReceiver(context, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiver = r
    }

    private fun lost() {
        stopNow()
        onLost()
    }

    private fun stopNow() {
        running = false
        handler.removeCallbacksAndMessages(null)
        receiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (_: IllegalArgumentException) {
            }
        }
        receiver = null
        val ch = channel ?: return
        channel = null
        manager?.removeGroup(ch, null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) ch.close()
    }

    private val random = SecureRandom()

    private fun randomString(length: Int): String =
        String(CharArray(length) { ALPHABET[random.nextInt(ALPHABET.length)] })

    companion object {
        private const val TAG = "ApkHotspot"
        const val WIFI_OFF = "WIFI_OFF"
        const val UNSUPPORTED = "UNSUPPORTED"
        const val FAILED = "FAILED"
        private const val PASSPHRASE_LENGTH = 10
        private const val GROUP_TIMEOUT_MS = 15_000L
        private const val POLL_MS = 500L
        // no 0/O, 1/I/l, 5/S: the password may be typed by hand
        private const val ALPHABET = "abcdefghjkmnpqrtuvwxyz2346789"
    }
}
