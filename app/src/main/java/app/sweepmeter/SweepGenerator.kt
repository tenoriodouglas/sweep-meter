package app.sweepmeter

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt
import kotlin.math.sin

/** Exponential sine sweep (Farina). Must match makeSweep() in assets/index.html. */
object SweepGenerator {

    private const val FADE_IN_SEC = 0.05
    private const val FADE_OUT_SEC = 0.01

    fun generate(sampleRate: Int, f1: Double, f2: Double, durationSec: Double): FloatArray {
        val n = (sampleRate * durationSec).roundToInt()
        val out = FloatArray(n)
        val w1 = 2 * PI * f1
        val r = ln(f2 / f1)
        val k = w1 * durationSec / r
        val fadeIn = (FADE_IN_SEC * sampleRate).roundToInt()
        val fadeOut = (FADE_OUT_SEC * sampleRate).roundToInt()

        for (i in 0 until n) {
            val t = i.toDouble() / sampleRate
            val gain = when {
                i < fadeIn -> 0.5 - 0.5 * cos(PI * i / fadeIn)
                i > n - fadeOut -> 0.5 - 0.5 * cos(PI * (n - i) / fadeOut)
                else -> 1.0
            }
            out[i] = (gain * sin(k * (exp(t * r / durationSec) - 1))).toFloat()
        }
        return out
    }
}
