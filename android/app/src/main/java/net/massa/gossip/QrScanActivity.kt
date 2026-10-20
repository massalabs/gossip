package net.massa.gossip

import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Size
import android.view.View
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.lang.ref.WeakReference
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Full-screen camera preview that finishes with the first QR code decoded.
 * In continuous mode it stays open and hands every new code to [onFrame]
 * (the frames of an animated code) until [finishContinuous].
 * Not exported: only reachable through [QrScannerPlugin].
 */
class QrScanActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_RESULT = "net.massa.gossip.qr.RESULT"
        const val EXTRA_CLOSE_LABEL = "net.massa.gossip.qr.CLOSE_LABEL"
        const val EXTRA_CONTINUOUS = "net.massa.gossip.qr.CONTINUOUS"

        /** Receives the codes of a continuous scan, on the analysis thread. */
        @Volatile
        var onFrame: ((String) -> Unit)? = null

        /** The scanner on screen, for the plugin's setStatus and finish. */
        @Volatile
        var current: WeakReference<QrScanActivity>? = null
    }

    private var continuous = false
    private var statusView: TextView? = null

    // Last code handed out in continuous mode: the camera reads the same
    // frame several times in a row.
    private var lastValue: String? = null

    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    // First decoded frame wins; later frames still in flight are dropped.
    private val done = AtomicBoolean(false)

    // Only QR: cheaper per frame and no accidental 1D-barcode matches.
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        continuous = intent.getBooleanExtra(EXTRA_CONTINUOUS, false)
        current = WeakReference(this)

        val previewView = PreviewView(this)
        val closeButton = TextView(this).apply {
            text = "✕"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            // The app language is chosen in-app, so JS sends the translated
            // label; the resource only covers a missing extra.
            contentDescription = intent.getStringExtra(EXTRA_CLOSE_LABEL)
                ?: getString(R.string.qr_scanner_close)
            setOnClickListener { finish() }
        }
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(previewView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(ViewfinderView(this@QrScanActivity), FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(closeButton, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START))
        }
        if (continuous) {
            val density = resources.displayMetrics.density
            val status = TextView(this).apply {
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                gravity = Gravity.CENTER
                val pad = (12 * density).toInt()
                setPadding(pad * 2, pad, pad * 2, pad)
                background = GradientDrawable().apply {
                    setColor(Color.argb(170, 0, 0, 0))
                    cornerRadius = 16 * density
                }
                visibility = View.GONE
                // Read out by TalkBack as it changes (progress, Bluetooth).
                accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            }
            val margin = (24 * density).toInt()
            root.addView(
                status,
                FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply {
                    setMargins(margin, 0, margin, margin * 2)
                },
            )
            ViewCompat.setOnApplyWindowInsetsListener(status) { v, insets ->
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                (v.layoutParams as FrameLayout.LayoutParams).bottomMargin = margin * 2 + bars.bottom
                insets
            }
            statusView = status
        }
        // Keep the close button below the status bar / camera cutout.
        ViewCompat.setOnApplyWindowInsetsListener(closeButton) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            (v.layoutParams as FrameLayout.LayoutParams).setMargins(bars.left, bars.top, 0, 0)
            insets
        }
        setContentView(root)
        startCamera(previewView)
    }

    private fun startCamera(previewView: PreviewView) {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            val preview = Preview.Builder().build().also {
                it.surfaceProvider = previewView.surfaceProvider
            }
            // CameraX analyses at 640x480 by default, too coarse for a small or
            // distant QR code. Ask for 1080p and let it fall back to the nearest
            // resolution the device actually supports.
            val analysisResolution = ResolutionSelector.Builder()
                .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                .setResolutionStrategy(
                    ResolutionStrategy(
                        Size(1920, 1080),
                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                    )
                )
                .build()
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setResolutionSelector(analysisResolution)
                .build()
                .also { it.setAnalyzer(analysisExecutor, ::decode) }
            try {
                val provider = providerFuture.get()
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (_: Exception) {
                // No usable back camera: hand control back to the caller.
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun decode(image: ImageProxy) {
        image.use {
            if (done.get()) return
            // Y plane of YUV_420_888 is full-resolution luminance, which is
            // all ZXing needs. rowStride can exceed width (padding), so pass
            // it as dataWidth and crop to the visible area.
            val plane = it.planes[0]
            val buffer = plane.buffer.also { b -> b.rewind() }
            val bytes = ByteArray(buffer.remaining()).also { b -> buffer.get(b) }
            val source = PlanarYUVLuminanceSource(
                bytes, plane.rowStride, it.height, 0, 0, it.width, it.height, false
            )
            val text = try {
                reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
            } catch (_: Exception) {
                // ZXing signals "no code in this frame" with exceptions.
                null
            } finally {
                reader.reset()
            }
            if (text == null) return
            if (continuous) {
                if (text != lastValue) {
                    lastValue = text
                    onFrame?.invoke(text)
                }
                return
            }
            if (done.compareAndSet(false, true)) {
                runOnUiThread {
                    setResult(RESULT_OK, Intent().putExtra(EXTRA_RESULT, text))
                    finish()
                }
            }
        }
    }

    /** Writes [text] over the camera of a continuous scan; empty hides it. */
    fun setStatus(text: String) {
        runOnUiThread {
            val view = statusView ?: return@runOnUiThread
            view.text = text
            view.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
        }
    }

    /** Ends a continuous scan: the caller has what it needed. */
    fun finishContinuous() {
        if (!done.compareAndSet(false, true)) return
        runOnUiThread {
            setResult(RESULT_OK, Intent().putExtra(EXTRA_RESULT, ""))
            finish()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (current?.get() === this) current = null
        analysisExecutor.shutdown()
    }
}

/**
 * Aiming guide only: dims everything outside a centred rounded square and
 * outlines it. Decoding still uses the whole frame.
 */
private class ViewfinderView(context: Context) : View(context) {
    private val dim = Paint().apply { color = Color.argb(140, 0, 0, 0) }
    private val frame = Paint().apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 3f * resources.displayMetrics.density
        isAntiAlias = true
    }
    private val path = Path()

    override fun onDraw(canvas: Canvas) {
        val side = minOf(width, height) * 0.7f
        val left = (width - side) / 2f
        val top = (height - side) / 2f
        val box = RectF(left, top, left + side, top + side)
        val radius = 24f * resources.displayMetrics.density

        path.reset()
        path.addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW)
        path.addRoundRect(box, radius, radius, Path.Direction.CCW)
        path.fillType = Path.FillType.EVEN_ODD
        canvas.drawPath(path, dim)
        canvas.drawRoundRect(box, radius, radius, frame)
    }
}
