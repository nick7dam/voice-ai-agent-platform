# Local AI Services

These small FastAPI services let the NestJS app run without paid STT or TTS APIs.

## Exact Models

Use these first:

```text
STT: Systran/faster-distil-whisper-large-v3
Reasoning: qwen3:8b through Ollama
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

The first request downloads model files into the Hugging Face cache unless they
are already present.

## Run

STT:

```bash
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
LOCAL_STT_DEVICE=cpu \
LOCAL_STT_COMPUTE_TYPE=int8 \
.venv-stt/bin/python services/local-ai/stt_server.py
```

TTS:

```bash
LOCAL_TTS_MODEL=hexgrad/Kokoro-82M \
LOCAL_TTS_VOICE=af_heart \
.venv-tts/bin/python services/local-ai/tts_server.py
```

Ollama:

```bash
ollama pull qwen3:8b
ollama serve
```

## CUDA Host

For an NVIDIA CUDA host, install a CUDA-capable CTranslate2 build and run STT
with:

```bash
LOCAL_STT_DEVICE=cuda \
LOCAL_STT_COMPUTE_TYPE=float16 \
.venv-stt/bin/python services/local-ai/stt_server.py
```

CPU STT is usable for testing, but a GPU instance is much better for production
latency.
