package app.sweepmeter

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SweepGeneratorTest {

    private val sampleRate = 48_000
    private val f1 = 30.0
    private val f2 = 16_000.0
    private val duration = 6.0
    private val sweep = SweepGenerator.generate(sampleRate, f1, f2, duration)

    @Test
    fun lengthMatchesDuration() {
        assertEquals((sampleRate * duration).toInt(), sweep.size)
    }

    @Test
    fun amplitudeStaysWithinUnitRange() {
        assertTrue(sweep.all { abs(it) <= 1f })
    }

    @Test
    fun fadesStartAndEndAtSilence() {
        assertEquals(0f, sweep.first(), 1e-6f)
        assertTrue(abs(sweep.last()) < 1e-3f)
    }

    @Test
    fun instantaneousFrequencyFollowsExponentialLaw() {
        // Expected frequency at mid-sweep is the geometric mean of f1 and f2.
        val expected = f1 * exp(duration / 2 * ln(f2 / f1) / duration)
        assertEquals(sqrt(f1 * f2), expected, 1e-6)

        val window = sampleRate / 20
        val start = sweep.size / 2 - window / 2
        var crossings = 0
        for (i in start + 1 until start + window) {
            if ((sweep[i - 1] < 0f) != (sweep[i] < 0f)) crossings++
        }
        val measured = crossings / 2.0 / (window.toDouble() / sampleRate)
        assertEquals(expected, measured, expected * 0.05)
    }
}
