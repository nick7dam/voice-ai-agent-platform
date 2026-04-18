# Local AI Services

These small FastAPI services let the NestJS app run without paid STT or TTS APIs.
The WebRTC voice gateway is also available when you want browser audio without
per-turn STT/TTS HTTP requests.

## Exact Models

Use these first:

```text
STT: Systran/faster-distil-whisper-large-v3
Reasoning: llama3.2:3b through Ollama for low latency, or qwen3:8b for higher quality
TTS: hexgrad/Kokoro-82M
TTS voice: af_heart
```

Higher-accuracy STT option:

```text
Systran/faster-whisper-large-v3
```

Lower-latency STT option if available in your environment:

```text
Systran/faster-whisper-large-v3-turbo
```

## Install

Use separate virtual environments if you want clean dependency isolation:

```bash
python3.12 -m venv .venv-stt
. .venv-stt/bin/activate
pip install -r services/local-ai/requirements-stt.txt
deactivate

python3.12 -m venv .venv-tts
. .venv-tts/bin/activate
pip install -r services/local-ai/requirements-tts.txt
deactivate
```

Use Python 3.12 for these virtualenvs. Python 3.14 is currently too new for
some of the audio/ML wheels used by faster-whisper and Kokoro.

On an NVIDIA host, install the extra CUDA runtime wheels into the STT venv:

```bash
.venv-stt/bin/python -m pip install -r services/local-ai/requirements-stt-cuda.txt
```

The first request downloads model files into the Hugging Face cache unless they
are already present.

## Run

STT:

```bash
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
LOCAL_STT_DEVICE=cpu \
LOCAL_STT_COMPUTE_TYPE=int8 \
LOCAL_STT_LANGUAGE=en \
LOCAL_STT_VAD_FILTER=false \
LOCAL_STT_PRELOAD=true \
LOCAL_STT_WARMUP=true \
.venv-stt/bin/python services/local-ai/stt_server.py
```

TTS:

```bash
LOCAL_TTS_MODEL=hexgrad/Kokoro-82M \
LOCAL_TTS_VOICE=af_heart \
LOCAL_TTS_DEVICE=auto \
LOCAL_TTS_PRELOAD=true \
LOCAL_TTS_SAMPLE_RATE=24000 \
.venv-tts/bin/python services/local-ai/tts_server.py
```

Ollama:

```bash
ollama pull llama3.2:3b
ollama serve
```

## CUDA Host

For an NVIDIA CUDA host, install a CUDA-capable CTranslate2 build and run STT
with:

```bash
.venv-stt/bin/python -m pip install -r services/local-ai/requirements-stt-cuda.txt
export LD_LIBRARY_PATH="$(.venv-stt/bin/python scripts/print-cuda-library-path.py):${LD_LIBRARY_PATH:-}"
LOCAL_STT_DEVICE=cuda LOCAL_STT_COMPUTE_TYPE=float16 LOCAL_STT_LANGUAGE=en LOCAL_STT_VAD_FILTER=false LOCAL_STT_PRELOAD=true LOCAL_STT_WARMUP=true .venv-stt/bin/python services/local-ai/stt_server.py
```

Or use the pnpm helper, which sets `LD_LIBRARY_PATH` for the process:

```bash
pnpm local:stt:cuda
```

Run local TTS on CUDA:

```bash
LOCAL_TTS_DEVICE=cuda \
LOCAL_TTS_PRELOAD=true \
LOCAL_TTS_SAMPLE_RATE=24000 \
.venv-tts/bin/python services/local-ai/tts_server.py
```

CPU STT is usable for testing, but a GPU instance is much better for production
latency.

The STT service preloads and warms Whisper by default. Use `/health` to confirm
`device`, `computeType`, and `loaded`, and `/warmup` if you want to warm it
again after startup.

The TTS service preloads and warms Kokoro by default. Use `/health` to confirm
`effectiveDevice` and `torchCudaAvailable`, and `/warmup` if you want to warm it
again after startup. It exposes `/synthesize` for WAV responses and
`/synthesize/stream` for raw `pcm_s16le` chunks used by the browser
AudioWorklet player.

## WebRTC Voice Gateway

Use this path when you want the browser to send and receive audio over WebRTC
instead of sending WAV/base64 chunks through Nest.

```bash
python3.10 -m venv .venv-voice
. .venv-voice/bin/activate
pip install -r services/local-ai/requirements-voice-webrtc.txt
deactivate
```

Run Nest with backend TTS disabled:

```bash
TTS_ENABLED=false pnpm start:dev
```

Run the gateway:

```bash
NEST_WS_URL=ws://127.0.0.1:3000/realtime pnpm local:voice:cuda
```

The gateway listens on `VOICE_GATEWAY_PORT` (`8004` by default). The browser
uses a WebSocket only for WebRTC signaling; STT and TTS run in-process inside
`webrtc_voice_gateway.py`, so you should no longer see `/transcribe` or
`/synthesize` requests for WebRTC voice sessions.

When the browser is on your laptop and the gateway is on a Brev/cloud GPU, SSH
port forwarding is not enough for WebRTC media. It forwards the signaling
WebSocket, but ICE still tries to connect private UDP candidates such as the GPU
host address and your laptop LAN address. Use a TURN server reachable by both
sides:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:turn.example.com:3478?transport=tcp"],"username":"voice","credential":"change-me"}]' \
WEBRTC_ICE_TRANSPORT_POLICY=relay \
NEST_WS_URL=ws://127.0.0.1:3000/realtime \
pnpm local:voice:cuda
```

You can also set `WEBRTC_STUN_URLS`, `WEBRTC_TURN_URLS`,
`WEBRTC_TURN_USERNAME`, and `WEBRTC_TURN_CREDENTIAL` instead of the JSON env.
For remote GPU testing through Brev, TCP TURN plus
`WEBRTC_ICE_TRANSPORT_POLICY=relay` avoids slow private-candidate attempts.

The gateway speaks an opening line when the WebRTC peer connects. Override it
with:

```bash
VOICE_GATEWAY_GREETING_TEXT="Hi, this is Northside Auto Service's AI receptionist. How can I help you today?"
```

If the assistant marks the call complete, the gateway waits for the final audio
to finish and then closes the WebRTC session.
