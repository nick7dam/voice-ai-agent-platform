import io
import os
import time
from typing import Dict, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Response
from kokoro import KPipeline
from pydantic import BaseModel, Field


MODEL_NAME = os.getenv("LOCAL_TTS_MODEL", "hexgrad/Kokoro-82M")
DEFAULT_VOICE = os.getenv("LOCAL_TTS_VOICE", "af_heart")
DEFAULT_LANG_CODE = os.getenv("LOCAL_TTS_LANG_CODE", "a")
DEFAULT_SPEED = float(os.getenv("LOCAL_TTS_SPEED", "1"))
REQUESTED_DEVICE = os.getenv("LOCAL_TTS_DEVICE", "auto").lower()
PORT = int(os.getenv("LOCAL_TTS_PORT", "8002"))
SAMPLE_RATE = int(os.getenv("LOCAL_TTS_SAMPLE_RATE", "24000"))

app = FastAPI(title="Local Kokoro TTS")
pipelines: Dict[str, KPipeline] = {}


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: Optional[str] = None
    langCode: Optional[str] = None
    speed: Optional[float] = Field(default=None, gt=0, le=3)


def get_pipeline(lang_code: str) -> KPipeline:
    pipeline = pipelines.get(lang_code)
    if pipeline is None:
        pipeline = KPipeline(lang_code=lang_code, device=resolve_device())
        pipelines[lang_code] = pipeline
    return pipeline


def resolve_device() -> str:
    if REQUESTED_DEVICE == "auto":
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    if REQUESTED_DEVICE not in {"cpu", "cuda", "mps"}:
        raise RuntimeError(
            "LOCAL_TTS_DEVICE must be one of: auto, cpu, cuda, mps"
        )

    return REQUESTED_DEVICE


@app.get("/health")
def health():
    return {
        "status": "ok",
        "provider": "local_kokoro",
        "model": MODEL_NAME,
        "voice": DEFAULT_VOICE,
        "langCode": DEFAULT_LANG_CODE,
        "requestedDevice": REQUESTED_DEVICE,
        "effectiveDevice": resolve_device(),
        "torchCudaAvailable": torch.cuda.is_available(),
        "torchCudaVersion": torch.version.cuda,
        "sampleRate": SAMPLE_RATE,
        "loadedLanguages": sorted(pipelines.keys()),
    }


@app.post("/synthesize")
def synthesize(request: SynthesizeRequest):
    started_at = time.perf_counter()
    text = request.text.strip()

    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    voice = request.voice or DEFAULT_VOICE
    lang_code = request.langCode or DEFAULT_LANG_CODE
    speed = request.speed or DEFAULT_SPEED
    pipeline = get_pipeline(lang_code)

    try:
        generator = pipeline(text, voice=voice, speed=speed)
        audio_parts = []

        for _, _, audio in generator:
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            audio_parts.append(np.asarray(audio, dtype=np.float32))

        if not audio_parts:
            raise HTTPException(status_code=500, detail="Kokoro returned no audio")

        audio = (
            audio_parts[0]
            if len(audio_parts) == 1
            else np.concatenate(audio_parts)
        )
        wav = io.BytesIO()
        sf.write(wav, audio, SAMPLE_RATE, format="WAV")
        latency_ms = int((time.perf_counter() - started_at) * 1000)

        return Response(
            content=wav.getvalue(),
            media_type="audio/wav",
            headers={
                "X-Model": MODEL_NAME,
                "X-Voice": voice,
                "X-Latency-Ms": str(latency_ms),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
