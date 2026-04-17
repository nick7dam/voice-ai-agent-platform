import io
import logging
import os
import time
from typing import Dict, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import StreamingResponse
from kokoro import KPipeline
from pydantic import BaseModel, Field


MODEL_NAME = os.getenv("LOCAL_TTS_MODEL", "hexgrad/Kokoro-82M")
DEFAULT_VOICE = os.getenv("LOCAL_TTS_VOICE", "af_heart")
DEFAULT_LANG_CODE = os.getenv("LOCAL_TTS_LANG_CODE", "a")
DEFAULT_SPEED = float(os.getenv("LOCAL_TTS_SPEED", "1"))
REQUESTED_DEVICE = os.getenv("LOCAL_TTS_DEVICE", "auto").lower()
PRELOAD = os.getenv("LOCAL_TTS_PRELOAD", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}
WARMUP_TEXT = os.getenv("LOCAL_TTS_WARMUP_TEXT", "Ready.")
THREADS = os.getenv("LOCAL_TTS_TORCH_THREADS")
PORT = int(os.getenv("LOCAL_TTS_PORT", "8002"))
SAMPLE_RATE = int(os.getenv("LOCAL_TTS_SAMPLE_RATE", "24000"))

logging.basicConfig(level=os.getenv("LOCAL_TTS_LOG_LEVEL", "INFO").upper())

if THREADS:
    torch.set_num_threads(int(THREADS))

logger = logging.getLogger("local_kokoro_tts")
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
        started_at = time.perf_counter()
        pipeline = KPipeline(lang_code=lang_code, device=resolve_device())
        pipelines[lang_code] = pipeline
        logger.info(
            "tts.pipeline.loaded lang=%s device=%s latencyMs=%d",
            lang_code,
            resolve_device(),
            elapsed_ms(started_at),
        )
    return pipeline


def elapsed_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


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


def iter_audio_parts(pipeline: KPipeline, text: str, voice: str, speed: float):
    with torch.inference_mode():
        generator = pipeline(text, voice=voice, speed=speed)

        for _, _, audio in generator:
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            yield np.asarray(audio, dtype=np.float32)


def generate_audio(text: str, voice: str, lang_code: str, speed: float):
    load_started_at = time.perf_counter()
    pipeline = get_pipeline(lang_code)
    load_latency_ms = elapsed_ms(load_started_at)

    synth_started_at = time.perf_counter()
    audio_parts = list(iter_audio_parts(pipeline, text, voice, speed))

    synth_latency_ms = elapsed_ms(synth_started_at)

    if not audio_parts:
        raise HTTPException(status_code=500, detail="Kokoro returned no audio")

    audio = (
        audio_parts[0]
        if len(audio_parts) == 1
        else np.concatenate(audio_parts)
    )

    return audio, load_latency_ms, synth_latency_ms


def audio_to_pcm16_bytes(audio: np.ndarray) -> bytes:
    if audio.size == 0:
        return b""

    clipped = np.clip(audio, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2", copy=False)
    return pcm.tobytes()


def warmup():
    started_at = time.perf_counter()
    audio, load_latency_ms, synth_latency_ms = generate_audio(
        WARMUP_TEXT,
        DEFAULT_VOICE,
        DEFAULT_LANG_CODE,
        DEFAULT_SPEED,
    )
    logger.info(
        "tts.warmup.end device=%s chars=%d audioSeconds=%.2f loadLatencyMs=%d synthLatencyMs=%d latencyMs=%d",
        resolve_device(),
        len(WARMUP_TEXT),
        len(audio) / SAMPLE_RATE,
        load_latency_ms,
        synth_latency_ms,
        elapsed_ms(started_at),
    )


@app.on_event("startup")
def startup():
    if PRELOAD:
        warmup()


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
        "preload": PRELOAD,
        "warmupText": WARMUP_TEXT,
        "torchThreads": torch.get_num_threads(),
        "sampleRate": SAMPLE_RATE,
        "loadedLanguages": sorted(pipelines.keys()),
    }


