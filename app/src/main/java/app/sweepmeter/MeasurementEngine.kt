package app.sweepmeter

import android.content.Context
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Plays a sine sweep through the media output while recording the microphone
 * with the least processed input source available. Analysis happens in the WebView.
 */
class MeasurementEngine(context: Context, private val devices: AudioDevices) {

    data class Params(
        val f1: Double,
        val f2: Double,
        val durationSec: Double,
        val level: Float,
        val preRollSec: Double,
        val tailSec: Double
    )

    data class InputSource(val id: Int, val label: String)

    interface Listener {
        fun onProgress(fraction: Double, levelDb: Double)
        fun onComplete(sampleRate: Int, source: String)
        fun onError(message: String)
    }

    private val audioManager = context.getSystemService(AudioManager::class.java)
    private val running = AtomicBoolean(false)

    val isBusy: Boolean get() = running.get()

    /** Last capture, served to the WebView as raw little-endian float32. */
    @Volatile
    var lastRecording: FloatArray? = null
        private set

    val sampleRate: Int
        get() = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull()
            ?: DEFAULT_SAMPLE_RATE

    val inputSource: InputSource
        get() {
            val unprocessed = audioManager
                .getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
            return if (unprocessed) {
                InputSource(MediaRecorder.AudioSource.UNPROCESSED, "UNPROCESSED")
            } else {
                InputSource(MediaRecorder.AudioSource.VOICE_RECOGNITION, "VOICE_RECOGNITION")
            }
        }

    /** Plays the sweep while recording. Returns false when a capture is already in progress. */
    fun start(params: Params, listener: Listener): Boolean = launch(listener) { sr ->
        val playback = buildPlayback(params, sr)
        capture(playback, playback.size + (RECORD_MARGIN_SEC * sr).roundToInt(), sr, listener)
    }

    /** Records only (e.g. a tapped glass). Returns false when a capture is already in progress. */
    fun listen(durationSec: Double, listener: Listener): Boolean = launch(listener) { sr ->
        capture(FloatArray(0), (durationSec * sr).roundToInt(), sr, listener)
    }

    private fun launch(listener: Listener, block: (Int) -> FloatArray): Boolean {
        if (!running.compareAndSet(false, true)) return false
        thread(name = "capture") {
            try {
                val sr = sampleRate
                lastRecording = block(sr)
                listener.onComplete(sr, inputSource.label)
            } catch (e: Exception) {
                listener.onError(e.message ?: e.javaClass.simpleName)
            } finally {
                running.set(false)
            }
        }
        return true
    }

    private fun capture(playback: FloatArray, recordLength: Int, sr: Int, listener: Listener): FloatArray {
        val recorder = AudioIo.createRecorder(sr, inputSource.id, devices.preferredInput())
        val track = if (playback.isNotEmpty()) AudioIo.createTrack(sr, devices.preferredOutput(), sr / 4) else null
        val recording = FloatArray(recordLength)
        var player: Thread? = null

        try {
            recorder.startRecording()
            check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                "Microfone em uso por outro app"
            }

            // Playback starts after recording, so the capture always holds the full sweep.
            if (track != null) player = thread(name = "playback") { play(track, playback) }

            var offset = 0
            var lastPost = 0L
            while (offset < recordLength) {
                val n = recorder.read(
                    recording,
                    offset,
                    min(CHUNK, recordLength - offset),
                    AudioRecord.READ_BLOCKING
                )
                if (n < 0) error("Erro de leitura do microfone ($n)")

                var sum = 0.0
                for (i in offset until offset + n) sum += recording[i] * recording[i]
                offset += n

                val now = SystemClock.uptimeMillis()
                if (now - lastPost >= PROGRESS_INTERVAL_MS) {
                    lastPost = now
                    val levelDb = 10 * log10(sum / max(n, 1) + 1e-20)
                    listener.onProgress(offset.toDouble() / recordLength, levelDb)
                }
            }
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
            runCatching { track?.stop() }
            player?.join(JOIN_TIMEOUT_MS)
            track?.release()
        }
        return recording
    }

    private fun play(track: AudioTrack, data: FloatArray) {
        track.play()
        var offset = 0
        while (offset < data.size) {
            val n = track.write(data, offset, min(CHUNK, data.size - offset), AudioTrack.WRITE_BLOCKING)
            if (n <= 0) break
            offset += n
        }
        // In stream mode stop() lets queued audio finish playing.
        runCatching { track.stop() }
    }

    /** Silence + scaled sweep + silent tail for decay capture. */
    private fun buildPlayback(p: Params, sr: Int): FloatArray {
        val pre = (p.preRollSec * sr).roundToInt()
        val tail = (p.tailSec * sr).roundToInt()
        val sweep = SweepGenerator.generate(sr, p.f1, p.f2, p.durationSec)
        val out = FloatArray(pre + sweep.size + tail)
        for (i in sweep.indices) out[pre + i] = sweep[i] * p.level
        return out
    }

    private companion object {
        const val DEFAULT_SAMPLE_RATE = 48_000
        const val RECORD_MARGIN_SEC = 1.0
        const val CHUNK = 1024
        const val PROGRESS_INTERVAL_MS = 50L
        const val JOIN_TIMEOUT_MS = 3_000L
    }
}
