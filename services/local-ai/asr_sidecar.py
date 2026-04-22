import base64
import json
import logging
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

import numpy as np
import torch
from qwen_asr import Qwen3ASRModel


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


HOST = os.getenv("LOCAL_ASR_HOST", "127.0.0.1")
PORT = int(os.getenv("LOCAL_ASR_PORT", "8005"))

STT_MODEL_NAME = os.getenv("LOCAL_STT_MODEL", "Qwen/Qwen3-ASR-0.6B")
STT_DEVICE = os.getenv("LOCAL_STT_DEVICE", "cpu").strip().lower()
STT_LANGUAGE = os.getenv("LOCAL_STT_LANGUAGE", "en").strip() or None
STT_PRELOAD = env_bool("LOCAL_STT_PRELOAD", False)
STT_QWEN_DTYPE = os.getenv("LOCAL_STT_QWEN_DTYPE", "").strip().lower()
STT_QWEN_MAX_NEW_TOKENS = max(
    32, int(os.getenv("LOCAL_STT_QWEN_MAX_NEW_TOKENS", "256"))
)
STT_QWEN_USE_FLASH_ATTN = env_bool("LOCAL_STT_QWEN_USE_FLASH_ATTN", False)

logging.basicConfig(level=os.getenv("VOICE_GATEWAY_LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("asr_sidecar")

qwen_asr_model: Optional[Any] = None
model_lock = threading.Lock()


def elapsed_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


def resolve_qwen_asr_dtype() -> torch.dtype:
    raw = STT_QWEN_DTYPE or ("bfloat16" if STT_DEVICE == "cuda" else "float32")
    if raw in {"bf16", "bfloat16"}:
        return torch.bfloat16
    if raw in {"fp16", "float16", "half"}:
        return torch.float16
    if raw in {"fp32", "float32"}:
        return torch.float32
    raise RuntimeError(
        "LOCAL_STT_QWEN_DTYPE must be one of: bfloat16, float16, float32"
    )


def resolve_qwen_asr_language(raw_language: Optional[str]) -> Optional[str]:
    source = raw_language or STT_LANGUAGE
    if not source:
        return None

    normalized = source.strip().lower()
    aliases = {
        "en": "English",
        "english": "English",
        "zh": "Chinese",
        "chinese": "Chinese",
        "yue": "Cantonese",
        "cantonese": "Cantonese",
        "de": "German",
        "german": "German",
        "fr": "French",
        "french": "French",
        "es": "Spanish",
        "spanish": "Spanish",
        "it": "Italian",
        "italian": "Italian",
        "pt": "Portuguese",
        "portuguese": "Portuguese",
        "ja": "Japanese",
        "japanese": "Japanese",
        "ko": "Korean",
        "korean": "Korean",
    }
    return aliases.get(normalized, source)


def get_qwen_asr_model() -> Any:
    global qwen_asr_model
    if qwen_asr_model is None:
        started_at = time.perf_counter()
        model_kwargs: Dict[str, Any] = {
            "dtype": resolve_qwen_asr_dtype(),
            "device_map": "cuda:0" if STT_DEVICE == "cuda" else STT_DEVICE,
            "max_inference_batch_size": 1,
            "max_new_tokens": STT_QWEN_MAX_NEW_TOKENS,
        }
        if STT_QWEN_USE_FLASH_ATTN and STT_DEVICE == "cuda":
            model_kwargs["attn_implementation"] = "flash_attention_2"

        qwen_asr_model = Qwen3ASRModel.from_pretrained(
            STT_MODEL_NAME,
            **model_kwargs,
        )
        logger.info(
            "asr.loaded model=%s device=%s dtype=%s latencyMs=%d",
            STT_MODEL_NAME,
            STT_DEVICE,
            resolve_qwen_asr_dtype(),
            elapsed_ms(started_at),
        )
    return qwen_asr_model


def transcribe_pcm16_base64(
    samples_b64: str,
    sample_rate: int,
    language: Optional[str],
) -> Dict[str, Any]:
    started_at = time.perf_counter()
    pcm_bytes = base64.b64decode(samples_b64)
    samples_i16 = np.frombuffer(pcm_bytes, dtype=np.int16)
    samples = samples_i16.astype(np.float32) / 32768.0

    with model_lock:
        results = get_qwen_asr_model().transcribe(
            audio=(samples, sample_rate),
            language=resolve_qwen_asr_language(language),
        )

    first = results[0] if results else None
    text = ""
    detected_language = None
    if first is not None:
        if hasattr(first, "text"):
            text = str(first.text).strip()
        elif isinstance(first, dict):
            text = str(first.get("text") or "").strip()

        if hasattr(first, "language"):
            detected_language = str(first.language)
        elif isinstance(first, dict) and first.get("language"):
            detected_language = str(first.get("language"))

    return {
        "text": text,
        "language": detected_language,
        "latencyMs": elapsed_ms(started_at),
    }


class AsrHandler(BaseHTTPRequestHandler):
    server_version = "LocalAsrSidecar/1.0"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        self.send_json(
            HTTPStatus.OK,
            {
                "status": "ok",
                "provider": "qwen_asr",
                "model": STT_MODEL_NAME,
                "device": STT_DEVICE,
                "dtype": str(resolve_qwen_asr_dtype()),
                "preloaded": qwen_asr_model is not None,
            },
        )

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length)
            body = json.loads(raw_body.decode("utf-8"))
            samples_b64 = str(body.get("samplesB64") or "").strip()
            if not samples_b64:
                raise ValueError("samplesB64 is required")

            sample_rate = int(body.get("sampleRate") or 16000)
            language = body.get("language")
            # These fields are forwarded by the gateway for future compatibility.
            body.get("initialPrompt")
            body.get("hotwords")
            result = transcribe_pcm16_base64(samples_b64, sample_rate, language)
            self.send_json(HTTPStatus.OK, result)
        except Exception as exc:
            logger.exception("asr.transcribe.error error=%s", exc)
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "error": str(exc),
                },
            )

    def log_message(self, format: str, *args: Any) -> None:
        logger.info("asr.http " + format, *args)

    def send_json(self, status: HTTPStatus, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def preload_model() -> None:
    started_at = time.perf_counter()
    with model_lock:
        get_qwen_asr_model()
    logger.info("asr.preload.end latencyMs=%d", elapsed_ms(started_at))


def main() -> None:
    if STT_PRELOAD:
        preload_model()

    server = ThreadingHTTPServer((HOST, PORT), AsrHandler)
    logger.info(
        "asr.sidecar.start host=%s port=%d model=%s device=%s dtype=%s preload=%s",
        HOST,
        PORT,
        STT_MODEL_NAME,
        STT_DEVICE,
        resolve_qwen_asr_dtype(),
        STT_PRELOAD,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("asr.sidecar.stop")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
