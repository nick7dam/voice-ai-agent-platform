import asyncio
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
from typing import Any, Dict, Optional, Set, Tuple

import numpy as np
import torch
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import AudioFrame
from av.audio.resampler import AudioResampler
from faster_whisper import WhisperModel
from kokoro import KPipeline


HOST = os.getenv("VOICE_GATEWAY_HOST", "0.0.0.0")
PORT = int(os.getenv("VOICE_GATEWAY_PORT", "8004"))
NEST_WS_URL = os.getenv("NEST_WS_URL", "ws://127.0.0.1:3000/realtime")
DEFAULT_TASK_KEY = os.getenv("DEFAULT_TASK_KEY", "general_voice_assistant")

STT_MODEL_NAME = os.getenv("LOCAL_STT_MODEL", "Systran/faster-distil-whisper-large-v3")
STT_DEVICE = os.getenv("LOCAL_STT_DEVICE", "cpu")
DEFAULT_STT_COMPUTE_TYPE = "float16" if STT_DEVICE == "cuda" else "int8"
STT_COMPUTE_TYPE = os.getenv("LOCAL_STT_COMPUTE_TYPE", DEFAULT_STT_COMPUTE_TYPE)
STT_LANGUAGE = os.getenv("LOCAL_STT_LANGUAGE", "en").strip() or None

TTS_MODEL_NAME = os.getenv("LOCAL_TTS_MODEL", "hexgrad/Kokoro-82M")
TTS_VOICE = os.getenv("LOCAL_TTS_VOICE", "af_heart")
TTS_LANG_CODE = os.getenv("LOCAL_TTS_LANG_CODE", "a")
TTS_SPEED = float(os.getenv("LOCAL_TTS_SPEED", "1"))
TTS_DEVICE = os.getenv("LOCAL_TTS_DEVICE", "auto").lower()
TTS_SAMPLE_RATE = int(os.getenv("LOCAL_TTS_SAMPLE_RATE", "24000"))
TTS_ENABLED = os.getenv("VOICE_GATEWAY_TTS_ENABLED", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}

INPUT_SAMPLE_RATE = 16000
MIN_SPEECH_THRESHOLD = float(os.getenv("VOICE_VAD_MIN_SPEECH_THRESHOLD", "0.025"))
NOISE_MULTIPLIER = float(os.getenv("VOICE_VAD_NOISE_MULTIPLIER", "3.0"))
SILENCE_MS = int(os.getenv("VOICE_VAD_SILENCE_MS", "420"))
MAX_UTTERANCE_MS = int(os.getenv("VOICE_VAD_MAX_UTTERANCE_MS", "8000"))
MIN_UTTERANCE_MS = int(os.getenv("VOICE_VAD_MIN_UTTERANCE_MS", "320"))
MIN_SPEECH_MS = int(os.getenv("VOICE_VAD_MIN_SPEECH_MS", "240"))
MIN_BARGE_SPEECH_MS = int(os.getenv("VOICE_VAD_BARGE_MIN_SPEECH_MS", "260"))
END_THRESHOLD_PEAK_RATIO = float(os.getenv("VOICE_VAD_END_PEAK_RATIO", "0.35"))
MIN_PEAK_LEVEL = float(os.getenv("VOICE_VAD_MIN_PEAK_LEVEL", "0.035"))
BARGE_MIN_PEAK_LEVEL = float(os.getenv("VOICE_VAD_BARGE_MIN_PEAK_LEVEL", "0.05"))
BARGE_THRESHOLD_MULTIPLIER = float(
    os.getenv("VOICE_VAD_BARGE_THRESHOLD_MULTIPLIER", "2.0")
)
BARGE_HOLD_MS = int(os.getenv("VOICE_VAD_BARGE_HOLD_MS", "120"))
PREROLL_MS = int(os.getenv("VOICE_VAD_PREROLL_MS", "450"))

