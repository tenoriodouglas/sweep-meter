# Sweep Meter

App Android que mede a resposta acústica de um ambiente e encontra suas frequências ressonantes.

## Recursos

| Aba | O que faz |
| --- | --- |
| **Medir** | Varredura senoidal exponencial com 6 análises: resposta em frequência (suavização 1/3–1/48 oit., modos axiais sobrepostos, picos com Q e nota), impulso e ETC com reflexões em ms/m, cascata (CSD) de graves e médios, RT60 por oitava (EDT/T20/T30, C50/C80/D50, ISO 3382 com integral de Schroeder e compensação de ruído), distorção harmônica (THD/H2/H3, método de Farina) e EQ automático (cortes paramétricos exportáveis no formato Equalizer APO/REW). |
| **Ao vivo** | Analisador RTA em 1/3 de oitava ou FFT (média rápida/lenta/contínua, retenção de pico), espectrograma rolante e decibelímetro com ponderação A/C/Z, Fast/Slow, Leq, máx./mín. e histórico de 60 s. Botão de ruído rosa para medir a sala em tempo real. |
| **Gerador** | Senoide, quadrada, triangular e dente de serra sem aliasing (PolyBLEP), ruído branco e rosa; ajuste fino 0,1 Hz/1 Hz/10 Hz/semitom, afinar na nota, varredura fina ±0,2–3% e atalhos para os picos medidos. Uma pílula na barra superior mostra e para o sinal em qualquer aba. |
| **Taça** | Ouve a batida e acha a fundamental (< 0,1 Hz), parciais, Q e T60; toca na frequência; *Excitar e ouvir* mede quantos dB a taça soa acima do ruído depois que o tom para; *Busca automática* testa frequências vizinhas e fica com a melhor; afinador ao vivo em cents. |
| **Sala** | Modos axiais, tangenciais e oblíquos sobre a medição atual, frequência de Schroeder, critério de Bonello por 1/3 de oitava e dicas de posicionamento (regra dos 38%, subwoofer, SBIR, tratamento). |
| **Histórico** | Medições salvas (IndexedDB), comparação de até 6 curvas, média espacial de várias posições, referência para compensar, renomear, exportar CSV e IR em WAV. |
| **Ajustes** | Escolha de entrada/saída (microfone USB como UMIK-1, P2, Bluetooth), arquivo de calibração do microfone (.cal/.txt do REW), calibração de dB SPL com decibelímetro de referência, lá central e temperatura. |

## Arquitetura

- **Nativo (Kotlin):** `MeasurementEngine` (varredura + captura `UNPROCESSED`), `LiveInput` (stream do microfone em blocos de 2048 amostras), `SignalGenerator` + `Oscillator`, `AudioDevices`/`AudioIo` (roteamento de dispositivos), `NativeBridge` (`window.Native`).
- **Web (WebView, módulos ES):** `js/dsp.js` (todo o processamento, testado em `tests/`), `js/audio.js` (ponte nativa com fallback Web Audio), `js/plot.js` (gráficos em canvas), `js/views/*` (uma tela por arquivo), `js/main.js` (roteamento por hash).
- A gravação chega ao WebView em float32 pela rota `/rec/`; o stream ao vivo chega via `window.onLiveData`.

## Dicas de medição

- O alto-falante do celular reproduz pouco abaixo de 200–300 Hz. Para modos de sala (20–200 Hz), use uma caixa externa (P2, USB ou Bluetooth).
- Para RT60 confiável (T30), a faixa dinâmica do decaimento precisa passar de 45 dB: aumente o volume e as repetições.
- Meça em várias posições e use **Média das selecionadas** no Histórico antes de gerar EQ.

## CI/CD

| Evento | O que acontece |
| --- | --- |
| Push / PR | `spotlessCheck`, testes DSP (Node), testes unitários, lint e APK debug |
| Push na `main` | APK debug publicado na release `apk-latest` |
| Tag `v*` ou execução manual | AAB assinado enviado ao Google Play |

APK mais recente: `https://github.com/tenoriodouglas/sweep-meter/releases/download/apk-latest/sweep-meter-latest-debug.apk`

Secrets do deploy: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`, `PLAY_SERVICE_ACCOUNT_JSON`.

## Build local

```bash
./gradlew :app:assembleDebug
```

Requer JDK 17+ e Android SDK 37. Testes de DSP: `npm test` (Node 20+).
