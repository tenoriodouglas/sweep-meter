package app.sweepmeter

import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random

/** Band-limited (PolyBLEP) periodic waveforms and coloured noise, one sample at a time. */
class Oscillator(private val sampleRate: Int, private val random: Random = Random.Default) {

    enum class Waveform { SINE, SQUARE, TRIANGLE, SAWTOOTH, WHITE, PINK }

    private var phase = 0.0 // cycles, [0, 1)
    private var triangleState = -1.0 // starts at the trough so phase 0 has no DC offset
    private val pink = DoubleArray(7)

    /** Next sample at [frequency] Hz; periodic waveforms peak at ±1. */
    fun next(waveform: Waveform, frequency: Double): Float {
        val dt = frequency / sampleRate
        val t = phase
        val value = when (waveform) {
            Waveform.SINE -> sin(2 * PI * t)

            Waveform.SAWTOOTH -> 2 * t - 1 - polyBlep(t, dt)

            Waveform.SQUARE -> square(t, dt)

            Waveform.TRIANGLE -> {
                // Leaky integration of the band-limited square.
                triangleState = dt * 4 * square(t, dt) + (1 - dt * 0.01) * triangleState
                triangleState
            }

            Waveform.WHITE -> random.nextDouble(-1.0, 1.0)

            Waveform.PINK -> pinkSample()
        }
        phase += dt
        if (phase >= 1) phase -= 1
        return value.toFloat()
    }

    private fun square(t: Double, dt: Double): Double {
        val naive = if (t < 0.5) 1.0 else -1.0
        return naive + polyBlep(t, dt) - polyBlep((t + 0.5) % 1.0, dt)
    }

    /** Paul Kellet's refined pink filter; matches pinkNoise() in dsp.js. */
    private fun pinkSample(): Double {
        val w = random.nextDouble(-1.0, 1.0)
        val b = pink
        b[0] = 0.99886 * b[0] + w * 0.0555179
        b[1] = 0.99332 * b[1] + w * 0.0750759
        b[2] = 0.969 * b[2] + w * 0.153852
        b[3] = 0.8665 * b[3] + w * 0.3104856
        b[4] = 0.55 * b[4] + w * 0.5329522
        b[5] = -0.7616 * b[5] - w * 0.016898
        val out = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11
        b[6] = w * 0.115926
        return out
    }

    companion object {
        /** Polynomial band-limited step residual around discontinuities. */
        fun polyBlep(t: Double, dt: Double): Double = when {
            dt <= 0 -> 0.0

            t < dt -> {
                val x = t / dt
                x + x - x * x - 1
            }

            t > 1 - dt -> {
                val x = (t - 1) / dt
                x * x + x + x + 1
            }

            else -> 0.0
        }

        fun parse(name: String): Waveform = Waveform.entries.firstOrNull { it.name.equals(name, ignoreCase = true) }
            ?: Waveform.SINE
    }
}
