# Local AI Voice Gateway

This folder now contains one local media service:

```text
webrtc_voice_gateway.py
```

It owns the realtime voice path:

- browser WebRTC audio input
- VAD and turn detection
- faster-whisper STT with `distil-whisper/distil-large-v3.5-ct2`
- Nest `/realtime` control websocket
- Qwen3-TTS streaming CustomVoice with `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- browser WebRTC audio output

## Install

```bash
python3 -m venv .venv-voice-chatterbox
.venv-voice-chatterbox/bin/python -m pip install --upgrade pip
.venv-voice-chatterbox/bin/python -m pip install -r services/local-ai/requirements-voice.txt
```

## Run

CPU:

```bash
pnpm local:voice
```

CUDA:

```bash
pnpm local:voice:cuda
```

The gateway connects to Nest with:

```bash
NEST_WS_URL=ws://127.0.0.1:3000/realtime
```

## Models

```bash
LOCAL_STT_MODEL=distil-whisper/distil-large-v3.5-ct2
LOCAL_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
LOCAL_QWEN_TTS_SPEAKER=aiden
LOCAL_QWEN_TTS_STREAM_CHUNK_SIZE=4
```

Optional speaking style instruction:

```bash
LOCAL_QWEN_TTS_INSTRUCT="Warm, concise, friendly service receptionist."
```

The gateway uses `faster-qwen3-tts` so Qwen yields PCM chunks during generation instead of waiting for a full phrase to complete.

## WebRTC

For remote browsers, configure TURN:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:<public-ip>:3478?transport=tcp"],"username":"voice","credential":"change-me"}]'
WEBRTC_ICE_TRANSPORT_POLICY=relay
```

## Notes

There are no separate HTTP STT or TTS services in this cleaned build. STT and TTS both live in the WebRTC gateway process so media does not bounce through extra HTTP endpoints.
