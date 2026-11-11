package app.sweepmeter

import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONObject

/** JavaScript interface exposed as window.Native. All callbacks go to window.on* handlers. */
class NativeBridge(
    private val activity: MainActivity,
    private val webView: WebView,
    private val engine: MeasurementEngine,
    private val generator: SignalGenerator,
    private val live: LiveInput,
    private val devices: AudioDevices
) {

    @JavascriptInterface
    fun info(): String = JSONObject()
        .put("sampleRate", engine.sampleRate)
        .put("source", engine.inputSource.label)
        .put("version", activity.versionName)
        .toString()

    @JavascriptInterface
    fun devices(): String = devices.toJson().toString()

    /** Device ids from devices(); 0 restores the system default. */
    @JavascriptInterface
    fun setDevices(inputId: Int, outputId: Int) {
        devices.inputId = inputId
        devices.outputId = outputId
    }

    /** Plays the sweep and records. Returns "ok", "permission" or "busy". */
    @JavascriptInterface
    fun measure(json: String): String {
        val o = JSONObject(json)
        val params = MeasurementEngine.Params(
            f1 = o.getDouble("f1"),
            f2 = o.getDouble("f2"),
            durationSec = o.getDouble("dur"),
            level = o.getDouble("level").toFloat().coerceIn(0f, 1f),
            preRollSec = o.getDouble("preRoll"),
            tailSec = o.getDouble("tail")
        )
        return startCapture { listener -> engine.start(params, listener) }
    }

    /** Records only, e.g. a tapped glass. Returns "ok", "permission" or "busy". */
    @JavascriptInterface
    fun listen(durationSec: Double): String = startCapture { listener ->
        engine.listen(durationSec.coerceIn(MIN_LISTEN_SEC, MAX_LISTEN_SEC), listener)
    }

    /** Streams microphone blocks to window.onLiveData(base64 float32). */
    @JavascriptInterface
    fun liveStart(): String {
        if (!activity.hasMicPermission()) {
            activity.runOnUiThread { activity.requestMicPermission() }
            return "permission"
        }
        if (engine.isBusy) return "busy"
        val started = live.start(
            sink = { block -> callJs("onLiveData", "'${encode(block)}'") },
            onError = { message -> callJs("onLiveError", JSONObject.quote(message)) }
        )
        if (started) activity.setKeepScreenOn(true)
        return "ok"
    }

    @JavascriptInterface
    fun liveStop() {
        live.stop()
        refreshKeepScreenOn()
    }

    /** Waveform: sine, square, triangle, sawtooth, white, pink. [wobble] is a fraction (0.01 = ±1%). */
    @JavascriptInterface
    fun genPlay(waveform: String, frequency: Double, level: Double, wobble: Double) {
        generator.play(Oscillator.parse(waveform), frequency, level, wobble)
        activity.setKeepScreenOn(true)
    }

    @JavascriptInterface
    fun genStop() {
        generator.stop()
        refreshKeepScreenOn()
    }

    /** Shares a file whose content is given as base64. */
    @JavascriptInterface
    fun shareFile(fileName: String, mimeType: String, base64: String) {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        activity.runOnUiThread { activity.shareFile(fileName, mimeType, bytes) }
    }

    /** Stops every audio activity (app going to background). */
    fun stopAll() {
        generator.stop()
        live.stop()
        callJs("onNativeStopped")
    }

    private fun startCapture(start: (MeasurementEngine.Listener) -> Boolean): String {
        if (!activity.hasMicPermission()) {
            activity.runOnUiThread { activity.requestMicPermission() }
            return "permission"
        }
        // Generator output or a second recorder would contaminate the capture.
        generator.stop()
        if (live.isRunning) {
            live.stop()
            callJs("onLiveStopped")
        }

        val started = start(captureListener)
        if (started) activity.setKeepScreenOn(true)
        return if (started) "ok" else "busy"
    }

    private val captureListener = object : MeasurementEngine.Listener {
        override fun onProgress(fraction: Double, levelDb: Double) =
            callJs("onNativeProgress", fraction.toString(), levelDb.toString())

        override fun onComplete(sampleRate: Int, source: String) {
            refreshKeepScreenOn()
            val meta = JSONObject().put("sampleRate", sampleRate).put("source", source)
            callJs("onNativeDone", meta.toString())
        }

        override fun onError(message: String) {
            refreshKeepScreenOn()
            callJs("onNativeError", JSONObject.quote(message))
        }
    }

    private fun refreshKeepScreenOn() {
        activity.setKeepScreenOn(generator.isPlaying || live.isRunning || engine.isBusy)
    }

    private fun encode(block: FloatArray): String {
        val buffer = ByteBuffer.allocate(block.size * Float.SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        buffer.asFloatBuffer().put(block)
        return Base64.encodeToString(buffer.array(), Base64.NO_WRAP)
    }

    /** Arguments must already be valid JavaScript literals. */
    private fun callJs(function: String, vararg args: String) {
        val script = "window.$function && window.$function(${args.joinToString(",")})"
        webView.post { webView.evaluateJavascript(script, null) }
    }

    private companion object {
        const val MIN_LISTEN_SEC = 1.0
        const val MAX_LISTEN_SEC = 10.0
    }
}
