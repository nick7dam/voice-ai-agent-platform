import asyncio
import inspect
import json
import logging
import os
import re
import tempfile
import time
import wave
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import torch
import websockets
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
    MediaStreamTrack,
)
from av import AudioFrame
from av.audio.resampler import AudioResampler
from faster_whisper import WhisperModel


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


HOST = os.getenv("VOICE_GATEWAY_HOST", "0.0.0.0")
PORT = int(os.getenv("VOICE_GATEWAY_PORT", "8004"))
NEST_WS_URL = os.getenv("NEST_WS_URL", "ws://127.0.0.1:3000/realtime")
DEFAULT_TASK_KEY = os.getenv("DEFAULT_TASK_KEY", "general_voice_assistant")

STT_MODEL_NAME = os.getenv("LOCAL_STT_MODEL", "Systran/faster-distil-whisper-large-v3")
STT_DEVICE = os.getenv("LOCAL_STT_DEVICE", "cpu")
DEFAULT_STT_COMPUTE_TYPE = "float16" if STT_DEVICE == "cuda" else "int8"
STT_COMPUTE_TYPE = os.getenv("LOCAL_STT_COMPUTE_TYPE", DEFAULT_STT_COMPUTE_TYPE)
STT_LANGUAGE = os.getenv("LOCAL_STT_LANGUAGE", "en").strip() or None
STT_PRELOAD = env_bool("LOCAL_STT_PRELOAD", False)

TTS_PROVIDER = "qwen3_tts"
TTS_DEVICE = os.getenv("LOCAL_TTS_DEVICE", "auto").lower()
TTS_SAMPLE_RATE = int(os.getenv("LOCAL_TTS_SAMPLE_RATE", "24000"))
TTS_PRELOAD = env_bool("LOCAL_TTS_PRELOAD", False)
TTS_WARMUP_TEXT = os.getenv("LOCAL_TTS_WARMUP_TEXT", "Ready.").strip()
TTS_ENABLED = env_bool("VOICE_GATEWAY_TTS_ENABLED", True)
GREETING_ENABLED = env_bool("VOICE_GATEWAY_GREETING_ENABLED", True)
GREETING_TEXT = os.getenv(
    "VOICE_GATEWAY_GREETING_TEXT",
    "Hi, this is your AI voice assistant. How can I help you today?",
)
CALL_END_MARKER = "[[END_CALL]]"
CALL_END_AUDIO_TAIL_MS = int(os.getenv("VOICE_CALL_END_AUDIO_TAIL_MS", "650"))
OUTPUT_DRAIN_POLL_MS = int(os.getenv("VOICE_OUTPUT_DRAIN_POLL_MS", "50"))
OUTPUT_DRAIN_MAX_MS = int(os.getenv("VOICE_OUTPUT_DRAIN_MAX_MS", "30000"))

QWEN_TTS_MODEL_NAME = os.getenv(
    "LOCAL_QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
)
QWEN_TTS_LANGUAGE = os.getenv("LOCAL_QWEN_TTS_LANGUAGE", "English").strip() or "Auto"
QWEN_TTS_SPEAKER = os.getenv("LOCAL_QWEN_TTS_SPEAKER", "aiden").strip()
QWEN_TTS_INSTRUCT = os.getenv("LOCAL_QWEN_TTS_INSTRUCT", "").strip() or None
QWEN_TTS_DTYPE = os.getenv("LOCAL_QWEN_TTS_DTYPE", "bfloat16").strip().lower()
QWEN_TTS_ATTN_IMPLEMENTATION = os.getenv(
    "LOCAL_QWEN_TTS_ATTN_IMPLEMENTATION", "sdpa"
).strip()
QWEN_TTS_NON_STREAMING_MODE = env_bool("LOCAL_QWEN_TTS_NON_STREAMING_MODE", False)
QWEN_TTS_TEMPERATURE = float(os.getenv("LOCAL_QWEN_TTS_TEMPERATURE", "0.85"))
QWEN_TTS_TOP_P = float(os.getenv("LOCAL_QWEN_TTS_TOP_P", "0.95"))
QWEN_TTS_TOP_K = int(os.getenv("LOCAL_QWEN_TTS_TOP_K", "50"))
QWEN_TTS_REPETITION_PENALTY = float(
    os.getenv("LOCAL_QWEN_TTS_REPETITION_PENALTY", "1.05")
)
QWEN_TTS_MAX_NEW_TOKENS = int(os.getenv("LOCAL_QWEN_TTS_MAX_NEW_TOKENS", "2048"))
QWEN_TTS_MIN_NEW_TOKENS = int(os.getenv("LOCAL_QWEN_TTS_MIN_NEW_TOKENS", "2"))
QWEN_TTS_DO_SAMPLE = env_bool("LOCAL_QWEN_TTS_DO_SAMPLE", True)
QWEN_TTS_STREAM_CHUNK_SIZE = max(
    1, int(os.getenv("LOCAL_QWEN_TTS_STREAM_CHUNK_SIZE", "4"))
)
QWEN_TTS_MAX_SEQ_LEN = int(os.getenv("LOCAL_QWEN_TTS_MAX_SEQ_LEN", "2048"))

TTS_MIN_PHRASE_CHARS = max(1, int(os.getenv("VOICE_TTS_MIN_PHRASE_CHARS", "8")))
TTS_PHRASE_TARGET_CHARS = max(
    TTS_MIN_PHRASE_CHARS, int(os.getenv("VOICE_TTS_PHRASE_TARGET_CHARS", "95"))
)
TTS_PHRASE_MAX_CHARS = max(
    TTS_PHRASE_TARGET_CHARS, int(os.getenv("VOICE_TTS_PHRASE_MAX_CHARS", "145"))
)
TTS_FIRST_PHRASE_MAX_CHARS = max(
    TTS_MIN_PHRASE_CHARS, int(os.getenv("VOICE_TTS_FIRST_PHRASE_MAX_CHARS", "95"))
)
TTS_MAX_SPOKEN_CHARS_PER_TURN = max(
    0, int(os.getenv("VOICE_TTS_MAX_SPOKEN_CHARS_PER_TURN", "260"))
)
TTS_TRIM_SILENCE = env_bool("VOICE_TTS_TRIM_SILENCE", True)
TTS_TRIM_SILENCE_THRESHOLD = float(
    os.getenv("VOICE_TTS_TRIM_SILENCE_THRESHOLD", "0.008")
)
TTS_TRIM_SILENCE_KEEP_MS = int(os.getenv("VOICE_TTS_TRIM_SILENCE_KEEP_MS", "80"))

INPUT_SAMPLE_RATE = 16000
MIN_SPEECH_THRESHOLD = float(os.getenv("VOICE_VAD_MIN_SPEECH_THRESHOLD", "0.025"))
NOISE_MULTIPLIER = float(os.getenv("VOICE_VAD_NOISE_MULTIPLIER", "3.0"))
SILENCE_MS = int(os.getenv("VOICE_VAD_SILENCE_MS", "420"))
MAX_UTTERANCE_MS = int(os.getenv("VOICE_VAD_MAX_UTTERANCE_MS", "8000"))
MIN_UTTERANCE_MS = int(os.getenv("VOICE_VAD_MIN_UTTERANCE_MS", "320"))
MIN_SPEECH_MS = int(os.getenv("VOICE_VAD_MIN_SPEECH_MS", "240"))
MIN_BARGE_SPEECH_MS = int(os.getenv("VOICE_VAD_BARGE_MIN_SPEECH_MS", "240"))
END_THRESHOLD_PEAK_RATIO = float(os.getenv("VOICE_VAD_END_PEAK_RATIO", "0.35"))
MIN_PEAK_LEVEL = float(os.getenv("VOICE_VAD_MIN_PEAK_LEVEL", "0.035"))
BARGE_MIN_PEAK_LEVEL = float(os.getenv("VOICE_VAD_BARGE_MIN_PEAK_LEVEL", "0.055"))
BARGE_THRESHOLD_MULTIPLIER = float(
    os.getenv("VOICE_VAD_BARGE_THRESHOLD_MULTIPLIER", "2.4")
)
BARGE_HOLD_MS = int(os.getenv("VOICE_VAD_BARGE_HOLD_MS", "140"))
BARGE_START_GRACE_MS = int(os.getenv("VOICE_VAD_BARGE_START_GRACE_MS", "350"))
PREROLL_MS = int(os.getenv("VOICE_VAD_PREROLL_MS", "450"))
TRANSCRIPT_COALESCING_ENABLED = env_bool("VOICE_TRANSCRIPT_COALESCING_ENABLED", True)
TRANSCRIPT_COMMIT_DELAY_MS = int(os.getenv("VOICE_TRANSCRIPT_COMMIT_DELAY_MS", "650"))
TRANSCRIPT_STRUCTURED_COMMIT_DELAY_MS = int(
    os.getenv("VOICE_TRANSCRIPT_STRUCTURED_COMMIT_DELAY_MS", "1200")
)
TRANSCRIPT_INCOMPLETE_STRUCTURED_COMMIT_DELAY_MS = int(
    os.getenv("VOICE_TRANSCRIPT_INCOMPLETE_STRUCTURED_COMMIT_DELAY_MS", "4000")
)
TRANSCRIPT_MAX_COALESCE_MS = int(os.getenv("VOICE_TRANSCRIPT_MAX_COALESCE_MS", "12000"))
TRANSCRIPT_MIN_FINAL_WORDS = int(os.getenv("VOICE_TRANSCRIPT_MIN_FINAL_WORDS", "5"))
STT_QUEUE_MAX_SIZE = max(1, int(os.getenv("VOICE_STT_QUEUE_MAX_SIZE", "6")))
GATEWAY_BLOCKING_PRELOAD = env_bool("VOICE_GATEWAY_BLOCKING_PRELOAD", True)

