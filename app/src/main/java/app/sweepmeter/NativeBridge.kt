package app.sweepmeter

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/** JavaScript interface exposed as window.Native. */
class NativeBridge(
    private val activity: MainActivity,
    private val webView: WebView,
    private val engine: MeasurementEngine,
    private val tone: TonePlayer
) {

    @JavascriptInterface
    fun info(): String = JSONObject()
        .put("sampleRate", engine.sampleRate)
        .put("source", engine.inputSource.label)
        .toString()

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

    /** Starts or retunes the continuous tone. [wobble] is a fraction (0.01 = ±1%). */
    @JavascriptInterface
    fun tonePlay(frequency: Double, level: Double, wobble: Double) {
        tone.play(frequency, level, wobble)
        activity.setKeepScreenOn(true)
    }

    @JavascriptInterface
    fun toneStop() {
        tone.stop()
        activity.setKeepScreenOn(false)
    }

    @JavascriptInterface
    fun shareCsv(fileName: String, content: String) {
        activity.runOnUiThread { activity.shareCsv(fileName, content) }
    }

    private fun startCapture(start: (MeasurementEngine.Listener) -> Boolean): String {
        if (!activity.hasMicPermission()) {
            activity.runOnUiThread { activity.requestMicPermission() }
            return "permission"
        }
        // Tone output would contaminate the recording.
        tone.stop()

        val started = start(captureListener)
        if (started) activity.setKeepScreenOn(true)
        return if (started) "ok" else "busy"
    }

    private val captureListener = object : MeasurementEngine.Listener {
        override fun onProgress(fraction: Double, levelDb: Double) =
            callJs("onNativeProgress", fraction.toString(), levelDb.toString())

        override fun onComplete(sampleRate: Int, source: String) {
            activity.setKeepScreenOn(false)
            val meta = JSONObject().put("sampleRate", sampleRate).put("source", source)
            callJs("onNativeDone", meta.toString())
        }

        override fun onError(message: String) {
            activity.setKeepScreenOn(false)
            callJs("onNativeError", JSONObject.quote(message))
        }
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
