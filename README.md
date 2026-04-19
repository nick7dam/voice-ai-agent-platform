# Voice AI Agent Platform

Backend-first low-latency voice-agent MVP built with Node.js, TypeScript, NestJS, pnpm, Zod, local Whisper STT, Ollama reasoning, local Kokoro TTS, WebSockets, and an optional WebRTC media gateway.

For a fresh NVIDIA GPU deployment, use
[`GPU_INSTANCE_SETUP.md`](GPU_INSTANCE_SETUP.md).

The runtime flow is:

```text
browser or CLI audio input
-> explicit turn end
-> buffered turn transcription with local faster-whisper
-> prompt builder with purpose + session memory + recent history
-> Ollama reasoning with local tool calling
-> optional booking API tools on http://127.0.0.1:8000
-> plain text assistant response over WebSocket
-> optional local Kokoro speech playback
```

The lower-latency WebRTC path is:

```text
browser mic WebRTC track
-> Python WebRTC voice gateway
-> in-process faster-whisper STT
-> Nest /realtime websocket for reasoning + tools
-> assistant.text.chunk events
-> in-process Kokoro TTS
-> WebRTC audio track back to browser
```

In WebRTC mode there are no per-turn HTTP calls to `/transcribe`,
`/synthesize`, or `/synthesize/stream`. Nest still talks to Ollama through
Ollama's local HTTP API.

The primary assistant response is always emitted as plain text inside structured JSON websocket events. Local text-to-speech is optional and runs behind the same modular output boundary. There is no telephony. The car booking backend is integrated through a configurable tool connector, so the core voice platform can still be reused for other domains.

## Architecture

```text
src/
  main.ts                         # Nest bootstrap, .env loading, static local demo
  app.module.ts                   # Module composition
  common/
    constants/                    # Injection tokens
    types/                        # Realtime, session, STT, LLM, tool contracts
    utils/                        # Timing and safe arithmetic parser
  config/
    env.schema.ts                 # Zod env validation
    app.config.ts                 # Normalized runtime config
    dotenv.ts                     # Tiny local .env loader
  modules/
    gateway/                      # Raw WebSocket session gateway at /realtime
    sessions/                     # In-memory session store abstraction
    stt/                          # STT interface + local Whisper/Groq adapters
    reasoning/                    # LLM interface + Groq/Ollama adapters
    tools/                        # Tool registry/runtime + demo tools
    memory/                       # Session memory facade
    orchestrator/                 # Transcript -> reasoning -> tools -> final text
    tasks/                        # Purpose/task registry
    health/                       # GET /health
public/                           # Minimal browser test page
services/local-ai/                # Local faster-whisper, Kokoro, and WebRTC media gateway
scripts/local-client.ts           # CLI websocket test client
```

## Setup

Install dependencies:

```bash
pnpm install
```

Create local environment config:

```bash
cp .env.example .env
```

The default `.env.example` is configured for a fully local model stack:

```text
STT_PROVIDER=local_whisper
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3
LOCAL_STT_BASE_URL=http://localhost:8001
LOCAL_STT_LANGUAGE=en
LOCAL_STT_VAD_FILTER=false
LOCAL_STT_PRELOAD=true
LOCAL_STT_WARMUP=true
PARTIAL_STT_ENABLED=false

REASONING_PROVIDER=ollama
OLLAMA_MODEL=llama3.2:3b
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_NUM_PREDICT=120
OLLAMA_NUM_CTX=2048
OLLAMA_KEEP_ALIVE=30m
OLLAMA_THINK=false

BOOKING_API_BASE_URL=http://127.0.0.1:8000
BOOKING_API_KEY=
BOOKING_API_TIMEOUT_MS=10000
BOOKING_API_HEALTH_PATH=/workshop/services

TTS_PROVIDER=local_kokoro
TTS_ENABLED=true
TTS_PLAYBACK_MODE=streaming_phrases
TTS_CONCURRENCY=1
LOCAL_TTS_MODEL=hexgrad/Kokoro-82M
LOCAL_TTS_VOICE=af_heart
LOCAL_TTS_BASE_URL=http://localhost:8002
LOCAL_TTS_DEVICE=auto
LOCAL_TTS_PRELOAD=true
LOCAL_TTS_SAMPLE_RATE=24000
```

