package app.sweepmeter

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import kotlin.math.max

/** Factory for float32 mono recorders and media-usage tracks routed to preferred devices. */
object AudioIo {

    private const val FLOAT_BYTES = 4

    @SuppressLint("MissingPermission") // Callers check RECORD_AUDIO first.
    fun createRecorder(sr: Int, sourceId: Int, device: AudioDeviceInfo?): AudioRecord {
        val minBuffer = AudioRecord.getMinBufferSize(sr, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        require(minBuffer > 0) { "Microfone não suporta $sr Hz em ponto flutuante" }

        val recorder = AudioRecord.Builder()
            .setAudioSource(sourceId)
            .setAudioFormat(format(sr, AudioFormat.CHANNEL_IN_MONO))
            .setBufferSizeInBytes(max(minBuffer * 4, sr * FLOAT_BYTES / 2))
            .build()

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            error("Falha ao abrir o microfone")
        }
        device?.let { recorder.setPreferredDevice(it) }
        return recorder
    }

    fun createTrack(sr: Int, device: AudioDeviceInfo?, bufferFrames: Int): AudioTrack {
        val minBuffer = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        require(minBuffer > 0) { "Saída de áudio não suporta $sr Hz" }

        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(format(sr, AudioFormat.CHANNEL_OUT_MONO))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(max(minBuffer * 2, bufferFrames * FLOAT_BYTES))
            .build()
        device?.let { track.setPreferredDevice(it) }
        return track
    }

    private fun format(sr: Int, channelMask: Int): AudioFormat = AudioFormat.Builder()
        .setSampleRate(sr)
        .setChannelMask(channelMask)
        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
        .build()
}
