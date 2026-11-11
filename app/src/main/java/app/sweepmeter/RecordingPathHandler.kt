package app.sweepmeter

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Serves the last recording at /rec/ as little-endian float32 for fetch() in the WebView. */
class RecordingPathHandler(private val engine: MeasurementEngine) : WebViewAssetLoader.PathHandler {

    override fun handle(path: String): WebResourceResponse {
        val data = engine.lastRecording ?: return WebResourceResponse(
            "text/plain",
            "utf-8",
            404,
            "Not Found",
            NO_CACHE,
            ByteArrayInputStream(ByteArray(0))
        )

        val buffer = ByteBuffer.allocate(data.size * Float.SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        buffer.asFloatBuffer().put(data)

        return WebResourceResponse(
            "application/octet-stream",
            null,
            200,
            "OK",
            NO_CACHE,
            ByteArrayInputStream(buffer.array())
        )
    }

    private companion object {
        val NO_CACHE = mapOf("Cache-Control" to "no-store")
    }
}
