# Local AI Voice Gateway

This folder now contains one local media service:

```text
webrtc_voice_gateway.py
```

It owns the realtime voice path:

- browser WebRTC audio input
- VAD and turn detection
- faster-whisper STT with `Systran/faster-distil-whisper-large-v3`
- Nest `/realtime` control websocket
- Chatterbox Turbo TTS with `ResembleAI/chatterbox-turbo`
- browser WebRTC audio output

## Install

```bash
python3 -m venv .venv-voice-chatterbox
.venv-voice-chatterbox/bin/python -m pip install --upgrade pip
.venv-voice-chatterbox/bin/python -m pip install -r services/local-ai/requirements-voice-chatterbox.txt
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
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3
LOCAL_CHATTERBOX_MODEL=ResembleAI/chatterbox-turbo
```

Optional Chatterbox reference voice:

```bash
LOCAL_CHATTERBOX_AUDIO_PROMPT_PATH=public/reference_audio.wav
```

Use a clean five to ten second WAV with one speaker and minimal background noise.

## WebRTC

For remote browsers, configure TURN:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:<public-ip>:3478?transport=tcp"],"username":"voice","credential":"change-me"}]'
WEBRTC_ICE_TRANSPORT_POLICY=relay
```

## Notes

There are no separate HTTP STT or TTS services in this cleaned build. STT and TTS both live in the WebRTC gateway process so media does not bounce through extra HTTP endpoints.
