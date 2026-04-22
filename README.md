# Voice AI Agent Platform

Low-latency local voice-agent platform with a split local speech stack:

Browser microphone
-> WebRTC voice gateway
-> local ASR sidecar
-> NestJS orchestration
-> Ollama Qwen reasoning
-> local Qwen3-TTS
-> WebRTC audio back to the browser

The current architecture keeps ASR and TTS in separate Python environments because the official `qwen-asr` and `qwen-tts` packages pin incompatible `transformers` versions.

## What Runs Where

- `src/`: NestJS control plane, task config, session state, prompt building, Ollama adapter, and `/realtime` control websocket for the Python voice gateway.
- `services/local-ai/asr_sidecar.py`: Local HTTP sidecar that owns Qwen3-ASR in its own Python environment.
- `services/local-ai/webrtc_voice_gateway.py`: WebRTC media gateway. It receives browser audio, handles VAD and turn detection, forwards STT requests to the ASR sidecar, sends final transcripts to Nest, receives streamed text chunks, and synthesizes Qwen3-TTS speech.
- `public/`: Minimal browser UI for starting/stopping WebRTC voice and viewing events and latency.

## Kept Components

- ASR: `Qwen/Qwen3-ASR-0.6B` through `qwen-asr`, running in `services/local-ai/asr_sidecar.py`
- Reasoning: Ollama `/api/chat`, defaulting to `qwen3:8b`
- TTS: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- Transport: browser WebRTC plus the Nest `/realtime` websocket between the gateway and Nest

`faster-whisper` is still installed in the voice gateway environment as an optional fallback backend, but the primary path is the Qwen ASR sidecar.

## Setup

Install Node dependencies:

```bash
corepack enable
corepack prepare pnpm@9.12.1 --activate
pnpm install
```

Create `.env`:

```bash
cp .env.example .env
```

Create the TTS / gateway environment:

```bash
python3.12 -m venv .venv-voice-chatterbox
.venv-voice-chatterbox/bin/python -m pip install --upgrade pip
.venv-voice-chatterbox/bin/python -m pip install -r services/local-ai/requirements-voice.txt
```

Create the ASR environment:

```bash
python3.12 -m venv .venv-asr
.venv-asr/bin/python -m pip install --upgrade pip
.venv-asr/bin/python -m pip install -r services/local-ai/requirements-asr.txt
```

## Ollama

Start Ollama and pull a fast local reasoning model:

```bash
ollama serve
ollama pull qwen3:8b
```

Useful `.env` values:

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_THINK=false
```

## Local Run

Terminal 1, NestJS:

```bash
pnpm start:dev
```

Terminal 2, ASR sidecar:

```bash
pnpm local:asr
```

Terminal 3, WebRTC voice gateway:

```bash
pnpm local:voice
```

For CUDA:

```bash
pnpm local:asr:cuda
pnpm local:voice:cuda
```

Open:

```text
http://localhost:3000
```

## Important `.env` Values

```bash
LOCAL_STT_BACKEND=qwen_asr
LOCAL_STT_MODEL=Qwen/Qwen3-ASR-0.6B
LOCAL_ASR_HOST=127.0.0.1
LOCAL_ASR_PORT=8005
LOCAL_ASR_REQUEST_TIMEOUT_MS=20000

LOCAL_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
LOCAL_QWEN_TTS_SPEAKER=Aiden
```

The ASR sidecar exposes:

- `GET /health`
- `POST /transcribe`

The WebRTC gateway calls those endpoints locally when `LOCAL_STT_BACKEND=qwen_asr`.

If you want to A/B against the fallback stack:

```bash
LOCAL_STT_BACKEND=faster_whisper
LOCAL_STT_MODEL=distil-whisper/distil-large-v3.5-ct2
```

## Event Flow

1. The browser sends microphone audio to the WebRTC voice gateway.
2. The gateway does VAD and turn detection.
3. Final audio chunks are sent to the ASR sidecar over local HTTP.
4. Final transcripts are sent from the gateway to Nest over `/realtime`.
5. Nest runs prompt building and Ollama reasoning.
6. Streamed assistant text goes back to the gateway.
7. The gateway turns text into Qwen3-TTS audio and streams it back over WebRTC.

## TURN For Remote GPU

When the browser and GPU VM are not on the same network, WebRTC usually needs TURN:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:<public-ip>:3478?transport=tcp"],"username":"voice","credential":"change-me"}]'
WEBRTC_ICE_TRANSPORT_POLICY=relay
```

## Useful Checks

```bash
pnpm run build
pnpm test -- --runInBand
python3 -m py_compile services/local-ai/asr_sidecar.py
python3 -m py_compile services/local-ai/webrtc_voice_gateway.py
curl http://127.0.0.1:8005/health
curl http://127.0.0.1:3000/health
```

## Extension Points

Good places to extend from here:

- alternate local ASR backends behind the sidecar interface
- per-task prompt or behavior config in Nest
- business integrations around the Nest control plane
- telephony adapters that reuse the same transcript and response events