Recommended model names:

- STT: `Systran/faster-distil-whisper-large-v3`
- Reasoning: `llama3.2:3b` for low latency, or `qwen3:8b` when quality matters more than speed
- TTS: `hexgrad/Kokoro-82M`
- TTS voice: `af_heart`

## Run Local Models

Install the local service dependencies:

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

On an NVIDIA host, install the STT CUDA runtime wheels:

```bash
.venv-stt/bin/python -m pip install -r services/local-ai/requirements-stt-cuda.txt
```

Run local STT:

```bash
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
LOCAL_STT_DEVICE=cpu \
LOCAL_STT_COMPUTE_TYPE=int8 \
LOCAL_STT_LANGUAGE=en \
LOCAL_STT_VAD_FILTER=false \
pnpm local:stt
```

Run local TTS:

```bash
LOCAL_TTS_MODEL=hexgrad/Kokoro-82M \
LOCAL_TTS_VOICE=af_heart \
LOCAL_TTS_DEVICE=auto \
LOCAL_TTS_PRELOAD=true \
LOCAL_TTS_SAMPLE_RATE=24000 \
pnpm local:tts
```

Run Ollama:

```bash
ollama pull llama3.2:3b
ollama serve
```

For an NVIDIA CUDA host, install a CUDA-capable CTranslate2 build and run STT
with:

```bash
pnpm local:stt:cuda
```

Run local TTS with CUDA:

```bash
LOCAL_TTS_DEVICE=cuda \
LOCAL_TTS_PRELOAD=true \
LOCAL_TTS_SAMPLE_RATE=24000 \
pnpm local:tts
```

See `services/local-ai/README.md` for more local model details.

## WebRTC Voice Gateway

The WebRTC gateway replaces the separate STT/TTS HTTP services for browser
voice. It keeps Whisper and the selected local TTS engine loaded in one long-lived Python process,
receives browser microphone audio as a WebRTC track, sends recognized text to
Nest over `/realtime`, then streams synthesized audio back as a WebRTC audio
track.

Install a combined voice environment:

```bash
python3.10 -m venv .venv-voice
. .venv-voice/bin/activate
pip install -r services/local-ai/requirements-voice-webrtc.txt
deactivate
```

Run Nest with TTS disabled for this path, because the gateway owns TTS:

```bash
TTS_ENABLED=false pnpm start:dev
```

Run the gateway on an NVIDIA host:

```bash
NEST_WS_URL=ws://127.0.0.1:3000/realtime pnpm local:voice:cuda
```

Kokoro is the default gateway TTS engine. To try Resemble Chatterbox Turbo, use a
separate venv because Chatterbox pins different `torch` and `transformers`
versions:

```bash
python3.10 -m venv .venv-voice-chatterbox
. .venv-voice-chatterbox/bin/activate
pip install --upgrade pip setuptools wheel
pip install -r services/local-ai/requirements-voice-chatterbox.txt
deactivate
```

Then run:

```bash
LOCAL_TTS_ENGINE=chatterbox_turbo \
LOCAL_CHATTERBOX_AUDIO_PROMPT_PATH=/absolute/path/to/reference-voice.wav \
VOICE_TTS_FIRST_PHRASE_MAX_CHARS=95 \
VOICE_TTS_PHRASE_TARGET_CHARS=95 \
VOICE_TTS_MAX_SPOKEN_CHARS_PER_TURN=260 \
VOICE_TTS_TRIM_SILENCE=true \
NEST_WS_URL=ws://127.0.0.1:3000/realtime \
pnpm local:voice:chatterbox:cuda
```

The Chatterbox path keeps the assistant response text plain. The gateway may add
small TTS-only paralinguistic cues such as `[chuckle]` to the audio prompt when
`LOCAL_CHATTERBOX_EMOTION_TAGS=true`; those tags are not sent to chat history.
Chatterbox Turbo generates complete audio for each text phrase, so the gateway
uses natural phrase boundaries, trims generated silence, and caps spoken
characters per turn while the full assistant text still appears in the UI.