WEBRTC_ICE_SERVERS_JSON = os.getenv("WEBRTC_ICE_SERVERS_JSON", "").strip()
WEBRTC_STUN_URLS = os.getenv("WEBRTC_STUN_URLS", "").strip()
WEBRTC_TURN_URLS = os.getenv("WEBRTC_TURN_URLS", "").strip()
WEBRTC_TURN_USERNAME = os.getenv("WEBRTC_TURN_USERNAME", "").strip()
WEBRTC_TURN_CREDENTIAL = os.getenv("WEBRTC_TURN_CREDENTIAL", "").strip()
WEBRTC_ICE_TRANSPORT_POLICY = os.getenv("WEBRTC_ICE_TRANSPORT_POLICY", "all").strip()
WEBRTC_SERVER_ICE_SERVERS_JSON = os.getenv(
    "WEBRTC_SERVER_ICE_SERVERS_JSON", ""
).strip()
WEBRTC_SERVER_USE_BROWSER_ICE = env_bool("WEBRTC_SERVER_USE_BROWSER_ICE", False)

logging.basicConfig(level=os.getenv("VOICE_GATEWAY_LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("webrtc_voice_gateway")

whisper_model: Optional[WhisperModel] = None
qwen_tts_model: Optional[Any] = None


def comma_list(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def normalized_browser_ice_server(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None

    urls = raw.get("urls") or raw.get("url")
    if isinstance(urls, str):
        normalized_urls: Any = urls.strip()
    elif isinstance(urls, list):
        normalized_urls = [str(url).strip() for url in urls if str(url).strip()]
    else:
        return None

    if not normalized_urls:
        return None

    server: Dict[str, Any] = {"urls": normalized_urls}
    username = raw.get("username")
    credential = raw.get("credential") or raw.get("password")

    if username:
        server["username"] = str(username)
    if credential:
        server["credential"] = str(credential)

    return server


def browser_ice_servers() -> List[Dict[str, Any]]:
    if WEBRTC_ICE_SERVERS_JSON:
        return parse_ice_servers_json(WEBRTC_ICE_SERVERS_JSON, "voice.ice")

    servers: List[Dict[str, Any]] = []
    stun_urls = comma_list(WEBRTC_STUN_URLS)
    turn_urls = comma_list(WEBRTC_TURN_URLS)

    if stun_urls:
        servers.append({"urls": stun_urls if len(stun_urls) > 1 else stun_urls[0]})

    if turn_urls:
        turn_server: Dict[str, Any] = {
            "urls": turn_urls if len(turn_urls) > 1 else turn_urls[0]
        }
        if WEBRTC_TURN_USERNAME:
            turn_server["username"] = WEBRTC_TURN_USERNAME
        if WEBRTC_TURN_CREDENTIAL:
            turn_server["credential"] = WEBRTC_TURN_CREDENTIAL
        servers.append(turn_server)

    return servers


def parse_ice_servers_json(value: str, log_prefix: str) -> List[Dict[str, Any]]:
    if value:
        try:
            raw_servers = json.loads(value)
        except json.JSONDecodeError as exc:
            logger.warning("%s.invalid_json error=%s", log_prefix, exc)
            return []

        if not isinstance(raw_servers, list):
            logger.warning("%s.invalid_json_shape expected=list", log_prefix)
            return []

        return [
            server
            for server in (
                normalized_browser_ice_server(raw_server)
                for raw_server in raw_servers
            )
            if server is not None
        ]

    return []


def server_ice_servers() -> List[Dict[str, Any]]:
    if WEBRTC_SERVER_ICE_SERVERS_JSON:
        return parse_ice_servers_json(
            WEBRTC_SERVER_ICE_SERVERS_JSON, "voice.server_ice"
        )

    if WEBRTC_SERVER_USE_BROWSER_ICE:
        return browser_ice_servers()

    return []


def aiortc_ice_servers() -> List[RTCIceServer]:
    servers: List[RTCIceServer] = []

    for server in server_ice_servers():
        servers.append(
            RTCIceServer(
                urls=server["urls"],
                username=server.get("username"),
                credential=server.get("credential"),
            )
        )

    return servers


def browser_ice_transport_policy() -> str:
    if WEBRTC_ICE_TRANSPORT_POLICY in {"all", "relay"}:
        return WEBRTC_ICE_TRANSPORT_POLICY

    logger.warning(
        "voice.ice.invalid_transport_policy value=%s", WEBRTC_ICE_TRANSPORT_POLICY
    )
    return "all"


def elapsed_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


def get_whisper_model() -> WhisperModel:
    global whisper_model
    if whisper_model is None:
        started_at = time.perf_counter()
        whisper_model = WhisperModel(
            STT_MODEL_NAME,
            device=STT_DEVICE,
            compute_type=STT_COMPUTE_TYPE,
        )
        logger.info(
            "voice.stt.loaded model=%s device=%s computeType=%s latencyMs=%d",
            STT_MODEL_NAME,
            STT_DEVICE,
            STT_COMPUTE_TYPE,
            elapsed_ms(started_at),
        )
    return whisper_model


def resolve_tts_device() -> str:
    if TTS_DEVICE == "auto":
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    if TTS_DEVICE not in {"cpu", "cuda", "mps"}:
        raise RuntimeError("LOCAL_TTS_DEVICE must be one of: auto, cpu, cuda, mps")

    return TTS_DEVICE


def call_with_supported_kwargs(fn: Any, **kwargs: Any) -> Any:
    signature = inspect.signature(fn)
    accepts_kwargs = any(
        param.kind == inspect.Parameter.VAR_KEYWORD
        for param in signature.parameters.values()
    )
    if accepts_kwargs:
        return fn(**kwargs)

    supported = set(signature.parameters)
    filtered = {key: value for key, value in kwargs.items() if key in supported}
    dropped = sorted(set(kwargs) - set(filtered))
    if dropped:
        logger.debug(
            "voice.compat.filtered_kwargs fn=%s dropped=%s",
            getattr(fn, "__name__", fn.__class__.__name__),
            ",".join(dropped),
        )
    return fn(**filtered)


def resolve_qwen_tts_dtype() -> torch.dtype:
    if QWEN_TTS_DTYPE in {"bf16", "bfloat16"}:
        return torch.bfloat16
    if QWEN_TTS_DTYPE in {"fp16", "float16", "half"}:
        return torch.float16
    if QWEN_TTS_DTYPE in {"fp32", "float32"}:
        return torch.float32
    raise RuntimeError(
        "LOCAL_QWEN_TTS_DTYPE must be one of: bfloat16, float16, float32"
    )


def resolve_qwen_tts_device() -> str:
    device = resolve_tts_device()
    if device == "cuda":
        return "cuda"
    raise RuntimeError(
        "The Qwen3-TTS path requires CUDA. Set LOCAL_TTS_DEVICE=cuda."
    )


def ensure_qwen_custom_voice_config() -> None:
    if "customvoice" not in QWEN_TTS_MODEL_NAME.lower():
        raise RuntimeError(
            "The low-latency streaming path uses a Qwen3-TTS CustomVoice model. "
            "Set LOCAL_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice."
        )

    if not QWEN_TTS_SPEAKER:
        raise RuntimeError(
            "LOCAL_QWEN_TTS_SPEAKER is required for Qwen3-TTS CustomVoice."
        )


def get_qwen_tts_model() -> Any:
    global qwen_tts_model

    if qwen_tts_model is not None:
        return qwen_tts_model

    try:
        from faster_qwen3_tts import FasterQwen3TTS
    except ImportError as exc:
        raise RuntimeError(
            "faster-qwen3-tts is not installed. Install "
            "services/local-ai/requirements-voice.txt in the voice "
            "gateway environment, then restart the gateway."
        ) from exc

    ensure_qwen_custom_voice_config()
    started_at = time.perf_counter()
    load_kwargs: Dict[str, Any] = {
        "device": resolve_qwen_tts_device(),
        "dtype": resolve_qwen_tts_dtype(),
        "max_seq_len": QWEN_TTS_MAX_SEQ_LEN,
    }
    if QWEN_TTS_ATTN_IMPLEMENTATION:
        load_kwargs["attn_implementation"] = QWEN_TTS_ATTN_IMPLEMENTATION

    logger.info(
        "voice.tts.qwen.load.start model=%s device=%s dtype=%s attn=%s speaker=%s chunkSize=%d",
        QWEN_TTS_MODEL_NAME,
        load_kwargs["device"],
        QWEN_TTS_DTYPE,
        QWEN_TTS_ATTN_IMPLEMENTATION or "default",
        QWEN_TTS_SPEAKER,
        QWEN_TTS_STREAM_CHUNK_SIZE,
    )
    qwen_tts_model = FasterQwen3TTS.from_pretrained(
        QWEN_TTS_MODEL_NAME,
        **load_kwargs,
    )
    logger.info(
        "voice.tts.loaded engine=qwen3_tts model=%s device=%s sampleRate=%s latencyMs=%d",
        QWEN_TTS_MODEL_NAME,
        resolve_tts_device(),
        TTS_SAMPLE_RATE,
        elapsed_ms(started_at),
    )
    return qwen_tts_model


def normalize_text_for_speech(text: str) -> str:
    def replace_time(match: re.Match[str]) -> str:
        hour = int(match.group(1))
        minute = int(match.group(2) or "0")
        meridiem = (match.group(3) or "").lower().replace(".", "")
        return format_time_for_speech(hour, minute, meridiem or None)

    text = strip_paralinguistic_tags(strip_tts_asides(text))
    text = re.sub(
        r"\b([01]?\d|2[0-3]):([0-5]\d)\s*(a\.?m\.?|p\.?m\.?)?\b",
        replace_time,
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\b(0?[1-9]|1[0-2])\s*(a\.?m\.?|p\.?m\.?)\b",
        lambda match: format_time_for_speech(
            int(match.group(1)),
            0,
            match.group(2).lower().replace(".", ""),
        ),
        text,
        flags=re.IGNORECASE,
    )
    replacements = [
        (r"\bi\.?\s*e\.?(?=\W|$)", "that is"),
        (r"\be\.?\s*g\.?(?=\W|$)", "for example"),
        (r"\betc(?=\W|$)", "and so on"),
        (r"\bapprox\.?(?=\W|$)", "approximately"),
        (r"\basap\b", "as soon as possible"),
        (r"\beta\b", "estimated arrival time"),
        (r"\bvin\b", "vehicle identification number"),
        (r"\brego\b", "registration"),
        (r"\bno\.\s*(?=\d)", "number "),
        (r"\bvs\.?(?=\W|$)", "versus"),
    ]
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    text = (
        text.replace("&", "and")
        .replace("@", " at ")
        .replace(" VIC", " Victoria")
        .replace(" NSW", " New South Wales")
        .replace(" QLD", " Queensland")
        .replace(" ACT", " Australian Capital Territory")
        .replace(" WA", " Western Australia")
        .replace(" SA", " South Australia")
        .replace(" TAS", " Tasmania")
        .replace(" NT", " Northern Territory")
    )
    text = re.sub(r"\s+([.,!?;:])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def strip_paralinguistic_tags(text: str) -> str:
    return re.sub(
        r"\s*\[(?:laugh|laughter|chuckle|cough|sigh|gasp|breath|sniff|clear throat|clears throat)\]\s*",
        " ",
        text,
        flags=re.IGNORECASE,
    )


def strip_tts_asides(text: str) -> str:
    text = text.replace(CALL_END_MARKER, "")

    def replace_parenthetical(match: re.Match[str]) -> str:
        content = match.group(1).strip()
        if re.fullmatch(r"[\d\s+\-]+", content):
            return f" {content} "
        return " "

    text = re.sub(r"\(([^()]*)\)", replace_parenthetical, text)
    return text


def prepare_text_for_tts_engine(text: str) -> str:
    return normalize_text_for_speech(text)


def split_text_for_tts_queue(text: str, first_phrase: bool) -> List[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []

    return split_tts_phrases(text, first_phrase)


def split_tts_phrases(text: str, first_phrase: bool) -> List[str]:
    phrases: List[str] = []
    remaining = text
    use_first_limit = first_phrase

    while remaining:
        limit = TTS_FIRST_PHRASE_MAX_CHARS if use_first_limit else TTS_PHRASE_MAX_CHARS
        target = min(
            limit,
            TTS_FIRST_PHRASE_MAX_CHARS
            if use_first_limit
            else TTS_PHRASE_TARGET_CHARS,
        )
        boundary = choose_tts_phrase_boundary(remaining, limit, target)
        phrase = remaining[:boundary].strip()
        remaining = remaining[boundary:].strip()

        if phrase:
            if (
                phrases
                and len(phrase) < TTS_MIN_PHRASE_CHARS
                and len(phrases[-1]) + len(phrase) + 1 <= TTS_PHRASE_MAX_CHARS
            ):
                phrases[-1] = f"{phrases[-1]} {phrase}"
            else:
                phrases.append(phrase)

        use_first_limit = False

    return phrases


def choose_tts_phrase_boundary(text: str, limit: int, target: int) -> int:
    if len(text) <= limit:
        return len(text)

    search = text[:limit]
    min_chars = min(TTS_MIN_PHRASE_CHARS, max(1, target))
    sentence_min_chars = min(4, TTS_MIN_PHRASE_CHARS)

    sentence_matches = [
        match.start() + 1
        for match in re.finditer(r"[.!?](?=\s|$)", search)
        if match.start() + 1 >= sentence_min_chars
    ]
    for end in sentence_matches:
        if end >= target:
            return end
    if sentence_matches:
        return sentence_matches[-1]

    clause_min_chars = min(limit, max(45, TTS_MIN_PHRASE_CHARS))
    clause_matches = [
        match.start() + 1
        for match in re.finditer(r"[,;:](?=\s|$)", search)
        if match.start() + 1 >= clause_min_chars
    ]
    for end in clause_matches:
        if end >= target:
            return end
    if clause_matches:
        return clause_matches[-1]

    last_space = search.rfind(" ")
    if last_space >= min_chars:
        return last_space

    return limit


def trim_tts_phrase_to_budget(text: str, remaining_chars: int) -> str:
    if remaining_chars <= 0:
        return ""

    if len(text) <= remaining_chars:
        return text

    trimmed = text[:remaining_chars].rstrip()
    last_space = trimmed.rfind(" ")
    if last_space >= TTS_MIN_PHRASE_CHARS:
        trimmed = trimmed[:last_space].rstrip()

    trimmed = trimmed.rstrip(" ,;:")
    if trimmed and not re.search(r"[.!?]$", trimmed):
        if len(trimmed) + 1 <= remaining_chars:
            trimmed = f"{trimmed}."
        elif len(trimmed) > 1:
            trimmed = f"{trimmed[:-1].rstrip()}."

    return trimmed


def format_time_for_speech(hour: int, minute: int, meridiem: Optional[str]) -> str:
    names = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ]
    tens = {20: "twenty", 30: "thirty", 40: "forty", 50: "fifty"}

    def under_sixty(value: int) -> str:
        if value < len(names):
            return names[value]
        base = value // 10 * 10
        rest = value % 10
        return tens[base] if rest == 0 else f"{tens[base]} {names[rest]}"

    if meridiem == "am" and hour == 12 and minute == 0:
        return "midnight"
    if meridiem == "pm" and hour == 12 and minute == 0:
        return "midday"

    hour_24 = hour
    if meridiem:
        hour_24 = hour % 12
        if meridiem == "pm":
            hour_24 += 12

    hour_12 = hour_24 % 12 or 12
    if hour_24 < 5:
        period = "at night"
    elif hour_24 < 12:
        period = "in the morning"
    elif hour_24 < 17:
        period = "in the afternoon"
    else:
        period = "in the evening"

    if minute == 0:
        return f"{under_sixty(hour_12)} {period}" if meridiem else f"{under_sixty(hour_12)} o'clock"

    minute_text = (
        f"oh {under_sixty(minute)}" if minute < 10 else under_sixty(minute)
    )
    return " ".join([under_sixty(hour_12), minute_text, period if meridiem else ""])


def write_wav_temp(samples: np.ndarray, sample_rate: int) -> Path:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2", copy=False)
    temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    temp_path = Path(temp_file.name)
    temp_file.close()

    with wave.open(str(temp_path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())

    return temp_path


def audio_to_float32(audio: Any) -> np.ndarray:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()

    audio_array = np.asarray(audio, dtype=np.float32).squeeze()

    if audio_array.ndim == 0:
        return np.zeros(0, dtype=np.float32)

    if audio_array.ndim > 1:
        audio_array = audio_array.reshape(-1)

    return np.ascontiguousarray(audio_array, dtype=np.float32)


def resample_float32(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate or audio.size == 0:
        return audio

    target_size = max(1, int(round(audio.size * target_rate / source_rate)))
    source_positions = np.linspace(0, audio.size - 1, num=audio.size)
    target_positions = np.linspace(0, audio.size - 1, num=target_size)
    return np.interp(target_positions, source_positions, audio).astype(np.float32)


def trim_generated_silence(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    if not TTS_TRIM_SILENCE or audio.size == 0:
        return audio

    active = np.flatnonzero(np.abs(audio) >= TTS_TRIM_SILENCE_THRESHOLD)
    if active.size == 0:
        return audio

    keep_samples = int(sample_rate * TTS_TRIM_SILENCE_KEEP_MS / 1000)
    start = max(0, int(active[0]) - keep_samples)
    end = min(audio.size, int(active[-1]) + keep_samples)
    return np.ascontiguousarray(audio[start:end], dtype=np.float32)


def transcribe_samples(samples: np.ndarray) -> Tuple[str, int]:
    started_at = time.perf_counter()
    temp_path = write_wav_temp(samples, INPUT_SAMPLE_RATE)

    try:
        segments, _ = get_whisper_model().transcribe(
            str(temp_path),
            language=STT_LANGUAGE,
            beam_size=1,
            best_of=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return text, elapsed_ms(started_at)
    finally:
        temp_path.unlink(missing_ok=True)


def iter_qwen_tts_audio(speech_text: str):
    model = get_qwen_tts_model()
    started_at = time.perf_counter()
    chunks = 0
    samples = 0
    logger.info(
        "voice.tts.qwen.stream.start chars=%d model=%s speaker=%s language=%s chunkSize=%d nonStreamingMode=%s temperature=%.2f topP=%.2f topK=%d",
        len(speech_text),
        QWEN_TTS_MODEL_NAME,
        QWEN_TTS_SPEAKER,
        QWEN_TTS_LANGUAGE,
        QWEN_TTS_STREAM_CHUNK_SIZE,
        QWEN_TTS_NON_STREAMING_MODE,
        QWEN_TTS_TEMPERATURE,
        QWEN_TTS_TOP_P,
        QWEN_TTS_TOP_K,
    )
    with torch.inference_mode():
        stream = call_with_supported_kwargs(
            model.generate_custom_voice_streaming,
            text=speech_text,
            language=QWEN_TTS_LANGUAGE,
            speaker=QWEN_TTS_SPEAKER,
            instruct=QWEN_TTS_INSTRUCT,
            chunk_size=QWEN_TTS_STREAM_CHUNK_SIZE,
            non_streaming_mode=QWEN_TTS_NON_STREAMING_MODE,
            do_sample=QWEN_TTS_DO_SAMPLE,
            top_k=QWEN_TTS_TOP_K,
            top_p=QWEN_TTS_TOP_P,
            temperature=QWEN_TTS_TEMPERATURE,
            repetition_penalty=QWEN_TTS_REPETITION_PENALTY,
            min_new_tokens=QWEN_TTS_MIN_NEW_TOKENS,
            max_new_tokens=QWEN_TTS_MAX_NEW_TOKENS,
        )

        for audio_chunk, sample_rate, timing in stream:
            audio_array = audio_to_float32(audio_chunk)
            audio_array = resample_float32(
                audio_array, int(sample_rate), TTS_SAMPLE_RATE
            )
            if audio_array.size == 0:
                continue
            chunks += 1
            samples += int(audio_array.size)
            if chunks == 1:
                logger.info(
                    "voice.tts.qwen.first_chunk chars=%d samples=%d audioSeconds=%.2f timing=%s latencyMs=%d",
                    len(speech_text),
                    int(audio_array.size),
                    audio_array.size / TTS_SAMPLE_RATE if TTS_SAMPLE_RATE else 0,
                    timing,
                    elapsed_ms(started_at),
                )
            yield audio_array

    logger.info(
        "voice.tts.qwen.stream.end chars=%d chunks=%d samples=%d audioSeconds=%.2f latencyMs=%d",
        len(speech_text),
        chunks,
        samples,
        samples / TTS_SAMPLE_RATE if TTS_SAMPLE_RATE else 0,
        elapsed_ms(started_at),
    )


def iter_tts_audio(text: str):
    speech_text = prepare_text_for_tts_engine(text)
    if not speech_text:
        return

    yield from iter_qwen_tts_audio(speech_text)


class PcmOutputTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self, sample_rate: int = TTS_SAMPLE_RATE, frame_ms: int = 20):
        super().__init__()
        self.sample_rate = sample_rate
        self.frame_samples = int(sample_rate * frame_ms / 1000)
        self.queue: asyncio.Queue[np.ndarray] = asyncio.Queue()
        self.pending = np.zeros(0, dtype=np.int16)
        self.queued_samples = 0
        self.pts = 0
        self.started_at = time.monotonic()

    async def enqueue_float32(self, audio: np.ndarray) -> None:
        if audio.size == 0:
            return
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16, copy=False)
        self.queued_samples += int(pcm.size)
        await self.queue.put(pcm)

    async def clear(self) -> None:
        self.pending = np.zeros(0, dtype=np.int16)
        self.queued_samples = 0
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except asyncio.QueueEmpty:
                break

    def buffered_samples(self) -> int:
        return int(self.pending.size) + max(0, int(self.queued_samples))

    def buffered_seconds(self) -> float:
        if self.sample_rate <= 0:
            return 0.0
        return self.buffered_samples() / self.sample_rate

    def has_buffered_audio(self) -> bool:
        return self.buffered_samples() > 0

    async def recv(self) -> AudioFrame:
        wait_until = self.started_at + self.pts / self.sample_rate
        delay = wait_until - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

        while len(self.pending) < self.frame_samples:
            try:
                chunk = self.queue.get_nowait()
                self.queue.task_done()
                self.queued_samples = max(0, self.queued_samples - int(chunk.size))
            except asyncio.QueueEmpty:
                break
            self.pending = np.concatenate([self.pending, chunk])

        if len(self.pending) >= self.frame_samples:
            output = self.pending[: self.frame_samples]
            self.pending = self.pending[self.frame_samples :]
        else:
            output = np.zeros(self.frame_samples, dtype=np.int16)

        frame = AudioFrame.from_ndarray(
            output.reshape(1, -1),
            format="s16",
            layout="mono",
        )
        frame.sample_rate = self.sample_rate
        frame.pts = self.pts
        frame.time_base = Fraction(1, self.sample_rate)
        self.pts += self.frame_samples
        return frame


@dataclass
class VadTurn:
    chunks: list[np.ndarray] = field(default_factory=list)
    started_at: float = 0.0
    last_voice_at: float = 0.0
    threshold_at_start: float = 0.0
    speech_ms: float = 0.0
    max_level: float = 0.0
    started_during_assistant: bool = False

    @property
    def samples(self) -> np.ndarray:
        return np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.float32)


@dataclass
class TurnLatency:
    local_turn_id: int
    stt_started_at: float
    stt_ended_at: Optional[float] = None
    text_sent_at: Optional[float] = None
    turn_id: Optional[str] = None
    first_token_at: Optional[float] = None
    first_text_at: Optional[float] = None
    first_audio_at: Optional[float] = None


@dataclass
class PendingTranscript:
    parts: list[str]
    metric: TurnLatency
    first_part_at: float
    structured: bool = False


NUMBER_WORDS = {
    "zero",
    "oh",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "double",
    "triple",
}


def transcript_word_count(text: str) -> int:
    return len(re.findall(r"\b[\w']+\b", text))


def structured_digit_like_count(text: str) -> int:
    lower = text.lower()
    digit_count = len(re.findall(r"\d", lower))
    words = re.findall(r"\b[a-z]+\b", lower)
    word_count = 0

    for word in words:
        if word == "double":
            word_count += 2
        elif word == "triple":
            word_count += 3
        elif word in NUMBER_WORDS:
            word_count += 1

    return digit_count + word_count


def looks_like_structured_transcript(text: str) -> bool:
    lower = text.lower()
    if re.search(
        r"\b(phone|mobile|number|rego|registration|plate|licen[cs]e|vin|address|postcode)\b",
        lower,
    ):
        return True

    digit_count = len(re.findall(r"\d", lower))
    if digit_count >= 2:
        return True

    words = re.findall(r"\b[a-z]+\b", lower)
    number_word_count = sum(1 for word in words if word in NUMBER_WORDS)
    return number_word_count >= 2


def structured_transcript_likely_incomplete(text: str) -> bool:
    lower = text.lower().strip()
    digit_like_count = structured_digit_like_count(lower)
    word_count = transcript_word_count(lower)
    has_phone_context = bool(re.search(r"\b(phone|mobile|number)\b", lower))

    if re.search(
        r"\b(phone|mobile|number|rego|registration|plate|vin|postcode|address|is|it's|it is|double|triple|at|on|for)$",
        lower,
    ):
        return True

    if has_phone_context and digit_like_count < 8:
        return True

    if 0 < digit_like_count < 6:
        return True

    return word_count < 4


def transcript_looks_complete(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False

    if looks_like_structured_transcript(stripped):
        return False

    if transcript_word_count(stripped) < TRANSCRIPT_MIN_FINAL_WORDS:
        return False

    return bool(re.search(r"[.!?]$", stripped))


def clean_transcript_fragment(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    return text


def join_transcript_fragments(parts: List[str]) -> str:
    cleaned: List[str] = []
    for index, part in enumerate(parts):
        fragment = clean_transcript_fragment(part)
        if not fragment:
            continue
        if index < len(parts) - 1:
            fragment = fragment.rstrip(" .!?;:")
        cleaned.append(fragment)

    return re.sub(r"\s+", " ", " ".join(cleaned)).strip()


class VoiceActivityDetector:
    def __init__(self, session: "VoiceSession"):
        self.session = session
        self.noise_floor = 0.006
        self.current_turn: Optional[VadTurn] = None
        self.preroll: list[Tuple[float, np.ndarray]] = []
        self.barge_candidate_ms = 0.0

    def threshold(self) -> float:
        return max(MIN_SPEECH_THRESHOLD, self.noise_floor * NOISE_MULTIPLIER)

    async def process(self, samples: np.ndarray) -> None:
        if samples.size == 0:
            return

        now = time.monotonic()
        duration_ms = samples.size / INPUT_SAMPLE_RATE * 1000
        level = float(np.sqrt(np.mean(np.square(samples))))
        threshold = self.threshold()
        self.update_preroll(now, samples)

        if self.current_turn is None:
            if self.should_start(level, threshold, duration_ms):
                await self.start_turn(now, threshold)
            else:
                self.update_noise(level, threshold)
                return

        if self.current_turn is None:
            return

        turn = self.current_turn
        turn.chunks.append(samples)
        turn.max_level = max(turn.max_level, level)

        peak_threshold = turn.max_level * END_THRESHOLD_PEAK_RATIO
        if level >= max(threshold, peak_threshold):
            turn.last_voice_at = now
            turn.speech_ms += duration_ms

        utterance_ms = (now - turn.started_at) * 1000
        silence_ms = (now - turn.last_voice_at) * 1000
        if (
            silence_ms >= SILENCE_MS and utterance_ms >= MIN_UTTERANCE_MS
        ) or utterance_ms >= MAX_UTTERANCE_MS:
            await self.finish_turn()

    def update_preroll(self, now: float, samples: np.ndarray) -> None:
        cutoff = now - PREROLL_MS / 1000
        self.preroll = [
            (captured_at, chunk)
            for captured_at, chunk in self.preroll
            if captured_at >= cutoff
        ]
        self.preroll.append((now, samples))

    def should_start(self, level: float, threshold: float, duration_ms: float) -> bool:
        if not self.session.is_assistant_interruptible():
            self.barge_candidate_ms = 0
            return level >= threshold

        grace_active = self.session.is_in_assistant_barge_grace()
        barge_threshold = max(
            BARGE_MIN_PEAK_LEVEL,
            MIN_SPEECH_THRESHOLD,
            threshold * BARGE_THRESHOLD_MULTIPLIER,
        )
        if grace_active:
            barge_threshold = max(barge_threshold, BARGE_MIN_PEAK_LEVEL * 1.25)

        if level < barge_threshold:
            self.barge_candidate_ms = 0
            return False

        self.barge_candidate_ms += duration_ms
        required_hold_ms = BARGE_HOLD_MS * 1.25 if grace_active else BARGE_HOLD_MS
        return self.barge_candidate_ms >= required_hold_ms

    async def start_turn(self, now: float, threshold: float) -> None:
        started_during_assistant = self.session.is_assistant_interruptible()
        if started_during_assistant:
            await self.session.interrupt_assistant("barge_in_started")
            preroll_chunks: list[np.ndarray] = []
        else:
            preroll_chunks = [chunk for _, chunk in self.preroll[:-1]]

        await self.session.note_user_speech_started()
        self.current_turn = VadTurn(
            chunks=preroll_chunks,
            started_at=now,
            last_voice_at=now,
            threshold_at_start=threshold,
            started_during_assistant=started_during_assistant,
        )
        await self.session.send_browser_event(
            {
                "type": "gateway.speech.started",
                "timestamp": now_iso(),
                "payload": {
                    "startedDuringAssistant": started_during_assistant,
                },
            }
        )

    async def finish_turn(self) -> None:
        turn = self.current_turn
        self.current_turn = None
        self.barge_candidate_ms = 0

        if turn is None:
            return

        min_speech = MIN_BARGE_SPEECH_MS if turn.started_during_assistant else MIN_SPEECH_MS
        required_peak = max(
            BARGE_MIN_PEAK_LEVEL if turn.started_during_assistant else MIN_PEAK_LEVEL,
            turn.threshold_at_start * 1.15,
        )
        samples = turn.samples
        accepted = (
            samples.size >= int(INPUT_SAMPLE_RATE * 0.18)
            and turn.speech_ms >= min_speech
            and turn.max_level >= required_peak
        )

        if not accepted:
            await self.session.send_browser_event(
                {
                    "type": "gateway.speech.discarded",
                    "timestamp": now_iso(),
                    "payload": {
                        "speechMs": round(turn.speech_ms),
                        "maxLevel": round(turn.max_level, 4),
                        "requiredPeak": round(required_peak, 4),
                    },
                }
            )
            await self.session.resume_pending_transcript_commit("discarded_speech")
            return

        await self.session.enqueue_user_audio(samples)

    def update_noise(self, level: float, threshold: float) -> None:
        if level < threshold:
            self.noise_floor = self.noise_floor * 0.94 + level * 0.06


class NestControlClient:
    def __init__(self, session: "VoiceSession", task_key: str):
        self.session = session
        self.task_key = task_key
        self.ws: Any = None
        self.ready = asyncio.Event()
        self.receiver_task: Optional[asyncio.Task[None]] = None

    async def connect(self) -> None:
        logger.info("voice.nest.connect url=%s", NEST_WS_URL)
        self.ws = await websockets.connect(NEST_WS_URL, max_size=8 * 1024 * 1024)
        self.receiver_task = asyncio.create_task(self.receive_loop())
        await self.send(
            {
                "type": "session.start",
                "payload": {
                    "taskKey": self.task_key,
                    "metadata": {"transport": "webrtc_voice_gateway"},
                },
            }
        )
        await asyncio.wait_for(self.ready.wait(), timeout=10)
        logger.info("voice.nest.ready")

    async def send_text(self, text: str) -> None:
        await self.ready.wait()
        await self.send({"type": "text.message", "payload": {"text": text}})

    async def interrupt(self, reason: str) -> None:
        if self.ws is None:
            return
        await self.send({"type": "session.interrupt", "payload": {"reason": reason}})

    async def end_session(self) -> None:
        if self.ws is None:
            return
        await self.send({"type": "session.end", "payload": {}})

    async def send(self, event: Dict[str, Any]) -> None:
        if self.ws is not None:
            await self.ws.send(json.dumps(event))

    async def receive_loop(self) -> None:
        try:
            async for raw in self.ws:
                event = json.loads(raw)
                event_type = event.get("type")

                if event_type == "session.started":
                    self.ready.set()
                elif event_type == "transcript.final":
                    await self.session.attach_turn_latency(event)
                elif event_type == "reasoning.first_token":
                    await self.session.mark_first_token(event)
                elif event_type == "assistant.text.chunk":
                    await self.session.handle_assistant_text_chunk(event)
                elif event_type == "assistant.response":
                    await self.session.handle_assistant_response(event)
                elif event_type == "session.end_requested":
                    await self.session.handle_session_end_requested(event)
                elif event_type == "session.interrupted":
                    await self.session.clear_assistant_audio("nest_interrupted")

                await self.session.send_browser_event(event)
        except Exception as exc:
            logger.warning("voice.nest.closed error=%s", exc)
            await self.session.send_browser_event(
                {
                    "type": "gateway.error",
                    "timestamp": now_iso(),
                    "payload": {"message": f"Nest websocket closed: {exc}"},
                }
            )

    async def close(self) -> None:
        if self.receiver_task:
            self.receiver_task.cancel()
        if self.ws:
            await self.ws.close()


class VoiceSession:
    def __init__(self, signaling_ws: Any):
        self.signaling_ws = signaling_ws
        self.pc: Optional[RTCPeerConnection] = None
        self.data_channel: Any = None
        self.output_track = PcmOutputTrack()
        self.control: Optional[NestControlClient] = None
        self.vad = VoiceActivityDetector(self)
        self.resampler = AudioResampler(format="s16", layout="mono", rate=INPUT_SAMPLE_RATE)
        self.closed = False
        self.call_ending = False
        self.user_turn_generation = 0
        self.stt_queue: asyncio.Queue[Tuple[int, np.ndarray]] = asyncio.Queue(
            maxsize=STT_QUEUE_MAX_SIZE
        )
        self.tts_queue: asyncio.Queue[Tuple[str, str]] = asyncio.Queue()
        self.tts_worker_task = asyncio.create_task(self.tts_worker())
        self.stt_worker_task = asyncio.create_task(self.stt_worker())
        self.current_assistant_turn_id: Optional[str] = None
        self.cancelled_turn_ids: Set[str] = set()
        self.turns_with_spoken_chunks: Set[str] = set()
        self.spoken_chars_by_turn: Dict[str, int] = {}
        self.tts_generation = 0
        self.assistant_speaking = False
        self.last_assistant_audio_at = 0.0
        self.assistant_audio_started_at = 0.0
        self.local_turn_sequence = 0
        self.pending_turn_latencies: list[TurnLatency] = []
        self.turn_latencies: Dict[str, TurnLatency] = {}
        self.greeting_sent = False
        self.pending_end_turn_id: Optional[str] = None
        self.pending_transcript: Optional[PendingTranscript] = None
        self.pending_transcript_task: Optional[asyncio.Task[None]] = None

    async def start_control(self, task_key: str) -> None:
        self.control = NestControlClient(self, task_key)
        await self.control.connect()

    async def accept_offer(self, sdp: str, sdp_type: str) -> None:
        logger.info(
            "voice.webrtc.answer.start browserIceServers=%d serverIceServers=%d",
            len(browser_ice_servers()),
            len(server_ice_servers()),
        )
        self.pc = RTCPeerConnection(
            configuration=RTCConfiguration(iceServers=aiortc_ice_servers())
        )
        self.pc.addTrack(self.output_track)

        @self.pc.on("datachannel")
        def on_datachannel(channel: Any) -> None:
            self.data_channel = channel

            @channel.on("message")
            def on_message(message: Any) -> None:
                asyncio.create_task(self.handle_datachannel_message(message))

        @self.pc.on("track")
        def on_track(track: MediaStreamTrack) -> None:
            if track.kind == "audio":
                asyncio.create_task(self.consume_microphone(track))

        @self.pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            state = self.pc.connectionState if self.pc else "closed"
            await self.send_browser_event(
                {
                    "type": "gateway.peer.state",
                    "timestamp": now_iso(),
                    "payload": {"state": state},
                }
            )
            if state == "connected":
                asyncio.create_task(self.play_greeting())

        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        logger.info("voice.webrtc.remote_description.set")
        answer = await self.pc.createAnswer()
        logger.info("voice.webrtc.answer.created")
        await self.pc.setLocalDescription(answer)
        logger.info("voice.webrtc.local_description.set")
        await wait_for_ice_gathering(self.pc)
        logger.info("voice.webrtc.ice_gathering.done state=%s", self.pc.iceGatheringState)
        await send_json(
            self.signaling_ws,
            {
                "type": "answer",
                "sdp": self.pc.localDescription.sdp,
                "sdpType": self.pc.localDescription.type,
            },
        )
        logger.info("voice.webrtc.answer.sent")

    async def handle_datachannel_message(self, message: Any) -> None:
        try:
            event = json.loads(message) if isinstance(message, str) else {}
        except json.JSONDecodeError:
            return

        event_type = event.get("type")
        if event_type == "interrupt":
            await self.interrupt_assistant("client_interrupt")

    async def consume_microphone(self, track: MediaStreamTrack) -> None:
        logger.info("voice.track.start kind=%s", track.kind)
        while not self.closed:
            try:
                frame = await track.recv()
            except Exception as exc:
                logger.info("voice.track.end reason=%s", exc)
                break

            for resampled in self.resampler.resample(frame):
                pcm = resampled.to_ndarray().reshape(-1).astype(np.int16)
                samples = pcm.astype(np.float32) / 32768.0
                await self.vad.process(samples)

    def is_assistant_interruptible(self) -> bool:
        recent = time.monotonic() - self.last_assistant_audio_at < 1.5
        return (
            self.assistant_speaking
            or not self.tts_queue.empty()
            or self.output_track.has_buffered_audio()
            or recent
        )

    def is_in_assistant_barge_grace(self) -> bool:
        if self.assistant_audio_started_at <= 0:
            return False

        return (
            time.monotonic() - self.assistant_audio_started_at
        ) * 1000 < BARGE_START_GRACE_MS

    async def play_greeting(self) -> None:
        if self.greeting_sent or not GREETING_ENABLED or not TTS_ENABLED:
            return

        self.greeting_sent = True
        text = GREETING_TEXT.strip()
        if not text:
            return

        await self.send_browser_event(
            {
                "type": "gateway.greeting",
                "timestamp": now_iso(),
                "payload": {"text": text},
            }
        )
        await self.queue_tts_text("gateway-greeting", text, mark_spoken_chunk=False)

    async def interrupt_assistant(self, reason: str) -> None:
        await self.clear_assistant_audio(reason)
        if self.control:
            await self.control.interrupt(reason)

    async def clear_assistant_audio(self, reason: str) -> None:
        self.tts_generation += 1
        if self.current_assistant_turn_id:
            self.cancelled_turn_ids.add(self.current_assistant_turn_id)

        self.current_assistant_turn_id = None
        self.pending_end_turn_id = None
        await self.output_track.clear()
        while not self.tts_queue.empty():
            try:
                self.tts_queue.get_nowait()
                self.tts_queue.task_done()
            except asyncio.QueueEmpty:
                break

        self.assistant_speaking = False
        await self.send_browser_event(
            {
                "type": "gateway.audio.cleared",
                "timestamp": now_iso(),
                "payload": {"reason": reason},
            }
        )

    async def handle_session_end_requested(self, event: Dict[str, Any]) -> None:
        payload = event.get("payload") or {}
        turn_id = str(payload.get("turnId") or "")
        if self.call_ending or (turn_id and turn_id in self.cancelled_turn_ids):
            return

        self.pending_end_turn_id = turn_id or self.current_assistant_turn_id

        asyncio.create_task(self.end_call_when_audio_idle("assistant_completed_call"))

    async def end_call_when_audio_idle(self, reason: str) -> None:
        await asyncio.sleep(0.15)
        while not self.closed:
            while not self.closed and self.has_pending_assistant_audio():
                await asyncio.sleep(OUTPUT_DRAIN_POLL_MS / 1000)

            if self.closed:
                return

            if CALL_END_AUDIO_TAIL_MS > 0:
                await asyncio.sleep(CALL_END_AUDIO_TAIL_MS / 1000)

            if not self.has_pending_assistant_audio():
                break

        await self.end_call(reason)

    async def end_call(self, reason: str) -> None:
        if self.call_ending:
            return

        self.call_ending = True
        await self.send_browser_event(
            {
                "type": "gateway.call.ended",
                "timestamp": now_iso(),
                "payload": {"reason": reason},
            }
        )

        if self.control:
            try:
                await self.control.end_session()
            except Exception as exc:
                logger.warning("voice.nest.end_session_failed error=%s", exc)

        await asyncio.sleep(0.35)
        await self.close()

    def has_pending_assistant_audio(self) -> bool:
        return (
            self.assistant_speaking
            or not self.tts_queue.empty()
            or self.output_track.has_buffered_audio()
        )

    async def wait_output_audio_drained(self, stop_if_tts_queue_fills: bool) -> bool:
        started_at = time.perf_counter()
        while not self.closed:
            if stop_if_tts_queue_fills and not self.tts_queue.empty():
                return False

            if not self.output_track.has_buffered_audio():
                return True

            if OUTPUT_DRAIN_MAX_MS > 0 and elapsed_ms(started_at) > OUTPUT_DRAIN_MAX_MS:
                logger.warning(
                    "voice.output.drain_timeout bufferedSeconds=%.2f",
                    self.output_track.buffered_seconds(),
                )
                return True

            await asyncio.sleep(OUTPUT_DRAIN_POLL_MS / 1000)

        return False

    async def note_user_speech_started(self) -> None:
        if self.pending_transcript is None:
            return

        if self.pending_transcript_task:
            self.pending_transcript_task.cancel()
            self.pending_transcript_task = None

        await self.send_browser_event(
            {
                "type": "gateway.transcript.holding",
                "timestamp": now_iso(),
                "payload": {
                    "text": join_transcript_fragments(self.pending_transcript.parts),
                    "parts": len(self.pending_transcript.parts),
                    "reason": "user_continued_speaking",
                },
            }
        )

    async def resume_pending_transcript_commit(self, reason: str) -> None:
        if self.pending_transcript is None or self.pending_transcript_task is not None:
            return

        text = join_transcript_fragments(self.pending_transcript.parts)
        if not text:
            return

        delay_ms = self.transcript_commit_delay_ms(text)
        self.schedule_pending_transcript_commit(delay_ms)
        await self.send_browser_event(
            {
                "type": "gateway.transcript.pending_resumed",
                "timestamp": now_iso(),
                "payload": {
                    "text": text,
                    "parts": len(self.pending_transcript.parts),
                    "reason": reason,
                    "delayMs": delay_ms,
                },
            }
        )

    def begin_turn_latency(self) -> TurnLatency:
        self.local_turn_sequence += 1
        return TurnLatency(
            local_turn_id=self.local_turn_sequence,
            stt_started_at=time.perf_counter(),
        )

    async def enqueue_user_audio(self, samples: np.ndarray) -> None:
        if self.closed or self.call_ending:
            return

        self.user_turn_generation += 1
        generation = self.user_turn_generation
        dropped = 0

        while self.stt_queue.full():
            try:
                self.stt_queue.get_nowait()
                self.stt_queue.task_done()
                dropped += 1
            except asyncio.QueueEmpty:
                break

        if dropped:
            logger.info(
                "voice.stt.drop_queued_overflow dropped=%d generation=%d",
                dropped,
                generation,
            )

        await self.stt_queue.put((generation, samples))
        await self.send_browser_event(
            {
                "type": "gateway.transcription.queued",
                "timestamp": now_iso(),
                "payload": {
                    "generation": generation,
                    "samples": int(samples.size),
                },
            }
        )

    async def stt_worker(self) -> None:
        while not self.closed:
            generation, samples = await self.stt_queue.get()

            try:
                stale_generation = (
                    not TRANSCRIPT_COALESCING_ENABLED
                    and generation != self.user_turn_generation
                )
                if stale_generation or self.call_ending:
                    logger.info(
                        "voice.stt.skip_queued_stale generation=%d currentGeneration=%d",
                        generation,
                        self.user_turn_generation,
                    )
                    continue

                await self.handle_user_audio(samples, generation)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("voice.stt.error error=%s", exc)
                await self.send_browser_event(
                    {
                        "type": "gateway.error",
                        "timestamp": now_iso(),
                        "payload": {"message": f"Local STT failed: {exc}"},
                    }
                )
            finally:
                self.stt_queue.task_done()

    async def attach_turn_latency(self, event: Dict[str, Any]) -> None:
        payload = event.get("payload") or {}
        turn_id = str(payload.get("turnId") or "")
        if not turn_id or not self.pending_turn_latencies:
            return

        metric = self.pending_turn_latencies.pop(0)
        metric.turn_id = turn_id
        self.turn_latencies[turn_id] = metric
        await self.emit_latency_update(metric)

    async def mark_first_token(self, event: Dict[str, Any]) -> None:
        payload = event.get("payload") or {}
        turn_id = str(payload.get("turnId") or "")
        metric = self.turn_latencies.get(turn_id)
        if metric is None or metric.first_token_at is not None:
            return

        metric.first_token_at = time.perf_counter()
        await self.emit_latency_update(metric)

    async def mark_first_text(self, turn_id: str) -> None:
        metric = self.turn_latencies.get(turn_id)
        if metric is None or metric.first_text_at is not None:
            return

        metric.first_text_at = time.perf_counter()
        await self.emit_latency_update(metric)

    async def mark_first_audio(self, turn_id: str) -> None:
        metric = self.turn_latencies.get(turn_id)
        if metric is None or metric.first_audio_at is not None:
            return

        metric.first_audio_at = time.perf_counter()
        await self.emit_latency_update(metric)

    async def emit_latency_update(self, metric: TurnLatency) -> None:
        def delta_ms(start: Optional[float], end: Optional[float]) -> Optional[int]:
            if start is None or end is None:
                return None
            return int((end - start) * 1000)

        await self.send_browser_event(
            {
                "type": "gateway.latency.updated",
                "timestamp": now_iso(),
                "payload": {
                    "localTurnId": metric.local_turn_id,
                    "turnId": metric.turn_id,
                    "sttMs": delta_ms(metric.stt_started_at, metric.stt_ended_at),
                    "firstTokenMs": delta_ms(metric.text_sent_at, metric.first_token_at),
                    "firstTextMs": delta_ms(metric.text_sent_at, metric.first_text_at),
                    "firstAudioMs": delta_ms(metric.text_sent_at, metric.first_audio_at),
                    "textToAudioMs": delta_ms(metric.first_text_at, metric.first_audio_at),
                },
            }
        )

    async def handle_user_audio(self, samples: np.ndarray, generation: int) -> None:
        metric = self.begin_turn_latency()
        started_at = metric.stt_started_at
        await self.send_browser_event(
            {
                "type": "gateway.transcription.started",
                "timestamp": now_iso(),
                "payload": {"generation": generation, "samples": int(samples.size)},
            }
        )
        text, latency_ms = await asyncio.to_thread(transcribe_samples, samples)
        metric.stt_ended_at = time.perf_counter()
        text = text.strip()
        logger.info(
            "voice.stt.end chars=%d latencyMs=%d totalLatencyMs=%d",
            len(text),
            latency_ms,
            elapsed_ms(started_at),
        )

        stale_generation = (
            not TRANSCRIPT_COALESCING_ENABLED and generation != self.user_turn_generation
        )
        if stale_generation or self.call_ending or self.closed:
            logger.info(
                "voice.stt.skip_stale_result generation=%d currentGeneration=%d",
                generation,
                self.user_turn_generation,
            )
            await self.send_browser_event(
                {
                    "type": "gateway.transcription.stale",
                    "timestamp": now_iso(),
                    "payload": {
                        "generation": generation,
                        "currentGeneration": self.user_turn_generation,
                    },
                }
            )
            return

        if not text:
            await self.send_browser_event(
                {
                    "type": "gateway.transcription.empty",
                    "timestamp": now_iso(),
                    "payload": {"latencyMs": latency_ms},
                }
            )
            await self.resume_pending_transcript_commit("empty_transcription")
            return

        if self.control:
            await self.queue_user_transcript(text, metric)

    async def queue_user_transcript(self, text: str, metric: TurnLatency) -> None:
        if not TRANSCRIPT_COALESCING_ENABLED:
            await self.commit_user_transcript(text, metric)
            return

        text = clean_transcript_fragment(text)
        if not text:
            return

        now = time.perf_counter()
        structured = looks_like_structured_transcript(text)

        if self.pending_transcript is None:
            self.pending_transcript = PendingTranscript(
                parts=[text],
                metric=metric,
                first_part_at=now,
                structured=structured,
            )
        else:
            pending = self.pending_transcript
            pending.parts.append(text)
            pending.structured = pending.structured or structured
            pending.metric.stt_ended_at = metric.stt_ended_at

        combined = join_transcript_fragments(self.pending_transcript.parts)
        elapsed_coalesce_ms = int((now - self.pending_transcript.first_part_at) * 1000)
        should_commit_now = (
            transcript_looks_complete(combined)
            or (
                TRANSCRIPT_MAX_COALESCE_MS > 0
                and elapsed_coalesce_ms >= TRANSCRIPT_MAX_COALESCE_MS
            )
        )
        delay_ms = 0 if should_commit_now else self.transcript_commit_delay_ms(combined)
        await self.send_browser_event(
            {
                "type": "gateway.transcript.pending",
                "timestamp": now_iso(),
                "payload": {
                    "text": combined,
                    "parts": len(self.pending_transcript.parts),
                    "structured": self.pending_transcript.structured,
                    "delayMs": delay_ms,
                    "incompleteStructured": (
                        self.pending_transcript.structured
                        and structured_transcript_likely_incomplete(combined)
                    ),
                },
            }
        )
        self.schedule_pending_transcript_commit(delay_ms)

    def schedule_pending_transcript_commit(self, delay_ms: int) -> None:
        if self.pending_transcript_task:
            self.pending_transcript_task.cancel()
        self.pending_transcript_task = asyncio.create_task(
            self.commit_pending_transcript_after(delay_ms)
        )

    def transcript_commit_delay_ms(self, text: str) -> int:
        if looks_like_structured_transcript(text):
            if structured_transcript_likely_incomplete(text):
                return TRANSCRIPT_INCOMPLETE_STRUCTURED_COMMIT_DELAY_MS
            return TRANSCRIPT_STRUCTURED_COMMIT_DELAY_MS
        return TRANSCRIPT_COMMIT_DELAY_MS

    async def commit_pending_transcript_after(self, delay_ms: int) -> None:
        try:
            if delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000)
            await self.flush_pending_transcript("timer")
        except asyncio.CancelledError:
            raise

    async def flush_pending_transcript(self, reason: str) -> None:
        pending = self.pending_transcript
        if pending is None:
            return

        self.pending_transcript = None
        self.pending_transcript_task = None
        text = join_transcript_fragments(pending.parts)
        if not text:
            return

        logger.info(
            "voice.transcript.commit reason=%s parts=%d chars=%d structured=%s",
            reason,
            len(pending.parts),
            len(text),
            pending.structured,
        )
        await self.send_browser_event(
            {
                "type": "gateway.transcript.committed",
                "timestamp": now_iso(),
                "payload": {
                    "text": text,
                    "parts": len(pending.parts),
                    "structured": pending.structured,
                    "reason": reason,
                },
            }
        )
        await self.commit_user_transcript(text, pending.metric)

    async def commit_user_transcript(self, text: str, metric: TurnLatency) -> None:
        if not self.control or self.closed or self.call_ending:
            return

        metric.text_sent_at = time.perf_counter()
        self.pending_turn_latencies.append(metric)
        await self.control.send_text(text)

    async def handle_assistant_text_chunk(self, event: Dict[str, Any]) -> None:
        payload = event.get("payload") or {}
        turn_id = str(payload.get("turnId") or "")
        text = str(payload.get("text") or "").strip()

        if not turn_id or not text:
            return

        await self.mark_first_text(turn_id)

        if self.call_ending or not TTS_ENABLED:
            return

        if turn_id in self.cancelled_turn_ids:
            return

        await self.queue_tts_text(turn_id, text, mark_spoken_chunk=True)

    async def handle_assistant_response(self, event: Dict[str, Any]) -> None:
        payload = event.get("payload") or {}
        turn_id = str(payload.get("turnId") or "")
        text = str(payload.get("text") or "").strip()

        if not turn_id or not text:
            return

        await self.mark_first_text(turn_id)

        if self.call_ending or not TTS_ENABLED:
            return

        if turn_id in self.cancelled_turn_ids or turn_id in self.turns_with_spoken_chunks:
            return

        await self.queue_tts_text(turn_id, text, mark_spoken_chunk=True)

    async def queue_tts_text(
        self,
        turn_id: str,
        text: str,
        mark_spoken_chunk: bool,
    ) -> None:
        text = re.sub(r"\s+", " ", text).strip()
        if not turn_id or not text or self.call_ending or not TTS_ENABLED:
            return

        if turn_id in self.cancelled_turn_ids:
            return

        first_phrase = self.spoken_chars_by_turn.get(turn_id, 0) == 0
        queue_text = normalize_text_for_speech(text)
        phrases = split_text_for_tts_queue(queue_text, first_phrase)
        queued = 0
        queued_chars = 0

        for phrase in phrases:
            if self.call_ending or turn_id in self.cancelled_turn_ids:
                return

            used_chars = self.spoken_chars_by_turn.get(turn_id, 0)
            remaining_chars = (
                TTS_MAX_SPOKEN_CHARS_PER_TURN - used_chars
                if TTS_MAX_SPOKEN_CHARS_PER_TURN > 0
                else len(phrase)
            )
            phrase = trim_tts_phrase_to_budget(phrase, remaining_chars)
            if not phrase:
                logger.info(
                    "voice.tts.drop_budget turn=%s usedChars=%d maxChars=%d",
                    turn_id,
                    used_chars,
                    TTS_MAX_SPOKEN_CHARS_PER_TURN,
                )
                break

            self.current_assistant_turn_id = turn_id
            if mark_spoken_chunk:
                self.turns_with_spoken_chunks.add(turn_id)

            self.spoken_chars_by_turn[turn_id] = used_chars + len(phrase)
            await self.tts_queue.put((turn_id, phrase))
            queued += 1
            queued_chars += len(phrase)

        if queued:
            logger.info(
                "voice.tts.queue turn=%s engine=%s phrases=%d chars=%d totalTurnChars=%d",
                turn_id,
                TTS_PROVIDER,
                queued,
                queued_chars,
                self.spoken_chars_by_turn.get(turn_id, 0),
            )

    async def tts_worker(self) -> None:
        while not self.closed:
            turn_id, text = await self.tts_queue.get()
            generation = self.tts_generation

            if turn_id in self.cancelled_turn_ids:
                self.tts_queue.task_done()
                continue

            self.assistant_speaking = True
            self.last_assistant_audio_at = time.monotonic()
            self.assistant_audio_started_at = self.last_assistant_audio_at
            started_at = time.perf_counter()
            await self.send_browser_event(
                {
                    "type": "gateway.tts.started",
                    "timestamp": now_iso(),
                    "payload": {"turnId": turn_id, "chars": len(text)},
                }
            )

            try:
                await self.synthesize_to_track(turn_id, text, generation)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception(
                    "voice.tts.error turn=%s chars=%d error=%s",
                    turn_id,
                    len(text),
                    exc,
                )
                await self.send_browser_event(
                    {
                        "type": "gateway.error",
                        "timestamp": now_iso(),
                        "payload": {"message": f"Local TTS failed: {exc}"},
                    }
                )
            finally:
                self.tts_queue.task_done()
                if self.tts_queue.empty():
                    drained = await self.wait_output_audio_drained(
                        stop_if_tts_queue_fills=True
                    )
                    if drained and self.tts_queue.empty():
                        self.assistant_speaking = False
                        await self.send_browser_event(
                            {
                                "type": "gateway.tts.ended",
                                "timestamp": now_iso(),
                                "payload": {
                                    "turnId": turn_id,
                                    "latencyMs": elapsed_ms(started_at),
                                },
                            }
                        )
                        if (
                            self.pending_end_turn_id == turn_id
                            and generation == self.tts_generation
                            and turn_id not in self.cancelled_turn_ids
                        ):
                            asyncio.create_task(
                                self.end_call_when_audio_idle(
                                    "assistant_completed_call"
                                )
                            )

    async def synthesize_to_track(self, turn_id: str, text: str, generation: int) -> None:
        loop = asyncio.get_running_loop()
        await asyncio.to_thread(self.synthesize_thread, loop, turn_id, text, generation)

    def synthesize_thread(
        self,
        loop: asyncio.AbstractEventLoop,
        turn_id: str,
        text: str,
        generation: int,
    ) -> None:
        started_at = time.perf_counter()
        chunk_count = 0

        for audio in iter_tts_audio(text):
            if generation != self.tts_generation or turn_id in self.cancelled_turn_ids:
                break

            chunk_count += 1
            future = asyncio.run_coroutine_threadsafe(
                self.output_track.enqueue_float32(audio),
                loop,
            )
            future.result()
            if chunk_count == 1:
                asyncio.run_coroutine_threadsafe(
                    self.mark_first_audio(turn_id),
                    loop,
                ).result()
            self.last_assistant_audio_at = time.monotonic()

        logger.info(
            "voice.tts.end turn=%s chars=%d chunks=%d latencyMs=%d",
            turn_id,
            len(text),
            chunk_count,
            elapsed_ms(started_at),
        )

    async def send_browser_event(self, event: Dict[str, Any]) -> None:
        message = json.dumps({"type": "event", "event": event})

        if self.data_channel and self.data_channel.readyState == "open":
            self.data_channel.send(message)
            return

        try:
            await self.signaling_ws.send(message)
        except Exception:
            pass

    async def close(self) -> None:
        self.closed = True
        pending_transcript_task = self.pending_transcript_task
        if self.pending_transcript_task:
            self.pending_transcript_task.cancel()
            self.pending_transcript_task = None
        self.tts_worker_task.cancel()
        self.stt_worker_task.cancel()
        await asyncio.gather(
            *(task for task in [pending_transcript_task] if task is not None),
            self.tts_worker_task,
            self.stt_worker_task,
            return_exceptions=True,
        )
        if self.control:
            await self.control.close()
        if self.pc:
            await self.pc.close()


async def wait_for_ice_gathering(pc: RTCPeerConnection) -> None:
    if pc.iceGatheringState == "complete":
        return

    done = asyncio.Event()

    @pc.on("icegatheringstatechange")
    def on_icegatheringstatechange() -> None:
        if pc.iceGatheringState == "complete":
            done.set()

    try:
        await asyncio.wait_for(done.wait(), timeout=5)
    except asyncio.TimeoutError:
        logger.warning("voice.ice_gathering.timeout state=%s", pc.iceGatheringState)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


async def send_json(websocket: Any, payload: Dict[str, Any]) -> None:
    await websocket.send(json.dumps(payload))


async def handle_signaling(websocket: Any, _path: Optional[str] = None) -> None:
    session = VoiceSession(websocket)
    remote = getattr(websocket, "remote_address", None)
    logger.info("voice.signaling.connected remote=%s", remote)

    try:
        async for raw in websocket:
            message = json.loads(raw)
            message_type = message.get("type")
            logger.info("voice.signaling.message type=%s", message_type)

            if message_type == "start":
                task_key = message.get("taskKey") or DEFAULT_TASK_KEY
                try:
                    await session.start_control(task_key)
                except Exception as exc:
                    logger.exception("voice.nest.connect_failed url=%s", NEST_WS_URL)
                    await send_json(
                        websocket,
                        {
                            "type": "error",
                            "code": "NEST_WS_CONNECTION_FAILED",
                            "message": (
                                f"Could not connect voice gateway to Nest at {NEST_WS_URL}: {exc}"
                            ),
                        },
                    )
                    continue

                await send_json(
                    websocket,
                    {
                        "type": "ready",
                        "nestWsUrl": NEST_WS_URL,
                        "taskKey": task_key,
                        "iceServers": browser_ice_servers(),
                        "iceTransportPolicy": browser_ice_transport_policy(),
                    },
                )
            elif message_type == "offer":
                try:
                    await session.accept_offer(
                        sdp=message["sdp"],
                        sdp_type=message.get("sdpType", "offer"),
                    )
                except Exception as exc:
                    logger.exception("voice.webrtc.offer_failed")
                    await send_json(
                        websocket,
                        {
                            "type": "error",
                            "code": "WEBRTC_OFFER_FAILED",
                            "message": f"Could not accept WebRTC offer: {exc}",
                        },
                    )
            elif message_type == "interrupt":
                await session.interrupt_assistant("signaling_interrupt")
            elif message_type == "stop":
                logger.info("voice.signaling.stop")
                break
    except Exception as exc:
        logger.exception("voice.signaling.error error=%s", exc)
        try:
            await send_json(
                websocket,
                {
                    "type": "error",
                    "message": str(exc),
                },
            )
        except Exception:
            pass
    finally:
        await session.close()
        logger.info("voice.signaling.closed")


def preload_stt_model() -> None:
    started_at = time.perf_counter()
    get_whisper_model()
    logger.info("voice.stt.preload.end latencyMs=%d", elapsed_ms(started_at))


def preload_tts_model() -> None:
    if not TTS_ENABLED:
        return

    started_at = time.perf_counter()
    text = TTS_WARMUP_TEXT or "Ready."
    chunks = 0
    samples = 0
    for audio in iter_tts_audio(text):
        chunks += 1
        samples += int(audio.size)

    logger.info(
        "voice.tts.preload.end engine=%s chars=%d chunks=%d audioSeconds=%.2f latencyMs=%d",
        TTS_PROVIDER,
        len(text),
        chunks,
        samples / TTS_SAMPLE_RATE if TTS_SAMPLE_RATE else 0,
        elapsed_ms(started_at),
    )


async def preload_models() -> None:
    try:
        if STT_PRELOAD:
            await asyncio.to_thread(preload_stt_model)
        if TTS_PRELOAD:
            await asyncio.to_thread(preload_tts_model)
    except Exception as exc:
        logger.exception("voice.preload.error error=%s", exc)


async def main() -> None:
    ice_servers = browser_ice_servers()
    logger.info(
        "voice.gateway.start host=%s port=%d nestWs=%s stt=%s/%s ttsEngine=%s tts=%s/%s sampleRate=%d iceServers=%d iceTransportPolicy=%s",
        HOST,
        PORT,
        NEST_WS_URL,
        STT_MODEL_NAME,
        STT_DEVICE,
        TTS_PROVIDER,
        QWEN_TTS_MODEL_NAME,
        resolve_tts_device(),
        TTS_SAMPLE_RATE,
        len(ice_servers),
        browser_ice_transport_policy(),
    )
    logger.info(
        "voice.tts.phrasing firstMax=%d target=%d max=%d turnMax=%d",
        TTS_FIRST_PHRASE_MAX_CHARS,
        TTS_PHRASE_TARGET_CHARS,
        TTS_PHRASE_MAX_CHARS,
        TTS_MAX_SPOKEN_CHARS_PER_TURN,
    )

    should_preload = STT_PRELOAD or TTS_PRELOAD
    if should_preload and GATEWAY_BLOCKING_PRELOAD:
        logger.info("voice.preload.blocking.start")
        await preload_models()
        logger.info("voice.preload.blocking.end")

    async with websockets.serve(
        handle_signaling,
        HOST,
        PORT,
        max_size=16 * 1024 * 1024,
    ):
        if should_preload and not GATEWAY_BLOCKING_PRELOAD:
            asyncio.create_task(preload_models())
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
