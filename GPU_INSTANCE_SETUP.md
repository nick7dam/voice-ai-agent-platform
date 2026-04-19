# GPU Instance Setup

This guide is for a fresh NVIDIA GPU instance running the WebRTC voice path:

```text
browser mic
-> WebRTC voice gateway on GPU
-> local faster-whisper STT
-> NestJS /realtime
-> Ollama reasoning
-> local Kokoro TTS
-> WebRTC audio back to browser
```

In this mode, do not run the separate STT or TTS HTTP services. The WebRTC
gateway owns STT and TTS in one long-lived Python process.

## 1. Check The Machine

```bash
whoami
pwd
nvidia-smi
python3 --version
git --version
docker --version
docker compose version
```

Expected:

- Python 3.10 or 3.12 is fine for `.venv-voice`.
- `nvidia-smi` should show the GPU.
- Docker should be installed if you are running Ollama in Docker.

## 2. Install Node And pnpm

Skip this if `node`, `npm`, `corepack`, and `pnpm` already work.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
corepack prepare pnpm@9.12.1 --activate
```

Verify:

```bash
node --version
npm --version
corepack --version
pnpm --version
```

## 3. Clone And Install The App

```bash
git clone <your-git-repo-url> voice-ai-agent-platform
cd voice-ai-agent-platform
pnpm install --frozen-lockfile
```

If the repo is already cloned:

```bash
cd ~/voice-ai-agent-platform
git pull
pnpm install --frozen-lockfile
```

Build Nest:

```bash
pnpm run build
```

If `pnpm start:prod` later says `dist/main.js` is missing, run this build step
again.

## 4. Create The WebRTC Voice Python Env

Use one combined Python environment for WebRTC STT and TTS:

```bash
python3 -m venv .venv-voice
. .venv-voice/bin/activate
python -m pip install --upgrade pip setuptools wheel
pip install -r services/local-ai/requirements-voice-webrtc.txt
deactivate
```

Check that the CUDA library path can be printed:

```bash
.venv-voice/bin/python scripts/print-cuda-library-path.py
```

Kokoro is the default TTS engine. To test Chatterbox Turbo, create a separate
voice environment because Chatterbox pins newer `torch` and `transformers`
packages:

```bash
python3 -m venv .venv-voice-chatterbox
. .venv-voice-chatterbox/bin/activate
python -m pip install --upgrade pip setuptools wheel
pip install -r services/local-ai/requirements-voice-chatterbox.txt
deactivate
```

## 5. Start Ollama On The GPU

Recommended low-latency model:

```text
llama3.2:3b
```

Run Ollama in Docker with GPU access:

```bash
docker run -d \
  --gpus=all \
  --name ollama \
  --restart unless-stopped \
  -v ollama:/root/.ollama \
  -p 127.0.0.1:11434:11434 \
  ollama/ollama:latest
```

Pull the model:

```bash
docker exec -it ollama ollama pull llama3.2:3b
```

Optional higher-quality but slower model:

```bash
docker exec -it ollama ollama pull qwen3:8b
```

Verify:

```bash
curl http://127.0.0.1:11434/api/tags
docker exec -it ollama ollama ps
```

If the container already exists:

```bash
docker start ollama
```

## 6. Optional: Run TURN On The GPU Instance

Use this if your browser is on your laptop and the GPU is remote. SSH port
forwarding carries the signaling WebSocket, but WebRTC media still needs TURN.

Open/expose these ports in your GPU provider if possible:

```text
3478/tcp
3478/udp
49152-49200/udp
```

If only TCP is working, this project can run with TCP TURN:

```text
3478/tcp
```

Install coturn:

```bash
sudo apt update
sudo apt install -y coturn
```

Set these values:

```bash
export TURN_PUBLIC_IP=<gpu-public-ip>
export TURN_PRIVATE_IP=$(hostname -I | awk '{print $1}')
export TURN_PASSWORD=$(openssl rand -base64 24)
echo "$TURN_PASSWORD"
```

Write the coturn config:

```bash
sudo cp /etc/turnserver.conf /etc/turnserver.conf.bak
sudo tee /etc/turnserver.conf >/dev/null <<EOF
listening-port=3478
fingerprint
lt-cred-mech
user=voice:${TURN_PASSWORD}
realm=voice-agent
server-name=voice-agent
external-ip=${TURN_PUBLIC_IP}/${TURN_PRIVATE_IP}
min-port=49152
max-port=49200
no-multicast-peers
no-cli
EOF
```

Enable and start:

```bash
sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn
sudo ss -lntu | grep 3478
```

Keep `TURN_PUBLIC_IP` and `TURN_PASSWORD`; they go into `.env`.

## 7. Create `.env` For GPU WebRTC Mode

```bash
cp .env.example .env
nano .env
```

Use this as the important GPU/WebRTC section:

```bash
PORT=3000
WS_PATH=/realtime