Then open `http://localhost:3000`, use **Start WebRTC voice**, and leave the old
**Start live mic** button alone. The old WebSocket voice path remains available
as a fallback.

If the browser is not on the same machine/network as the GPU host, WebRTC needs
reachable ICE candidates. In practice that means exposing the gateway port and,
for many cloud/NAT setups, adding a TURN server. SSH port-forwarding only the
HTTP UI port is usually not enough for WebRTC media.

For Brev or another remote GPU reached through SSH port forwarding, signaling can
connect while media still fails because the browser and GPU advertise private
network candidates that cannot reach each other. Configure a TURN server that is
reachable by both sides:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:turn.example.com:3478?transport=tcp"],"username":"voice","credential":"change-me"}]' \
WEBRTC_ICE_TRANSPORT_POLICY=relay \
NEST_WS_URL=ws://127.0.0.1:3000/realtime \
pnpm local:voice:cuda
```

The gateway sends that ICE config to the browser and uses the same config in
`aiortc`. `WEBRTC_ICE_TRANSPORT_POLICY=relay` tells the browser to use TURN
instead of first trying private host candidates. STUN alone is usually not
enough for a cloud GPU behind NAT; TURN is the reliable path.

The WebRTC gateway also owns the spoken call greeting:

```bash
VOICE_GATEWAY_GREETING_TEXT="Hi, this is Northside Auto Service's AI receptionist. How can I help you today?"
```

For receptionist tasks, the model can append the hidden `[[END_CALL]]` marker
when the customer clearly finishes the call. The UI strips that marker, lets the
final response play, and then closes the WebRTC session so a new call starts
with **Start WebRTC voice**.

## Optional Groq Fallback

Groq providers are still available by changing env vars:

```text
STT_PROVIDER=groq
REASONING_PROVIDER=groq
TTS_PROVIDER=groq
GROQ_API_KEY=your-key
GROQ_STT_MODEL=whisper-large-v3-turbo
GROQ_LLM_MODEL=llama-3.1-8b-instant
GROQ_TTS_MODEL=canopylabs/orpheus-v1-english
```

`OLLAMA_REQUEST_TIMEOUT_MS` controls the full `/api/chat` request timeout. Increase it for slower remote models or cold starts.
`OLLAMA_NUM_PREDICT` caps generated tokens for voice latency. Lower it for snappier replies, for example `80`.
`OLLAMA_KEEP_ALIVE` keeps the model loaded after a request so the next turn avoids a cold start.
`OLLAMA_THINK=false` disables supported model thinking output/effort, which is useful for low-latency voice turns.
`MIN_STT_AUDIO_BYTES` is a backend guard: turns smaller than this are discarded before STT.
`LOCAL_STT_LANGUAGE=en` skips Whisper language detection for faster English transcription. Set it to an empty value only if you need automatic language detection.
`LOCAL_STT_VAD_FILTER=false` is fastest because the browser VAD already gates turns before STT.
`LOCAL_STT_PRELOAD=true` and `LOCAL_STT_WARMUP=true` load and exercise Whisper when the service starts, so GPU/library problems fail fast instead of during the first user turn.
`VOICE_TRANSCRIPT_COALESCING_ENABLED=true` lets the WebRTC gateway merge nearby STT fragments before reasoning. This is important for phone numbers, regos, and callers who pause mid-sentence. `VOICE_TRANSCRIPT_STRUCTURED_COMMIT_DELAY_MS` is the short wait for likely complete structured values; `VOICE_TRANSCRIPT_INCOMPLETE_STRUCTURED_COMMIT_DELAY_MS` is the longer wait for partial-looking values.
`PARTIAL_STT_ENABLED=false` avoids extra partial Whisper calls while the user is still speaking. Turn it on only when you want live partial transcript text and can afford the extra GPU work.
The browser sends throttled `audio.partial` snapshots while speech is active. If `PARTIAL_STT_ENABLED=true`, the backend emits `transcript.partial` for live feedback, then waits for `audio.turn_end` before sending the final transcript to reasoning.
`TTS_ENABLED` controls optional speech playback. Text is still emitted as plain `assistant.response`; with streaming phrase playback, audio chunks may arrive before the final text event.
`TTS_PLAYBACK_MODE=streaming_phrases` speaks short phrases from the LLM stream for the most natural local demo. With local Kokoro, the backend uses `/synthesize/stream` and sends raw `pcm_s16le` chunks to the browser `AudioWorklet` player. With Chatterbox Turbo, the WebRTC gateway uses phrase-ahead synthesis because Chatterbox returns one waveform per phrase. Use `first_sentence` or `first_segment` to speak less, or `full` to wait and synthesize the full response.
`TTS_CONCURRENCY=1` is recommended for local Kokoro so multiple audio chunks do not fight for the same GPU.

## Run

Development:

```bash
pnpm start:dev
```

Production build:

```bash
pnpm build
pnpm start:prod
```

Health check:

```bash
curl http://localhost:3000/health
```

Browser demo:

```text
http://localhost:3000
```

The browser demo keeps the microphone open and uses lightweight client-side voice activity detection. It captures local PCM audio with a short pre-roll buffer, discards noise/silence false starts before they reach the backend, then sends accepted utterances as a valid WAV `audio.chunk` followed by `audio.turn_end`. The backend buffers each accepted utterance, transcribes the complete turn with the configured STT adapter, and sends only the final transcript to the reasoning pipeline.

## CLI Test Client

Text-only debug path, useful before starting STT:

```bash
pnpm client -- --text "Remember that my favorite demo color is green."
```

Audio-file path:

```bash
pnpm client -- --file ./sample.wav --mime audio/wav
```

The client connects to `ws://localhost:3000/realtime`, starts a session, sends either text or one audio turn, prints all server events, and ends the session.

