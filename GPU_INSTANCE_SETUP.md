# GPU Instance Setup

This guide is for a fresh GPU VM running the cleaned WebRTC stack:

Browser
-> WebRTC gateway
-> faster-whisper `Systran/faster-distil-whisper-large-v3`
-> NestJS
-> Ollama
-> Qwen3-TTS `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
-> WebRTC audio

## 1. Base Packages

```bash
sudo apt update
sudo apt install -y git curl python3 python3-venv python3-pip ca-certificates gnupg
```

Install Node 22 and pnpm:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
corepack prepare pnpm@9.12.1 --activate
```

Check the host:

```bash
nvidia-smi
python3 --version
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

Install the voice Python environment:

```bash
python3 -m venv .venv-voice-chatterbox
.venv-voice-chatterbox/bin/python -m pip install --upgrade pip
.venv-voice-chatterbox/bin/python -m pip install -r services/local-ai/requirements-voice.txt
```

## 3. Ollama On GPU

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

Set in `.env`:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_THINK=false
```

## 4. TURN

If the browser connects from outside the VM network, run a TURN server. A common quick setup is `coturn`:

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

Open TCP `3478`, `80`, `443`, `3000`, and `8004` in the cloud firewall/security group as needed.

## 5. HTTPS With Caddy

For a domain such as `agent.example.com`, Caddy can proxy the UI and WebRTC signaling:

```caddyfile
agent.example.com {
  reverse_proxy /voice 127.0.0.1:8004
  reverse_proxy 127.0.0.1:3000
}
```

With the snap package, the config is usually:

```bash
sudo nano /var/snap/caddy/common/Caddyfile
sudo caddy adapt --config /var/snap/caddy/common/Caddyfile --adapter caddyfile > /tmp/caddy.json
sudo mv /tmp/caddy.json /var/snap/caddy/common/caddy.json
sudo snap restart caddy.server
```

Let’s Encrypt must be able to reach port `80` on the VM.

## 6. Run

Terminal 1:

```bash
pnpm run build
pnpm start:prod
```

Terminal 2:

```bash
pnpm local:voice:cuda
```

Watch GPU usage:

```bash
nvidia-smi
```

Open:

```text
https://your-domain
```

or with local forwarding:

```text
http://localhost:3000
```

## 7. Health Checks

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:11434/api/tags
python3 -m py_compile services/local-ai/webrtc_voice_gateway.py
```

Expected process split on GPU:

- `ollama` uses GPU when a model is loaded.
- `.venv-voice-chatterbox/bin/python` uses GPU for STT and Qwen3-TTS.

## 8. Common Issues

If signaling opens but media never connects:

- confirm TURN is reachable on TCP `3478`
- set `WEBRTC_ICE_TRANSPORT_POLICY=relay`
- restart `pnpm local:voice:cuda` after changing `.env`
- check that the UI received the right `iceServers` in the event log

If STT or TTS fails with CUDA library errors:

```bash
export LD_LIBRARY_PATH=$(./.venv-voice-chatterbox/bin/python scripts/print-cuda-library-path.py):$LD_LIBRARY_PATH
pnpm local:voice:cuda
```

If Qwen3-TTS downloads on first run, let it finish once. Later runs should use the Hugging Face cache.