STT_PROVIDER=local_whisper
REASONING_PROVIDER=ollama
TTS_PROVIDER=local_kokoro
TTS_ENABLED=false

OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_REQUEST_TIMEOUT_MS=180000
OLLAMA_NUM_PREDICT=120
OLLAMA_NUM_CTX=2048
OLLAMA_KEEP_ALIVE=30m
OLLAMA_THINK=false

DEFAULT_TASK_KEY=general_voice_assistant
TASK_CONFIG_PATH=data/tasks.local.json

VOICE_GATEWAY_HOST=0.0.0.0
VOICE_GATEWAY_PORT=8004
NEST_WS_URL=ws://127.0.0.1:3000/realtime
VOICE_GATEWAY_TTS_ENABLED=true
VOICE_GATEWAY_GREETING_ENABLED=true
VOICE_GATEWAY_GREETING_TEXT="Hi, this is the Northside Auto Service AI receptionist. I can help with bookings, hours, location, and service questions. How can I help you today?"

LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3
LOCAL_STT_DEVICE=cuda
LOCAL_STT_COMPUTE_TYPE=float16
LOCAL_STT_LANGUAGE=en

LOCAL_TTS_ENGINE=kokoro
LOCAL_TTS_MODEL=hexgrad/Kokoro-82M
LOCAL_TTS_VOICE=af_heart
LOCAL_TTS_SPEED=1
LOCAL_TTS_DEVICE=cuda
LOCAL_TTS_SAMPLE_RATE=24000

# Optional Chatterbox Turbo voice testing:
# LOCAL_TTS_ENGINE=chatterbox_turbo
# LOCAL_CHATTERBOX_AUDIO_PROMPT_PATH=/home/ubuntu/reference-voice.wav
# LOCAL_CHATTERBOX_EMOTION_TAGS=true
# VOICE_TTS_FIRST_PHRASE_MAX_CHARS=95
# VOICE_TTS_PHRASE_TARGET_CHARS=95
# VOICE_TTS_PHRASE_MAX_CHARS=145
# VOICE_TTS_MAX_SPOKEN_CHARS_PER_TURN=260
# VOICE_TTS_TRIM_SILENCE=true

VOICE_VAD_MIN_SPEECH_THRESHOLD=0.025
VOICE_VAD_SILENCE_MS=420
VOICE_VAD_BARGE_HOLD_MS=140
VOICE_VAD_BARGE_MIN_SPEECH_MS=240
VOICE_VAD_BARGE_MIN_PEAK_LEVEL=0.055
VOICE_VAD_BARGE_THRESHOLD_MULTIPLIER=2.4
VOICE_VAD_BARGE_START_GRACE_MS=350
```

If you configured TURN on the GPU instance, add this too:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:<gpu-public-ip>:3478?transport=tcp"],"username":"voice","credential":"<turn-password>"}]'
WEBRTC_ICE_TRANSPORT_POLICY=relay
```