## WebSocket Event Flow

Client starts a session:

```json
{ "type": "session.start", "payload": { "taskKey": "general_voice_assistant" } }
```

Server responds:

```json
{
  "type": "session.started",
  "payload": {
    "sessionId": "...",
    "taskKey": "general_voice_assistant",
    "wsPath": "/realtime"
  }
}
```

Client starts a continuous audio stream:

```json
{
  "type": "audio.stream_start",
  "sessionId": "...",
  "payload": { "mimeType": "audio/wav" }
}
```

Client sends an accepted utterance:

Before the final utterance is sent, the browser may send repeated partial STT snapshots while speech is active:

```json
{
  "type": "audio.partial",
  "sessionId": "...",
  "payload": {
    "audioBase64": "...",
    "mimeType": "audio/wav",
    "sampleRate": 48000,
    "sequence": 1
  }
}
```

The server responds with `transcript.partial` events for UI feedback only. Reasoning still starts after the final transcript.

```json
{
  "type": "audio.chunk",
  "sessionId": "...",
  "payload": {
    "audioBase64": "...",
    "mimeType": "audio/wav",
    "sampleRate": 48000
  }
}
```

After silence, the client ends the current utterance:

```json
{ "type": "audio.turn_end", "sessionId": "...", "payload": {} }
```

Server emits:

```text
audio.stream.started
transcript.partial optional, repeated during speech
audio.chunk.received
transcript.final
reasoning.started
session.interrupted optional
tool.called       optional
tool.result       optional
assistant.audio.started optional, may arrive before assistant.response
assistant.audio.chunk   optional, may arrive before assistant.response; local Kokoro uses streaming pcm_s16le chunks
assistant.response
assistant.audio.ended   optional
```

If the user starts speaking while the assistant is still reasoning, the browser only sends an interruption after that speech passes the local utterance gate:

```json
{
  "type": "session.interrupt",
  "sessionId": "...",
  "payload": { "reason": "user_started_speaking" }
}
```

The stale assistant turn is suppressed, and the new utterance becomes the active turn.

Debug text can bypass STT:

```json
{
  "type": "text.message",
  "sessionId": "...",
  "payload": { "text": "What time is it?" }
}
```

End a session:

```json
{ "type": "session.end", "sessionId": "...", "payload": {} }
```

Errors are structured:

