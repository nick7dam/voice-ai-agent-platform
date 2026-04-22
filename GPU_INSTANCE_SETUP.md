# GPU Instance Setup

This guide is for a fresh GPU VM running the split local voice stack:

Browser
-> WebRTC voice gateway
-> local ASR sidecar
-> NestJS
-> Ollama
-> local Qwen3-TTS
-> WebRTC audio

## 1. Base Packages

```bash
sudo apt update
sudo apt install -y git curl python3.12 python3.12-venv python3-pip ca-certificates gnupg
```

Install Node 22 and pnpm:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@9.12.1 --activate
```

Check the host:

```bash
nvidia-smi
python3.12 --version
node --version
pnpm --version
```

## 2. Clone And Install

```bash
git clone <your-repo-url> voice-ai-agent-platform
cd voice-ai-agent-platform
pnpm install
cp .env.example .env
```

Create the ASR environment:

```bash
python3.12 -m venv .venv-asr
.venv-asr/bin/python -m pip install --upgrade pip
.venv-asr/bin/python -m pip install -r services/local-ai/requirements-asr.txt
```

Create the voice gateway / TTS environment:

```bash
python3.12 -m venv .venv-voice-chatterbox
.venv-voice-chatterbox/bin/python -m pip install --upgrade pip
.venv-voice-chatterbox/bin/python -m pip install -r services/local-ai/requirements-voice.txt
```

Build Nest once:

```bash
pnpm run build
```

## 3. `.env`

Set the important local values:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_THINK=false

LOCAL_STT_BACKEND=qwen_asr
LOCAL_STT_MODEL=Qwen/Qwen3-ASR-0.6B
LOCAL_STT_PRELOAD=true
LOCAL_ASR_HOST=127.0.0.1
LOCAL_ASR_PORT=8005
LOCAL_ASR_REQUEST_TIMEOUT_MS=20000

LOCAL_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
LOCAL_QWEN_TTS_SPEAKER=Aiden
LOCAL_TTS_PRELOAD=true
```

For CUDA on the ASR sidecar, the script already injects:

```bash
LOCAL_STT_DEVICE=cuda
LOCAL_STT_QWEN_DTYPE=bfloat16
```

For CUDA on the TTS gateway, the script already injects:

```bash
LOCAL_TTS_DEVICE=cuda
```

## 4. Ollama On GPU

With Docker:

```bash
docker run -d --name ollama --gpus all -p 11434:11434 -v ollama:/root/.ollama ollama/ollama
docker exec -it ollama ollama pull qwen3:8b
```

If Docker requires sudo:

```bash
sudo docker logs --tail=50 ollama
sudo docker exec -it ollama ollama ps
```

## 5. TURN

If the browser connects from outside the VM network, run a TURN server. A quick setup is `coturn`:

```bash
sudo apt install -y coturn
TURN_PASSWORD="$(openssl rand -base64 24)"
echo "TURN password: $TURN_PASSWORD"
```

Create `/etc/turnserver.conf`:

```bash
sudo tee /etc/turnserver.conf >/dev/null <<EOF
listening-port=3478
fingerprint
lt-cred-mech
user=voice:$TURN_PASSWORD
realm=voice-agent
no-multicast-peers
no-cli
EOF
```

Enable and start:

```bash
sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn || true
sudo systemctl enable --now coturn
sudo systemctl restart coturn
```

Set in `.env`, replacing `<public-ip>` and password:

```bash
WEBRTC_ICE_SERVERS_JSON='[{"urls":["turn:<public-ip>:3478?transport=tcp"],"username":"voice","credential":"<turn-password>"}]'
WEBRTC_ICE_TRANSPORT_POLICY=relay
```

Open TCP `3478`, `80`, `443`, `3000`, `8004`, and `8005` in the cloud firewall or security group if needed.

## 6. Run

Terminal 1, Nest:

```bash
pnpm start:prod
```

Terminal 2, ASR sidecar:

```bash
pnpm local:asr:cuda
```

Terminal 3, voice gateway:

```bash
pnpm local:voice:cuda
```

Watch GPU usage:

```bash
nvidia-smi
```

## 7. Health Checks

```bash
curl http://127.0.0.1:8005/health
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:11434/api/tags
python3 -m py_compile services/local-ai/asr_sidecar.py
python3 -m py_compile services/local-ai/webrtc_voice_gateway.py
```

Expected process split on GPU:

- `ollama` uses GPU when a model is loaded
- `.venv-asr/bin/python` uses GPU for Qwen3-ASR
- `.venv-voice-chatterbox/bin/python` uses GPU for Qwen3-TTS

## 8. Common Issues

If the browser connects but STT fails:

- confirm the ASR sidecar is running on `LOCAL_ASR_HOST:LOCAL_ASR_PORT`
- check `curl http://127.0.0.1:8005/health`
- restart `pnpm local:asr:cuda` after changing ASR env values

If signaling opens but media never connects:

- confirm TURN is reachable on TCP `3478`
- set `WEBRTC_ICE_TRANSPORT_POLICY=relay`
- restart `pnpm local:voice:cuda` after changing `.env`

If the ASR sidecar still fails on CUDA, reinstall a CUDA-enabled torch build in `.venv-asr`:

```bash
.venv-asr/bin/python -m pip install --upgrade "torch>=2.6,<3"
pnpm local:asr:cuda
```

If the voice gateway fails with CUDA library resolution errors:

```bash
export LD_LIBRARY_PATH=$(./.venv-voice-chatterbox/bin/python scripts/print-cuda-library-path.py):$LD_LIBRARY_PATH
pnpm local:voice:cuda
```
