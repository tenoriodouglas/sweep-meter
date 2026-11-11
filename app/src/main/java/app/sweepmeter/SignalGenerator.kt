package app.sweepmeter

import android.media.AudioTrack
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin

/**
 * Continuous signal generator: click-free gain/frequency changes and an optional slow
 * frequency wobble around the target, used to excite resonances or drive an RTA.
 */
class SignalGenerator(private val sampleRate: Int, private val devices: AudioDevices) {

    @Volatile private var waveform = Oscillator.Waveform.SINE

    @Volatile private var targetFreq = 440.0

    @Volatile private var targetGain = 0.0

    @Volatile private var wobbleDepth = 0.0

    @Volatile private var running = false

    private var worker: Thread? = null

    val isPlaying: Boolean get() = running

    /** Starts or retunes the output. [wobble] is the fractional deviation (0.01 = ±1%). */
    @Synchronized
    fun play(wave: Oscillator.Waveform, frequency: Double, gain: Double, wobble: Double) {
        waveform = wave
        targetFreq = frequency.coerceIn(MIN_FREQ, sampleRate * 0.45)
        targetGain = gain.coerceIn(0.0, 1.0)
        wobbleDepth = wobble.coerceIn(0.0, MAX_WOBBLE)
        if (running) return
        running = true
        worker = thread(name = "generator") { render() }
    }

    /** Fades out and releases the output. */
    @Synchronized
    fun stop() {
        running = false
        worker?.join(JOIN_TIMEOUT_MS)
        worker = null
    }

    private fun render() {
        val track = AudioIo.createTrack(sampleRate, devices.preferredOutput(), CHUNK * 2)
        val osc = Oscillator(sampleRate)
        val buffer = FloatArray(CHUNK)
        val smooth = 1 - exp(-1.0 / (SMOOTH_SEC * sampleRate))
        val wobbleStep = 2 * PI / (WOBBLE_PERIOD_SEC * sampleRate)
        var wobblePhase = 0.0
        var freq = targetFreq
        var gain = 0.0

        try {
            track.play()
            while (true) {
                val goalGain = if (running) targetGain else 0.0
                val wave = waveform
                for (i in buffer.indices) {
                    gain += (goalGain - gain) * smooth
                    freq += (targetFreq - freq) * smooth
                    buffer[i] = (gain * osc.next(wave, freq * (1 + wobbleDepth * sin(wobblePhase)))).toFloat()
                    wobblePhase += wobbleStep
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
