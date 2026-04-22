# Local AI Voice Services

This folder contains the local speech services used by the platform:

```text
asr_sidecar.py
webrtc_voice_gateway.py
```

## Service Split

- `asr_sidecar.py`: owns Qwen3-ASR in its own Python environment
- `webrtc_voice_gateway.py`: handles browser WebRTC, VAD, turn detection, Nest websocket traffic, and Qwen3-TTS audio output

We split them because the official `qwen-asr` and `qwen-tts` packages currently pin incompatible `transformers` versions, so they cannot be installed cleanly into one Python environment.

## Install

ASR sidecar:

```bash
python3.12 -m venv .venv-asr
.venv-asr/bin/python -m pip install --upgrade pip
.venv-asr/bin/python -m pip install -r services/local-ai/requirements-asr.txt
```

Voice gateway:

```bash
python3.12 -m venv .venv-voice-chatterbox
.venv-voice-chatterbox/bin/python -m pip install --upgrade pip
.venv-voice-chatterbox/bin/python -m pip install -r services/local-ai/requirements-voice.txt
```

## Run

CPU:

```bash
pnpm local:asr
pnpm local:voice
```

CUDA:

```bash
pnpm local:asr:cuda
pnpm local:voice:cuda
```

The voice gateway connects to Nest with:

```bash
NEST_WS_URL=ws://127.0.0.1:3000/realtime
```

## Models And Key Env Vars

```bash
LOCAL_STT_BACKEND=qwen_asr
LOCAL_STT_MODEL=Qwen/Qwen3-ASR-0.6B
LOCAL_ASR_HOST=127.0.0.1
LOCAL_ASR_PORT=8005
LOCAL_ASR_REQUEST_TIMEOUT_MS=20000

LOCAL_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
LOCAL_QWEN_TTS_SPEAKER=Aiden
LOCAL_QWEN_TTS_STREAM_CHUNK_SIZE=4
```

Optional fallback if you want to A/B the previous STT path:

```bash
LOCAL_STT_BACKEND=faster_whisper
LOCAL_STT_MODEL=distil-whisper/distil-large-v3.5-ct2
```

Optional speaking style instruction:

```bash
LOCAL_QWEN_TTS_INSTRUCT="Warm, concise, friendly service receptionist."
```

## Local Endpoints

The ASR sidecar serves:

- `GET /health`
- `POST /transcribe`

The WebRTC gateway calls those endpoints locally whenever `LOCAL_STT_BACKEND=qwen_asr`.

## Checks

```bash
python3 -m py_compile services/local-ai/asr_sidecar.py
python3 -m py_compile services/local-ai/webrtc_voice_gateway.py
curl http://127.0.0.1:8005/health
```
