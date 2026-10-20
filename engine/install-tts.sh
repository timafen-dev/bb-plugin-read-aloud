#!/usr/bin/env bash
# Install and start the local speech engine for the BB Read Aloud plugin.
#
# Safe to re-run: it rebuilds the image, replaces the container, keeps the
# downloaded voices, and finishes by proving /health answers.
set -euo pipefail

CONTAINER=bb-tts
IMAGE=bb-tts-engine
PORT="${BB_TTS_PORT:-5077}"
VOICES_VOLUME=bb-tts-voices
CACHE_VOLUME=bb-tts-cache
# ru_RU-dmitri is the owner-chosen default; the rest are there so switching
# voices in settings needs no second download.
DEFAULT_VOICES="${BB_TTS_VOICES:-ru_RU-dmitri-medium ru_RU-irina-medium ru_RU-denis-medium en_US-lessac-medium}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v docker >/dev/null || { echo "Docker is required but not on PATH." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running." >&2; exit 1; }

# Warn only when it is actually true: a Docker whose data lives on the Windows
# system drive fills a disk that is usually the tightest one on the machine.
ROOT_DIR="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
case "$ROOT_DIR" in
  /mnt/c/*|/c/*|[Cc]:*)
    echo "WARNING: Docker stores its data on the Windows C: drive ($ROOT_DIR)."
    echo "         The engine image needs roughly 700 MB there."
    ;;
esac

echo "==> Building $IMAGE"
docker build -q -t "$IMAGE" "$HERE" >/dev/null

echo "==> Replacing container $CONTAINER"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker volume create "$VOICES_VOLUME" >/dev/null
docker volume create "$CACHE_VOLUME" >/dev/null

# Loopback only. The engine takes JSON and returns audio; it never opens a
# caller-supplied path, and the container sees nothing but its own volumes.
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "127.0.0.1:${PORT}:5077" \
  -v "$VOICES_VOLUME:/voices" \
  -v "$CACHE_VOLUME:/cache" \
  "$IMAGE" >/dev/null

echo "==> Downloading voices: $DEFAULT_VOICES"
# shellcheck disable=SC2086
docker exec "$CONTAINER" python3 -m piper.download_voices --download-dir /voices $DEFAULT_VOICES >/dev/null

echo "==> Waiting for /health"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:${PORT}/health"
    echo
    echo "Speech engine ready on 127.0.0.1:${PORT}"
    exit 0
  fi
  sleep 1
done

echo "The engine did not answer /health in 60 seconds. Logs:" >&2
docker logs --tail 40 "$CONTAINER" >&2
exit 1
