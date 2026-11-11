package app.sweepmeter

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import java.io.File

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var engine: MeasurementEngine
    private lateinit var tone: TonePlayer
    private lateinit var assetLoader: WebViewAssetLoader

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        volumeControlStream = AudioManager.STREAM_MUSIC

        engine = MeasurementEngine(this)
        tone = TonePlayer(engine.sampleRate)
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/rec/", RecordingPathHandler(engine))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = AppWebViewClient()
            addJavascriptInterface(NativeBridge(this@MainActivity, this, engine, tone), "Native")
        }

        val root = FrameLayout(this).apply { addView(webView) }
        applySystemBarInsets(root)
        setContentView(root)

        webView.loadUrl(START_URL)
        if (!hasMicPermission()) requestMicPermission()
    }

    // Never keep a tone running in the background.
    override fun onPause() {
        tone.stop()
        webView.evaluateJavascript("window.onNativeToneStopped && window.onNativeToneStopped()", null)
        super.onPause()
    }

    override fun onDestroy() {
        tone.stop()
        webView.destroy()
        super.onDestroy()
    }

    fun hasMicPermission(): Boolean =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun requestMicPermission() {
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_MIC && grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, R.string.mic_denied, Toast.LENGTH_LONG).show()
        }
    }

    fun setKeepScreenOn(on: Boolean) = runOnUiThread {
        if (on) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    fun shareCsv(fileName: String, content: String) {
        val dir = File(cacheDir, EXPORT_DIR).apply { mkdirs() }
        val file = File(dir, fileName.replace(UNSAFE_CHARS, "_")).apply { writeText(content) }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)

        val send = Intent(Intent.ACTION_SEND)
            .setType("text/csv")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(send, getString(R.string.export_title)))
    }

    /** Pads content so it stays clear of status/navigation bars (edge-to-edge on API 35). */
    private fun applySystemBarInsets(view: View) {
        view.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(
                    insets.systemWindowInsetLeft,
                    insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight,
                    insets.systemWindowInsetBottom
                )
            }
            insets
        }
    }

    private inner class AppWebViewClient : WebViewClient() {

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            assetLoader.shouldInterceptRequest(request.url)

        // Keep the app on its own origin; open anything else externally.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
            return true
        }
    }

    private companion object {
        const val REQUEST_MIC = 1
        const val EXPORT_DIR = "exports"
        val START_URL: String = Uri.Builder()
            .scheme("https")
            .authority(WebViewAssetLoader.DEFAULT_DOMAIN)
            .path("/assets/index.html")
            .build()
            .toString()
        val UNSAFE_CHARS = Regex("[^A-Za-z0-9._-]")
    }
}
