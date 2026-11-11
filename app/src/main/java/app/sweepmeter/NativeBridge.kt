package app.sweepmeter

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/** JavaScript interface exposed as window.Native. */
class NativeBridge(
    private val activity: MainActivity,
    private val webView: WebView,
    private val engine: MeasurementEngine
) {

    @JavascriptInterface
    fun info(): String = JSONObject()
        .put("sampleRate", engine.sampleRate)
        .put("source", engine.inputSource.label)
        .toString()

    /** Returns "ok", "permission" or "busy". */
    @JavascriptInterface
    fun measure(json: String): String {
        if (!activity.hasMicPermission()) {
            activity.runOnUiThread { activity.requestMicPermission() }
            return "permission"
        }

        val o = JSONObject(json)
        val params = MeasurementEngine.Params(
            f1 = o.getDouble("f1"),
            f2 = o.getDouble("f2"),
            durationSec = o.getDouble("dur"),
            level = o.getDouble("level").toFloat().coerceIn(0f, 1f),
            preRollSec = o.getDouble("preRoll"),
            tailSec = o.getDouble("tail")
        )

        val started = engine.start(
            params,
            object : MeasurementEngine.Listener {
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
        )

        if (started) activity.setKeepScreenOn(true)
        return if (started) "ok" else "busy"
    }

    @JavascriptInterface
    fun shareCsv(fileName: String, content: String) {
        activity.runOnUiThread { activity.shareCsv(fileName, content) }
    }

    /** Arguments must already be valid JavaScript literals. */
    private fun callJs(function: String, vararg args: String) {
        val script = "window.$function && window.$function(${args.joinToString(",")})"
        webView.post { webView.evaluateJavascript(script, null) }
    }
}
