# Sweep Meter

App Android que mede a resposta acústica de um ambiente e encontra suas frequências ressonantes.

## Como funciona

1. Toca uma varredura senoidal logarítmica (ESS) pela saída de mídia (`AudioTrack`).
2. Grava ao mesmo tempo pelo microfone com a fonte `UNPROCESSED` (fallback `VOICE_RECOGNITION`), sem AGC nem supressão de ruído.
3. Deconvolução regularizada → resposta ao impulso → resposta em frequência suavizada por fração de oitava.
4. Detecção de picos com proeminência e Q; associação com modos axiais teóricos (`f = n·343 / 2L`) quando as dimensões da sala são informadas.

Interface e DSP ficam em `app/src/main/assets/index.html` (WebView servida por `WebViewAssetLoader`); captura e reprodução são nativas (`MeasurementEngine`). A gravação chega ao WebView em float32 pela rota `/rec/`.

## Dicas de medição

- O alto-falante do celular reproduz pouco abaixo de 200–300 Hz. Para modos de sala (20–200 Hz), use uma caixa externa (P2, USB ou Bluetooth).
- Salve uma medição feita ao ar livre como **referência** para compensar a coloração do próprio aparelho.

## CI/CD

| Evento | O que acontece |
| --- | --- |
| Push / PR | `spotlessCheck`, testes unitários, lint e APK debug |
| Push na `main` | APK debug publicado na release `apk-latest` |
| Tag `v*` ou execução manual | AAB assinado enviado ao Google Play |

APK mais recente: `https://github.com/tenoriodouglas/sweep-meter/releases/download/apk-latest/sweep-meter-latest-debug.apk`

Secrets do deploy: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`, `PLAY_SERVICE_ACCOUNT_JSON`.

## Build local

```bash
./gradlew :app:assembleDebug
```

Requer JDK 17+ e Android SDK 37.
