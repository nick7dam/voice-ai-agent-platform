# Local AI Services

These small FastAPI services let the NestJS app run without paid STT or TTS APIs.

## Exact Models

Use these first:

```text
STT: Systran/faster-distil-whisper-large-v3
Reasoning: llama3.2:3b through Ollama for low latency, or qwen3:8b for higher quality
TTS: hexgrad/Kokoro-82M
TTS voice: af_heart
```

Higher-accuracy STT option:

```text
Systran/faster-whisper-large-v3
```

Lower-latency STT option if available in your environment:

```text
Systran/faster-whisper-large-v3-turbo
```

## Install

Use separate virtual environments if you want clean dependency isolation:

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

On an NVIDIA host, install the extra CUDA runtime wheels into the STT venv:

```bash
.venv-stt/bin/python -m pip install -r services/local-ai/requirements-stt-cuda.txt
```

The first request downloads model files into the Hugging Face cache unless they
are already present.

## Run

STT:

```bash
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
LOCAL_STT_DEVICE=cpu \
LOCAL_STT_COMPUTE_TYPE=int8 \
LOCAL_STT_PRELOAD=true \
LOCAL_STT_WARMUP=true \
.venv-stt/bin/python services/local-ai/stt_server.py
```

TTS:

```bash
LOCAL_TTS_MODEL=hexgrad/Kokoro-82M \
LOCAL_TTS_VOICE=af_heart \
LOCAL_TTS_DEVICE=auto \
LOCAL_TTS_PRELOAD=true \
.venv-tts/bin/python services/local-ai/tts_server.py
```

Ollama:

```bash
ollama pull llama3.2:3b
ollama serve
```

## CUDA Host

For an NVIDIA CUDA host, install a CUDA-capable CTranslate2 build and run STT
with:

```bash
.venv-stt/bin/python -m pip install -r services/local-ai/requirements-stt-cuda.txt
export LD_LIBRARY_PATH="$(.venv-stt/bin/python scripts/print-cuda-library-path.py):${LD_LIBRARY_PATH:-}"
LOCAL_STT_DEVICE=cuda LOCAL_STT_COMPUTE_TYPE=float16 LOCAL_STT_PRELOAD=true LOCAL_STT_WARMUP=true .venv-stt/bin/python services/local-ai/stt_server.py
```

Or use the pnpm helper, which sets `LD_LIBRARY_PATH` for the process:

```bash
pnpm local:stt:cuda
```

Run local TTS on CUDA:

```bash
LOCAL_TTS_DEVICE=cuda \
LOCAL_TTS_PRELOAD=true \
.venv-tts/bin/python services/local-ai/tts_server.py
```

CPU STT is usable for testing, but a GPU instance is much better for production
latency.

The STT service preloads and warms Whisper by default. Use `/health` to confirm
`device`, `computeType`, and `loaded`, and `/warmup` if you want to warm it
again after startup.

The TTS service preloads and warms Kokoro by default. Use `/health` to confirm
`effectiveDevice` and `torchCudaAvailable`, and `/warmup` if you want to warm it
again after startup.