logging.basicConfig(level=os.getenv("VOICE_GATEWAY_LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("webrtc_voice_gateway")

whisper_model: Optional[WhisperModel] = None
tts_pipelines: Dict[str, KPipeline] = {}


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


def get_tts_pipeline(lang_code: str) -> KPipeline:
    pipeline = tts_pipelines.get(lang_code)
    if pipeline is None:
        started_at = time.perf_counter()
        pipeline = KPipeline(lang_code=lang_code, device=resolve_tts_device())
        tts_pipelines[lang_code] = pipeline
        logger.info(
            "voice.tts.loaded model=%s lang=%s device=%s latencyMs=%d",
            TTS_MODEL_NAME,
            lang_code,
            resolve_tts_device(),
            elapsed_ms(started_at),
        )
    return pipeline


def normalize_text_for_speech(text: str) -> str:
    def replace_time(match: re.Match[str]) -> str:
        hour = int(match.group(1))
        minute = int(match.group(2) or "0")
        meridiem = (match.group(3) or "").lower().replace(".", "")
        return format_time_for_speech(hour, minute, meridiem or None)

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
    return (
        text.replace("&", "and")
        .replace(" VIC", " Victoria")
        .replace(" NSW", " New South Wales")
        .replace(" QLD", " Queensland")
    )


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


def iter_tts_audio(text: str):
    pipeline = get_tts_pipeline(TTS_LANG_CODE)
    with torch.inference_mode():
        generator = pipeline(
            normalize_text_for_speech(text),
            voice=TTS_VOICE,
            speed=TTS_SPEED,
        )
        for _, _, audio in generator:
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            yield np.asarray(audio, dtype=np.float32)


class PcmOutputTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self, sample_rate: int = TTS_SAMPLE_RATE, frame_ms: int = 20):
        super().__init__()
        self.sample_rate = sample_rate
        self.frame_samples = int(sample_rate * frame_ms / 1000)
        self.queue: asyncio.Queue[np.ndarray] = asyncio.Queue()
        self.pending = np.zeros(0, dtype=np.int16)
        self.pts = 0
        self.started_at = time.monotonic()

    async def enqueue_float32(self, audio: np.ndarray) -> None:
        if audio.size == 0:
            return
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16, copy=False)
        await self.queue.put(pcm)

    async def clear(self) -> None:
        self.pending = np.zeros(0, dtype=np.int16)
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except asyncio.QueueEmpty:
                break

    async def recv(self) -> AudioFrame:
        wait_until = self.started_at + self.pts / self.sample_rate
        delay = wait_until - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

        while len(self.pending) < self.frame_samples:
            try:
                chunk = self.queue.get_nowait()
                self.queue.task_done()
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

        barge_threshold = max(
            BARGE_MIN_PEAK_LEVEL,
            MIN_SPEECH_THRESHOLD,
            threshold * BARGE_THRESHOLD_MULTIPLIER,
        )
        if level < barge_threshold:
            self.barge_candidate_ms = 0
            return False

        self.barge_candidate_ms += duration_ms
        return self.barge_candidate_ms >= BARGE_HOLD_MS

    async def start_turn(self, now: float, threshold: float) -> None:
        started_during_assistant = self.session.is_assistant_interruptible()
        if started_during_assistant:
            await self.session.interrupt_assistant("barge_in_started")
            preroll_chunks: list[np.ndarray] = []
        else:
            preroll_chunks = [chunk for _, chunk in self.preroll[:-1]]

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
            return

        asyncio.create_task(self.session.handle_user_audio(samples))

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
        await self.send({"type": "session.audio_output", "payload": {"enabled": False}})

    async def send_text(self, text: str) -> None:
        await self.ready.wait()
        await self.send({"type": "text.message", "payload": {"text": text}})

    async def interrupt(self, reason: str) -> None:
        if self.ws is None:
            return
        await self.send({"type": "session.interrupt", "payload": {"reason": reason}})

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
                elif event_type == "assistant.text.chunk":
                    await self.session.handle_assistant_text_chunk(event)
                elif event_type == "assistant.response":
                    await self.session.handle_assistant_response(event)
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
        self.tts_queue: asyncio.Queue[Tuple[str, str]] = asyncio.Queue()
        self.tts_worker_task = asyncio.create_task(self.tts_worker())
        self.closed = False
        self.current_assistant_turn_id: Optional[str] = None
        self.cancelled_turn_ids: Set[str] = set()
        self.turns_with_spoken_chunks: Set[str] = set()
        self.tts_generation = 0
        self.assistant_speaking = False
        self.last_assistant_audio_at = 0.0

    async def start_control(self, task_key: str) -> None:
        self.control = NestControlClient(self, task_key)
        await self.control.connect()

    async def accept_offer(self, sdp: str, sdp_type: str) -> None:
        self.pc = RTCPeerConnection()
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
            await self.send_browser_event(
                {
                    "type": "gateway.peer.state",
                    "timestamp": now_iso(),
                    "payload": {"state": self.pc.connectionState if self.pc else "closed"},
                }
            )

        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)
        await wait_for_ice_gathering(self.pc)
        await send_json(
            self.signaling_ws,
            {
                "type": "answer",
                "sdp": self.pc.localDescription.sdp,
                "sdpType": self.pc.localDescription.type,
            },
        )

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
        return self.assistant_speaking or not self.tts_queue.empty() or recent

    async def interrupt_assistant(self, reason: str) -> None:
        await self.clear_assistant_audio(reason)
        if self.control:
            await self.control.interrupt(reason)

    async def clear_assistant_audio(self, reason: str) -> None:
        self.tts_generation += 1
        if self.current_assistant_turn_id:
            self.cancelled_turn_ids.add(self.current_assistant_turn_id)

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

    async def handle_user_audio(self, samples: np.ndarray) -> None:
        started_at = time.perf_counter()
        await self.send_browser_event(
            {
                "type": "gateway.transcription.started",
                "timestamp": now_iso(),
                "payload": {"samples": int(samples.size)},
            }
        )
        text, latency_ms = await asyncio.to_thread(transcribe_samples, samples)
        text = text.strip()
        logger.info(
            "voice.stt.end chars=%d latencyMs=%d totalLatencyMs=%d",
            len(text),
            latency_ms,
            elapsed_ms(started_at),
        )

        if not text:
            await self.send_browser_event(
                {
                    "type": "gateway.transcription.empty",
                    "timestamp": now_iso(),
                    "payload": {"latencyMs": latency_ms},
                }
            )
            return

        if self.control:
            await self.control.send_text(text)

    async def handle_assistant_text_chunk(self, event: Dict[str, Any]) -> None:
        payload = event.get("payload") or {}
        turn_id = str(payload.get("turnId") or "")
        text = str(payload.get("text") or "").strip()

        if not TTS_ENABLED or not turn_id or not text:
            return

        if turn_id in self.cancelled_turn_ids:
            return

        self.current_assistant_turn_id = turn_id
        self.turns_with_spoken_chunks.add(turn_id)
        await self.tts_queue.put((turn_id, text))

    async def handle_assistant_response(self, event: Dict[str, Any]) -> None:
        payload = event.get("payload") or {}
        turn_id = str(payload.get("turnId") or "")
        text = str(payload.get("text") or "").strip()

        if not TTS_ENABLED or not turn_id or not text:
            return

        if turn_id in self.cancelled_turn_ids or turn_id in self.turns_with_spoken_chunks:
            return

        self.current_assistant_turn_id = turn_id
        await self.tts_queue.put((turn_id, text))

    async def tts_worker(self) -> None:
        while not self.closed:
            turn_id, text = await self.tts_queue.get()
            generation = self.tts_generation

            if turn_id in self.cancelled_turn_ids:
                self.tts_queue.task_done()
                continue

            self.assistant_speaking = True
            self.last_assistant_audio_at = time.monotonic()
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
            finally:
                self.tts_queue.task_done()
                if self.tts_queue.empty():
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
        self.tts_worker_task.cancel()
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
    logger.info("voice.signaling.connected")

    try:
        async for raw in websocket:
            message = json.loads(raw)
            message_type = message.get("type")

            if message_type == "start":
                task_key = message.get("taskKey") or DEFAULT_TASK_KEY
                await session.start_control(task_key)
                await send_json(
                    websocket,
                    {
                        "type": "ready",
                        "nestWsUrl": NEST_WS_URL,
                        "taskKey": task_key,
                    },
                )
            elif message_type == "offer":
                await session.accept_offer(
                    sdp=message["sdp"],
                    sdp_type=message.get("sdpType", "offer"),
                )
            elif message_type == "interrupt":
                await session.interrupt_assistant("signaling_interrupt")
            elif message_type == "stop":
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


async def main() -> None:
    logger.info(
        "voice.gateway.start host=%s port=%d nestWs=%s stt=%s/%s tts=%s/%s",
        HOST,
        PORT,
        NEST_WS_URL,
        STT_MODEL_NAME,
        STT_DEVICE,
        TTS_MODEL_NAME,
        resolve_tts_device(),
    )

    async with websockets.serve(
        handle_signaling,
        HOST,
        PORT,
        max_size=16 * 1024 * 1024,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
