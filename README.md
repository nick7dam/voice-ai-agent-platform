# Voice AI Agent Platform

Low-latency local voice-agent platform focused on one production transport path:

Browser microphone
-> WebRTC voice gateway
-> local faster-whisper STT
-> NestJS orchestration
-> Ollama Qwen reasoning
-> local Qwen3-TTS streaming CustomVoice
-> WebRTC audio back to the browser

The project intentionally does not include Groq providers, Laravel booking tools, Kokoro, direct browser audio-over-WebSocket, telephony, or backend business integrations in this cleaned build.

## What Runs Where

- `src/`: NestJS control plane, task configuration UI/API, session state, prompt building, Ollama adapter, and `/realtime` control websocket for the voice gateway.
- `services/local-ai/webrtc_voice_gateway.py`: WebRTC media gateway. It receives browser audio, handles VAD/turn detection, runs STT, sends final transcripts to Nest, receives streamed text chunks, and synthesizes Qwen3-TTS speech.
- `public/`: Minimal browser UI. It starts/stops WebRTC voice, shows chat history/events/latency, and edits the task purpose.

## Kept Components

- STT: `Systran/faster-distil-whisper-large-v3` through `faster-whisper`.
- Reasoning: Ollama `/api/chat`, defaulting to `qwen3:8b`.
- TTS: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` with streaming PCM chunks.
- Transport: browser WebRTC plus a small Nest websocket used only between the Python gateway and Nest.

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

Install the Python voice gateway environment:

```bash
python3 -m venv .venv-voice-chatterbox
.venv-voice-chatterbox/bin/python -m pip install --upgrade pip
.venv-voice-chatterbox/bin/python -m pip install -r services/local-ai/requirements-voice.txt
```

## Ollama

Start Ollama and pull a fast model:

```bash
ollama serve
ollama pull qwen3:8b
```

Set these in `.env` if needed:

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_THINK=false
```

On a GPU host using Docker, a typical Ollama command is:

```bash
docker run -d --name ollama --gpus all -p 11434:11434 -v ollama:/root/.ollama ollama/ollama
docker exec -it ollama ollama pull qwen3:8b
```

## Run Locally

Terminal 1, NestJS:

```bash
pnpm start:dev
```

Terminal 2, WebRTC voice gateway:

```bash
pnpm local:voice
```

For CUDA:

```bash
pnpm local:voice:cuda
```

Open:

```text
http://localhost:3000
```

Click `Start WebRTC voice`.

## TURN For Remote GPU

When the browser and GPU VM are not on the same network, WebRTC usually needs TURN. Set:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:<public-ip>:3478?transport=tcp"],"username":"voice","credential":"change-me"}]'
WEBRTC_ICE_TRANSPORT_POLICY=relay
```

Expose the UI through HTTPS when testing from a real browser. If Caddy proxies the app, route `/` to Nest on `3000` and `/voice` to the Python gateway on `8004`.

## Task Behavior

The task config lives in:

```text
src/modules/tasks/default-tasks.ts
```

At runtime, the UI saves overrides to:

```text
data/tasks.local.json
```

The active prompt is built in:

```text
src/modules/orchestrator/prompt-builder.service.ts
```

This cleaned build ignores tools and persistent memory. The UI still keeps the task form shape so the purpose, behavior guidelines, and response limits can be edited without changing the transport stack.

## Event Flow

The browser talks to the Python gateway over WebRTC signaling on `VOICE_GATEWAY_PORT`.

The Python gateway talks to Nest over `/realtime`:

```text
session.start
text.message
session.interrupt
session.end
```

Nest emits:

```text
session.started
transcript.final
reasoning.started
reasoning.first_token
assistant.text.chunk
assistant.response
session.interrupted
session.end_requested
session.ended
error
```

The Python gateway converts `assistant.text.chunk` events into Qwen3-TTS streaming audio chunks and sends each chunk back over the WebRTC media track as soon as it is generated.

## Useful Checks

```bash
pnpm run build
pnpm test
python3 -m py_compile services/local-ai/webrtc_voice_gateway.py
curl http://localhost:3000/health
```

## Extension Points

Future business integrations should be added as separate adapters or services around this transport core, not inside the media gateway. Good places to extend:

- new backend/tool bridge module in Nest
- per-task config for choosing allowed external capabilities
- a tool runtime that is independent of voice transport
- persistent session/memory store
- telephony adapter that reuses the same transcript and response events
