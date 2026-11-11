package app.sweepmeter

import android.media.AudioRecord
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Continuous microphone stream in fixed-size float blocks (RTA, SPL meter, tuner). */
class LiveInput(private val engine: MeasurementEngine, private val devices: AudioDevices) {

    fun interface Sink {
        fun onBlock(samples: FloatArray)
    }

    private val running = AtomicBoolean(false)
    private var worker: Thread? = null

    val isRunning: Boolean get() = running.get()

    /** Returns false if already streaming. Errors are reported through [onError]. */
    @Synchronized
    fun start(sink: Sink, onError: (String) -> Unit): Boolean {
        if (!running.compareAndSet(false, true)) return false
        worker = thread(name = "live-input") {
            try {
                stream(sink)
            } catch (e: Exception) {
                onError(e.message ?: e.javaClass.simpleName)
            } finally {
                running.set(false)
            }
        }
        return true
    }

    @Synchronized
    fun stop() {
        running.set(false)
        worker?.join(JOIN_TIMEOUT_MS)
        worker = null
    }

    private fun stream(sink: Sink) {
        val recorder = AudioIo.createRecorder(engine.sampleRate, engine.inputSource.id, devices.preferredInput())
        try {
            recorder.startRecording()
            check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microfone em uso por outro app" }
            val block = FloatArray(BLOCK)
            while (running.get()) {
                var filled = 0
                while (filled < BLOCK && running.get()) {
                    val n = recorder.read(block, filled, BLOCK - filled, AudioRecord.READ_BLOCKING)
                    if (n < 0) error("Erro de leitura do microfone ($n)")
                    filled += n
                }
                if (filled == BLOCK) sink.onBlock(block.copyOf())
            }
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
        }
    }

    companion object {
        const val BLOCK = 2048
        private const val JOIN_TIMEOUT_MS = 1_000L
    }
}
