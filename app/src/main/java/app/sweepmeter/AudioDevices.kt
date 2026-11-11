package app.sweepmeter

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import org.json.JSONArray
import org.json.JSONObject

/** Lists audio inputs/outputs and holds the user's preferred ones (0 = system default). */
class AudioDevices(context: Context) {

    private val audioManager = context.getSystemService(AudioManager::class.java)

    @Volatile var inputId: Int = 0

    @Volatile var outputId: Int = 0

    fun preferredInput(): AudioDeviceInfo? = find(AudioManager.GET_DEVICES_INPUTS, inputId)

    fun preferredOutput(): AudioDeviceInfo? = find(AudioManager.GET_DEVICES_OUTPUTS, outputId)

    fun toJson(): JSONObject = JSONObject()
        .put("inputs", list(AudioManager.GET_DEVICES_INPUTS, INPUT_TYPES))
        .put("outputs", list(AudioManager.GET_DEVICES_OUTPUTS, OUTPUT_TYPES))
        .put("inputId", inputId)
        .put("outputId", outputId)

    private fun find(flag: Int, id: Int): AudioDeviceInfo? =
        if (id == 0) null else audioManager.getDevices(flag).firstOrNull { it.id == id }

    private fun list(flag: Int, types: Map<Int, String>): JSONArray {
        val out = JSONArray()
        audioManager.getDevices(flag)
            .filter { it.type in types }
            .distinctBy { it.type to it.productName.toString() }
            .forEach { d ->
                out.put(
                    JSONObject()
                        .put("id", d.id)
                        .put("type", types.getValue(d.type))
                        .put("name", d.productName?.toString().orEmpty())
                        .put("rates", JSONArray(d.sampleRates.toList()))
                )
            }
        return out
    }

    private companion object {
        val INPUT_TYPES = mapOf(
            AudioDeviceInfo.TYPE_BUILTIN_MIC to "Microfone interno",
            AudioDeviceInfo.TYPE_USB_DEVICE to "USB",
            AudioDeviceInfo.TYPE_USB_HEADSET to "Headset USB",
            AudioDeviceInfo.TYPE_WIRED_HEADSET to "Fone com microfone",
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO to "Bluetooth"
        )
        val OUTPUT_TYPES = mapOf(
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER to "Alto-falante",
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES to "Fone com fio",
            AudioDeviceInfo.TYPE_WIRED_HEADSET to "Fone com fio",
            AudioDeviceInfo.TYPE_LINE_ANALOG to "Saída P2",
            AudioDeviceInfo.TYPE_USB_DEVICE to "USB",
            AudioDeviceInfo.TYPE_USB_HEADSET to "Headset USB",
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP to "Bluetooth"
        )
    }
}
