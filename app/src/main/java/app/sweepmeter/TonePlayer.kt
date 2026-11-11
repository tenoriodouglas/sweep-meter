package app.sweepmeter

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.sin

/**
 * Continuous sine generator with click-free gain/frequency changes and an optional
 * slow frequency wobble around the target, used to excite a resonance.
 */
class TonePlayer(private val sampleRate: Int) {

    @Volatile private var targetFreq = 440.0

    @Volatile private var targetGain = 0.0

    @Volatile private var wobbleDepth = 0.0

    @Volatile private var running = false

    private var worker: Thread? = null

    val isPlaying: Boolean get() = running

    /** Starts or retunes the tone. [wobble] is the fractional deviation (0.01 = ±1%). */
    @Synchronized
    fun play(frequency: Double, gain: Double, wobble: Double) {
        targetFreq = frequency.coerceIn(MIN_FREQ, sampleRate * 0.45)
        targetGain = gain.coerceIn(0.0, 1.0)
        wobbleDepth = wobble.coerceIn(0.0, MAX_WOBBLE)
        if (running) return
        running = true
        worker = thread(name = "tone") { render() }
    }

    /** Fades out and releases the output. */
    @Synchronized
    fun stop() {
        running = false
        worker?.join(JOIN_TIMEOUT_MS)
        worker = null
    }

    private fun render() {
        val track = createTrack()
        val buffer = FloatArray(CHUNK)
        val smooth = 1 - exp(-1.0 / (SMOOTH_SEC * sampleRate))
        var phase = 0.0
        var wobblePhase = 0.0
        var freq = targetFreq
        var gain = 0.0

        try {
            track.play()
            while (true) {
                val goalGain = if (running) targetGain else 0.0
                for (i in buffer.indices) {
                    gain += (goalGain - gain) * smooth
                    freq += (targetFreq - freq) * smooth
                    val f = freq * (1 + wobbleDepth * sin(wobblePhase))
                    buffer[i] = (gain * sin(phase)).toFloat()
                    phase += 2 * PI * f / sampleRate
                    if (phase > 2 * PI) phase -= 2 * PI
                    wobblePhase += 2 * PI / (WOBBLE_PERIOD_SEC * sampleRate)
                    if (wobblePhase > 2 * PI) wobblePhase -= 2 * PI
                }
                if (track.write(buffer, 0, buffer.size, AudioTrack.WRITE_BLOCKING) < 0) break
                if (!running && gain < SILENCE) break
            }
        } finally {
            runCatching { track.stop() }
            track.release()
            running = false
        }
    }

    private fun createTrack(): AudioTrack {
        val minBuffer = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_FLOAT
        )
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(max(minBuffer * 2, CHUNK * Float.SIZE_BYTES * 2))
            .build()
    }

    private companion object {
        const val CHUNK = 1024
        const val MIN_FREQ = 10.0
        const val MAX_WOBBLE = 0.05
        const val WOBBLE_PERIOD_SEC = 8.0
        const val SMOOTH_SEC = 0.03
        const val SILENCE = 1e-4
        const val JOIN_TIMEOUT_MS = 1_000L
    }
}
