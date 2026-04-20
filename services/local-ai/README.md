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
- Qwen3-TTS voice clone with `Qwen/Qwen3-TTS-12Hz-0.6B-Base`
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
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3
LOCAL_TTS_ENGINE=qwen3_tts
LOCAL_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base
LOCAL_QWEN_TTS_REF_AUDIO_PATH=public/reference_audio.wav
```

Optional but recommended for stronger cloning quality:

```bash
LOCAL_QWEN_TTS_REF_TEXT="The exact transcript of the reference audio."
```

Use a clean five to ten second WAV with one speaker and minimal background noise.

The current local `qwen-tts` wrapper returns full audio for each queued phrase. The gateway still plays those phrases over WebRTC as soon as each one is synthesized; true Qwen audio-token streaming would require a lower-level Qwen integration.

## WebRTC

For remote browsers, configure TURN:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:<public-ip>:3478?transport=tcp"],"username":"voice","credential":"change-me"}]'
WEBRTC_ICE_TRANSPORT_POLICY=relay
```

## Notes

There are no separate HTTP STT or TTS services in this cleaned build. STT and TTS both live in the WebRTC gateway process so media does not bounce through extra HTTP endpoints.
