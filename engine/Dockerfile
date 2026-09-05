# Local speech engine for the BB Read Aloud plugin.
#
# Piper (MIT) on onnxruntime — no torch, so the image stays in the hundreds of
# megabytes rather than the gigabytes a torch-based engine would need.
FROM python:3.12-slim

# opusenc and lame encode Piper's wav into the ogg/opus the browser streams and
# the mp3 Safari on iOS needs. ffmpeg would do both, but it drags in the whole
# X11 stack for codecs we never touch — these two are a few megabytes.
RUN apt-get update \
    && apt-get install --no-install-recommends -y opus-tools lame curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "piper-tts==1.3.0" \
    "fastapi==0.115.6" \
    "uvicorn[standard]==0.34.0"

WORKDIR /app
COPY server.py /app/server.py

ENV VOICES_DIR=/voices CACHE_DIR=/cache
VOLUME ["/voices", "/cache"]
EXPOSE 5077

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS http://127.0.0.1:5077/health || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5077"]