```json
{
  "type": "error",
  "payload": {
    "code": "GROQ_NOT_CONFIGURED",
    "message": "GROQ_API_KEY is not configured. Add it to .env before sending audio.",
    "recoverable": true
  }
}
```

## Purpose And Memory

The default assistant purpose lives in:

```text
src/modules/tasks/default-tasks.ts
```

Runtime edits from the local browser UI are saved to:

```text
data/tasks.local.json
```

Set `TASK_CONFIG_PATH` to use a different local JSON file. The Task Settings
editor on the browser page loads the active task key, saves changes through
`PUT /tasks/:taskKey`, and the next turn for that task uses the updated config.

The task config controls:

- `systemPrompt`
- `behaviorGuidelines`
- `allowedTools`
- `responsePolicy`
- `memoryPolicy`

Session memory is in-memory for the MVP. The model can write memory only through the `remember_fact` tool, and prompt construction injects only a bounded set of recent memory facts.

Prompt construction lives in:

```text
src/modules/orchestrator/prompt-builder.service.ts
```

## Tools

Built-in utility tools:

- `get_current_time`
- `remember_fact`
- `list_memory`

Car service API tools:

- `get_workshop_info`
- `find_customer_by_phone`
- `create_customer`
- `find_vehicle_by_rego`
- `create_vehicle`
- `find_latest_booking_by_phone`
- `check_booking_availability`
- `create_booking`
- `create_escalation`

These tools call the booking API configured by `BOOKING_API_BASE_URL`, defaulting to `http://127.0.0.1:8000`. If the API needs auth, set `BOOKING_API_KEY`; it is sent as `X-API-Key`.

The connector mirrors the imported receptionist backend endpoints:

- `GET /workshop/hours`, `GET /workshop/today-hours`, `GET /workshop/services`, `GET /workshop/address`
- `GET /customers/search?phone=...`, `POST /customers`
- `GET /vehicles/search?rego=...`, `POST /vehicles`
- `GET /bookings/search?phone=...`, `POST /bookings/check-availability`, `POST /bookings`
- `POST /escalations`

Each tool has a name, description, Zod input schema, JSON-schema-like parameters for the LLM, and a deterministic `execute()` method. The older local demo car-service tools remain registered for local experiments, but the default receptionist task now uses the API-backed tools.

Add future tools under:

```text
src/modules/tools/tools/
```

Then register them in:

```text
src/modules/tools/tool-registry.service.ts
src/modules/tools/tools.module.ts
```

## Future Extension Points

Current implementation:

- TTS lives in `src/modules/tts/`.
- It is disabled unless `TTS_ENABLED=true`.
- Kokoro is the default local TTS provider. Groq Orpheus remains available through `TTS_PROVIDER=groq`.
- Local Kokoro exposes both `/synthesize` for full WAV synthesis and `/synthesize/stream` for raw PCM streaming.
- Responses are split into short segments and played in order by the browser. Streaming local chunks are played by `public/audio-player.worklet.js`.
- The browser can toggle audio playback with the `Audio on/off` button. This also disables backend TTS synthesis for the session to avoid unnecessary spend.
- TTS logs estimated character cost as `tts.cost ... estimatedUsd=...` and cache hits as `tts.cache.hit ...`. Local Kokoro estimates cost as zero.

Other intended extension points:

- Telephony: add a transport module beside `gateway/`, not inside reasoning or STT.
- Redis session store: replace the `SessionsService` map with a store interface implementation.
- Multiple tasks: add more task configs to `default-tasks.ts` or load them from local JSON.
- External tools/backends: add tools through the tool registry and validate all inputs with Zod.
- Browser client: expand `public/` without changing websocket event contracts.
- Server-side VAD and endpointing: move the current browser VAD into `gateway/` while preserving explicit `audio.turn_end`.
- Streaming STT: extend the `SttAdapter` interface with partial events.
- Persistent memory: replace `MemoryService` storage with a local file, Redis, or database adapter.

## Important MVP Boundaries

- TTS is optional and disabled unless `TTS_ENABLED=true`.
- No telephony is implemented.
- No Laravel or external business backend integration is implemented.
- No database is required.
- Assistant responses are plain text strings in websocket JSON events.
