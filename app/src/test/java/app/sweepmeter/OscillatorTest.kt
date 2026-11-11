package app.sweepmeter

import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OscillatorTest {

    private val sampleRate = 48_000

    private fun render(waveform: Oscillator.Waveform, frequency: Double = 440.0, n: Int = sampleRate): FloatArray {
        val osc = Oscillator(sampleRate, Random(42))
        return FloatArray(n) { osc.next(waveform, frequency) }
    }

    private fun rms(x: FloatArray) = sqrt(x.sumOf { it.toDouble() * it } / x.size)

    private fun mean(x: FloatArray) = x.sumOf { it.toDouble() } / x.size

    @Test
    fun sineHasExpectedRms() {
        assertEquals(1 / sqrt(2.0), rms(render(Oscillator.Waveform.SINE)), 0.01)
    }

    @Test
    fun squareIsBandLimitedAndFullScale() {
        val x = render(Oscillator.Waveform.SQUARE)
        assertEquals(1.0, rms(x), 0.03)
        assertTrue(x.all { abs(it) <= 1.1f })
    }

    @Test
    fun triangleStaysCentredAndBounded() {
        val x = render(Oscillator.Waveform.TRIANGLE, frequency = 100.0)
        assertEquals(0.0, mean(x), 0.05)
        assertTrue(x.all { abs(it) <= 1.05f })
        assertEquals(1 / sqrt(3.0), rms(x), 0.03)
    }

    @Test
    fun sawtoothHasExpectedRms() {
        assertEquals(1 / sqrt(3.0), rms(render(Oscillator.Waveform.SAWTOOTH)), 0.02)
    }

    @Test
    fun noiseIsZeroMeanAndBounded() {
        for (wave in listOf(Oscillator.Waveform.WHITE, Oscillator.Waveform.PINK)) {
            val x = render(wave)
            assertEquals(0.0, mean(x), 0.05)
            assertTrue(x.all { abs(it) <= 1.5f })
            assertTrue(rms(x) > 0.05)
        }
    }

    @Test
    fun parseFallsBackToSine() {
        assertEquals(Oscillator.Waveform.PINK, Oscillator.parse("pink"))
        assertEquals(Oscillator.Waveform.SINE, Oscillator.parse("unknown"))
    }

    @Test
    fun polyBlepIsZeroAwayFromEdges() {
        assertEquals(0.0, Oscillator.polyBlep(0.5, 0.01), 0.0)
        assertTrue(Oscillator.polyBlep(0.001, 0.01) < 0)
    }
}
