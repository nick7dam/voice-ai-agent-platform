import base64
import os
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from faster_whisper import WhisperModel
from pydantic import BaseModel


MODEL_NAME = os.getenv("LOCAL_STT_MODEL", "Systran/faster-distil-whisper-large-v3")
DEVICE = os.getenv("LOCAL_STT_DEVICE", "cpu")
DEFAULT_COMPUTE_TYPE = "float16" if DEVICE == "cuda" else "int8"
COMPUTE_TYPE = os.getenv("LOCAL_STT_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE)
PORT = int(os.getenv("LOCAL_STT_PORT", "8003"))
VAD_FILTER = os.getenv("LOCAL_STT_VAD_FILTER", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}

app = FastAPI(title="Local Whisper STT")
model: Optional[WhisperModel] = None


class TranscribeRequest(BaseModel):
    audioBase64: str
    mimeType: str = "audio/wav"
    sampleRate: Optional[int] = None
    sessionId: Optional[str] = None
    turnId: Optional[str] = None
    language: Optional[str] = None


def get_model() -> WhisperModel:
    global model
    if model is None:
        try:
            model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
        except ValueError as exc:
            message = str(exc)
            if DEVICE == "cuda" and "CUDA support" in message:
                raise RuntimeError(
                    "LOCAL_STT_DEVICE is set to cuda, but the installed "
                    "CTranslate2 package is CPU-only. Use "
                    "LOCAL_STT_DEVICE=cpu LOCAL_STT_COMPUTE_TYPE=int8 on this "
                    "machine, or install a CUDA-enabled CTranslate2 build on "
                    "your NVIDIA host."
                ) from exc
            raise
    return model


def extension_for_mime(mime_type: str) -> str:
    if "wav" in mime_type:
        return ".wav"
    if "mpeg" in mime_type or "mp3" in mime_type:
        return ".mp3"
    if "ogg" in mime_type:
        return ".ogg"
    if "mp4" in mime_type:
        return ".mp4"
    return ".webm"


@app.get("/health")
def health():
    return {
        "status": "ok",
        "provider": "local_whisper",
        "model": MODEL_NAME,
        "device": DEVICE,
        "computeType": COMPUTE_TYPE,
        "vadFilter": VAD_FILTER,
        "loaded": model is not None,
    }


@app.post("/transcribe")
def transcribe(request: TranscribeRequest):
    started_at = time.perf_counter()

    try:
        audio = base64.b64decode(request.audioBase64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="audioBase64 is invalid") from exc

    suffix = extension_for_mime(request.mimeType)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
        temp_file.write(audio)
        temp_path = Path(temp_file.name)

    try:
        segments, info = get_model().transcribe(
            str(temp_path),
            language=request.language,
            beam_size=1,
            best_of=1,
            vad_filter=VAD_FILTER,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        latency_ms = int((time.perf_counter() - started_at) * 1000)

        return {
            "text": text,
            "language": getattr(info, "language", None),
            "durationSeconds": getattr(info, "duration", None),
            "model": MODEL_NAME,
            "latencyMs": latency_ms,
        }
    finally:
        temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