@app.post("/warmup")
def warmup_endpoint():
    started_at = time.perf_counter()
    warmup()
    return {
        "status": "ok",
        "latencyMs": elapsed_ms(started_at),
        "effectiveDevice": resolve_device(),
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

    try:
        audio, load_latency_ms, synth_latency_ms = generate_audio(
            text,
            voice,
            lang_code,
            speed,
        )
        encode_started_at = time.perf_counter()
        wav = io.BytesIO()
        sf.write(wav, audio, SAMPLE_RATE, format="WAV")
        encode_latency_ms = elapsed_ms(encode_started_at)
        latency_ms = elapsed_ms(started_at)
        audio_seconds = len(audio) / SAMPLE_RATE

        logger.info(
            "tts.synthesize.end device=%s voice=%s chars=%d audioSeconds=%.2f loadLatencyMs=%d synthLatencyMs=%d encodeLatencyMs=%d latencyMs=%d",
            resolve_device(),
            voice,
            len(text),
            audio_seconds,
            load_latency_ms,
            synth_latency_ms,
            encode_latency_ms,
            latency_ms,
        )

        return Response(
            content=wav.getvalue(),
            media_type="audio/wav",
            headers={
                "X-Model": MODEL_NAME,
                "X-Voice": voice,
                "X-Device": resolve_device(),
                "X-Text-Chars": str(len(text)),
                "X-Audio-Seconds": f"{audio_seconds:.3f}",
                "X-Load-Latency-Ms": str(load_latency_ms),
                "X-Synthesis-Latency-Ms": str(synth_latency_ms),
                "X-Encode-Latency-Ms": str(encode_latency_ms),
                "X-Latency-Ms": str(latency_ms),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/synthesize/stream")
def synthesize_stream(request: SynthesizeRequest):
    started_at = time.perf_counter()
    text = request.text.strip()

    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    voice = request.voice or DEFAULT_VOICE
    lang_code = request.langCode or DEFAULT_LANG_CODE
    speed = request.speed or DEFAULT_SPEED

    try:
        load_started_at = time.perf_counter()
        pipeline = get_pipeline(lang_code)
        load_latency_ms = elapsed_ms(load_started_at)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    def stream_pcm():
        first_chunk_latency_ms = None
        synth_started_at = time.perf_counter()
        chunk_count = 0
        audio_samples = 0

        try:
            for audio in iter_audio_parts(pipeline, text, voice, speed):
                pcm = audio_to_pcm16_bytes(audio)
                if not pcm:
                    continue

                if first_chunk_latency_ms is None:
                    first_chunk_latency_ms = elapsed_ms(started_at)

                chunk_count += 1
                audio_samples += len(audio)
                yield pcm
        except Exception:
            logger.exception(
                "tts.stream.error device=%s voice=%s chars=%d chunks=%d",
                resolve_device(),
                voice,
                len(text),
                chunk_count,
            )
            raise
        finally:
            synth_latency_ms = elapsed_ms(synth_started_at)
            latency_ms = elapsed_ms(started_at)
            logger.info(
                "tts.stream.end device=%s voice=%s chars=%d chunks=%d audioSeconds=%.2f loadLatencyMs=%d firstChunkLatencyMs=%s synthLatencyMs=%d latencyMs=%d",
                resolve_device(),
                voice,
                len(text),
                chunk_count,
                audio_samples / SAMPLE_RATE,
                load_latency_ms,
                (
                    str(first_chunk_latency_ms)
                    if first_chunk_latency_ms is not None
                    else "none"
                ),
                synth_latency_ms,
                latency_ms,
            )

    return StreamingResponse(
        stream_pcm(),
        media_type="audio/pcm",
        headers={
            "X-Model": MODEL_NAME,
            "X-Voice": voice,
            "X-Device": resolve_device(),
            "X-Text-Chars": str(len(text)),
            "X-Sample-Rate": str(SAMPLE_RATE),
            "X-Audio-Encoding": "pcm_s16le",
            "X-Load-Latency-Ms": str(load_latency_ms),
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
