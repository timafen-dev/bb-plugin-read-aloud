"""Local speech engine for the BB Read Aloud plugin.

One HTTP contract — /health, /voices, /speak — so the plugin never learns which
engine is behind it. Piper (MIT) is the default; Silero can be added later
behind the same three routes without touching the plugin.

Binds to loopback only and speaks JSON: no path is ever taken from a request,
so there is nothing here that reads a caller-chosen file.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import subprocess
import threading
import time
import wave
from pathlib import Path

from piper import PiperVoice, SynthesisConfig

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

VOICES_DIR = Path(os.environ.get("VOICES_DIR", "/voices"))
CACHE_DIR = Path(os.environ.get("CACHE_DIR", "/cache"))
CACHE_MAX_BYTES = int(os.environ.get("CACHE_MAX_BYTES", 500 * 1024 * 1024))
MAX_CHARS = int(os.environ.get("MAX_CHARS", 40_000))
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", 2))
ENGINE = "piper"

FORMATS = {
    "opus": ("audio/ogg", "ogg"),
    "mp3": ("audio/mpeg", "mp3"),
    "wav": ("audio/wav", "wav"),
}

app = FastAPI(title="bb read-aloud engine")
_slots = asyncio.Semaphore(MAX_CONCURRENT)


def installed_voices() -> dict[str, Path]:
    """Voice id -> model file, derived from what is actually on disk."""
    return {path.stem: path for path in sorted(VOICES_DIR.glob("*.onnx"))}


def model_version(model: Path) -> str:
    """Cheap, stable fingerprint of a model file, for the cache key.

    Without it, updating a voice would keep serving the old audio forever.
    """
    stat = model.stat()
    return f"{stat.st_size}-{int(stat.st_mtime)}"


def cache_key(text: str, voice: str, rate: float, fmt: str, model: Path) -> str:
    payload = "\x1f".join(
        [ENGINE, model_version(model), voice, f"{rate:.3f}", fmt, text]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def prune_cache() -> None:
    """Keep the cache under its ceiling, dropping the least recently used."""
    files = sorted(
        (p for p in CACHE_DIR.glob("*.*") if p.is_file()),
        key=lambda p: p.stat().st_atime,
    )
    total = sum(p.stat().st_size for p in files)
    while total > CACHE_MAX_BYTES and files:
        victim = files.pop(0)
        total -= victim.stat().st_size
        victim.unlink(missing_ok=True)


# Loading a voice takes seconds; synthesizing takes a fraction of one. Keeping
# them loaded is the whole reason this is a service and not a command.
_voice_cache: dict[Path, PiperVoice] = {}
_voice_lock = threading.Lock()


def load_voice(model: Path) -> PiperVoice:
    with _voice_lock:
        voice = _voice_cache.get(model)
        if voice is None:
            voice = PiperVoice.load(str(model))
            _voice_cache[model] = voice
        return voice


def synthesize_wav(text: str, model: Path, rate: float, target: Path) -> None:
    voice = load_voice(model)
    # length_scale is inverse to speed: half the scale reads twice as fast.
    config = SynthesisConfig(length_scale=1.0 / rate)
    try:
        with wave.open(str(target), "wb") as handle:
            voice.synthesize_wav(text, handle, syn_config=config)
    except Exception as error:  # noqa: BLE001 - reported to the caller as 500
        target.unlink(missing_ok=True)
        raise HTTPException(500, f"synthesis failed: {error}") from error
    if not target.exists():
        raise HTTPException(500, "synthesis produced no audio")


def encode(source: Path, fmt: str, target: Path) -> None:
    if fmt == "wav":
        shutil.copyfile(source, target)
        return
    command = (
        ["opusenc", "--quiet", "--bitrate", "24", str(source), str(target)]
        if fmt == "opus"
        else ["lame", "--quiet", "-b", "48", "-m", "m", str(source), str(target)]
    )
    result = subprocess.run(command, capture_output=True, timeout=300)
    if result.returncode != 0 or not target.exists():
        detail = result.stderr.decode("utf-8", "replace")[-300:]
        raise HTTPException(500, f"encoding failed: {detail}")


def wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / float(handle.getframerate())


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str = Field(min_length=1)
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    format: str = Field(default="opus")


@app.on_event("startup")
def warm_default_voice() -> None:
    """Load one voice at boot so the first click is as fast as the second."""
    preferred = os.environ.get("DEFAULT_VOICE", "ru_RU-dmitri-medium")
    model = installed_voices().get(preferred) or next(
        iter(installed_voices().values()), None
    )
    if model is not None:
        load_voice(model)


@app.get("/health")
def health() -> dict[str, object]:
    voices = installed_voices()
    return {
        "status": "ok" if voices else "no_voices",
        "engine": ENGINE,
        "voices": sorted(voices),
        "formats": sorted(FORMATS),
        "cacheBytes": sum(p.stat().st_size for p in CACHE_DIR.glob("*.*") if p.is_file()),
    }


@app.get("/voices")
def voices() -> dict[str, object]:
    return {
        "engine": ENGINE,
        "voices": [
            {"id": name, "engine": ENGINE, "license": "MIT"}
            for name in sorted(installed_voices())
        ],
    }


@app.post("/speak")
async def speak(request: SpeakRequest) -> Response:
    if len(request.text) > MAX_CHARS:
        raise HTTPException(413, f"text longer than {MAX_CHARS} characters")
    if request.format not in FORMATS:
        raise HTTPException(400, f"unknown format: {request.format}")
    available = installed_voices()
    model = available.get(request.voice)
    if model is None:
        raise HTTPException(404, f"unknown voice: {request.voice}")

    mime, suffix = FORMATS[request.format]
    key = cache_key(request.text, request.voice, request.rate, request.format, model)
    cached = CACHE_DIR / f"{key}.{suffix}"
    if cached.exists():
        os.utime(cached, None)
        return Response(
            content=cached.read_bytes(),
            media_type=mime,
            headers={"X-Cache": "hit", "X-Engine": ENGINE},
        )

    started = time.monotonic()
    async with _slots:
        raw = CACHE_DIR / f"{key}.raw.wav"
        try:
            await asyncio.to_thread(synthesize_wav, request.text, model, request.rate, raw)
            duration = wav_seconds(raw)
            await asyncio.to_thread(encode, raw, request.format, cached)
        finally:
            raw.unlink(missing_ok=True)
    await asyncio.to_thread(prune_cache)

    return Response(
        content=cached.read_bytes(),
        media_type=mime,
        headers={
            "X-Cache": "miss",
            "X-Engine": ENGINE,
            "X-Synthesis-Seconds": f"{time.monotonic() - started:.2f}",
            "X-Audio-Seconds": f"{duration:.2f}",
        },
    )