Example:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:34.48.174.130:3478?transport=tcp"],"username":"voice","credential":"replace-with-your-turn-password"}]'
WEBRTC_ICE_TRANSPORT_POLICY=relay
```

Important: Nest automatically loads `.env`, but the Python gateway does not.
For the gateway terminal, source `.env` before running it.

## 8. Run Everything

Use three terminal sessions on the GPU.

Terminal 1: Ollama

```bash
docker start ollama
curl http://127.0.0.1:11434/api/tags
```

Terminal 2: Nest

```bash
cd ~/voice-ai-agent-platform
pnpm run build
TTS_ENABLED=false pnpm start:prod
```

Expected:

```text
Voice agent MVP listening on http://[::1]:3000
Realtime websocket path: /realtime
```

Terminal 3: WebRTC Voice Gateway

```bash
cd ~/voice-ai-agent-platform
set -a
source .env
set +a
pnpm local:voice:cuda
```

For Chatterbox Turbo instead of Kokoro, set `LOCAL_TTS_ENGINE=chatterbox_turbo`
and run the Chatterbox script:

```bash
LOCAL_TTS_ENGINE=chatterbox_turbo pnpm local:voice:chatterbox:cuda
```

Expected:

```text
voice.gateway.start host=0.0.0.0 port=8004 ... iceServers=1 iceTransportPolicy=relay
server listening on 0.0.0.0:8004
```

If you are not using TURN, `iceServers=0` is expected, but remote laptop to GPU
WebRTC may fail.

## 9. Access The UI From Your Laptop

For Brev, run port forwards on your laptop:

```bash
brev port-forward <instance-name> -p 3000:3000
brev port-forward <instance-name> -p 8004:8004
```

Open:

```text
http://127.0.0.1:3000
```

Use this WebRTC gateway URL in the UI:

```text
ws://127.0.0.1:8004
```

Click **Start WebRTC voice**. The assistant should greet you, then wait for the
purpose of the call.

## 10. Confirm GPU Usage

On the GPU:

```bash
nvidia-smi
```

You should see:

- `ollama`
- `.venv-voice/bin/python`

The old separate services should not be running in WebRTC mode:

```bash
pnpm local:stt:cuda
pnpm local:tts:cuda
```

Do not run those unless you are intentionally testing the old WebSocket/HTTP
audio path.

## 11. Health Checks

Nest:

```bash
curl http://127.0.0.1:3000/health
```

Ollama:

```bash
curl http://127.0.0.1:11434/api/tags
```

TURN:

```bash
sudo systemctl status coturn
sudo ss -lntu | grep 3478
```

WebRTC gateway:

```text
Look for: voice.signaling.connected
Look for: voice.signaling.message type=offer
Look for: voice.track.start kind=audio
```

## 12. Common Fixes

### `Cannot find module dist/main.js`

```bash
pnpm run build
pnpm start:prod
```

### `libcublas.so.12 is not found`

Make sure the voice venv installed the WebRTC requirements and use the pnpm CUDA
script:

```bash
.venv-voice/bin/python -m pip install -r services/local-ai/requirements-voice-webrtc.txt
pnpm local:voice:cuda
```

### Browser closes before sending `offer`

Open the UI through localhost:

```text
http://127.0.0.1:3000
```

Plain HTTP on a public IP can block microphone access.

### Signaling connects but media does not

Use TURN:

```bash
WEBRTC_ICE_TRANSPORT_POLICY=relay
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:<gpu-public-ip>:3478?transport=tcp"],"username":"voice","credential":"<turn-password>"}]'
```

The gateway log should show:

```text
iceServers=1 iceTransportPolicy=relay
```

### The assistant is not using the latest receptionist prompt

If you edited and saved the task in the UI before, `data/tasks.local.json` may
override the built-in task. In the UI, use:

```text
Task key: general_voice_assistant
Reset task
```

Then start a new WebRTC call.

## 13. Update Deployment Later

```bash
cd ~/voice-ai-agent-platform
git pull
pnpm install --frozen-lockfile
pnpm run build
```

Restart:

```bash
docker start ollama
TTS_ENABLED=false pnpm start:prod
```

In the gateway terminal:

```bash
set -a
source .env
set +a
pnpm local:voice:cuda
```
