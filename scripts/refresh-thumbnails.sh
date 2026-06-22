#!/usr/bin/env bash
set -u

# ScottiBYTE MultiView thumbnail refresher
#
# Reads camera IDs from the server camera configuration and captures one
# thumbnail frame from each published HLS stream.
#
# Configuration:
#   MEDIAMTX_HLS_BASE=http://SERVER-IP:8888
#   MULTIVIEW_THUMB_DIR=/optional/custom/thumb/path
#
# If .env exists in the project root, it will be loaded.

APP_DIR="${MULTIVIEW_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$APP_DIR/.env"
  set +a
fi

THUMB_DIR="${MULTIVIEW_THUMB_DIR:-$APP_DIR/data/thumbs}"
HLS_BASE="${MEDIAMTX_HLS_BASE:-${HLS_BASE:-http://127.0.0.1:8888}}"

mkdir -p "$THUMB_DIR"
cd "$APP_DIR" || exit 1

CAMERA_ID_FILE="$(mktemp)"
trap 'rm -f "$CAMERA_ID_FILE"' EXIT

python3 - <<'PY' > "$CAMERA_ID_FILE"
import json
from pathlib import Path

candidates = [
    Path("data/cameras.json"),
    Path("cameras.json"),
    Path("data/config.json"),
    Path("config.json"),
]

cameras = []

for file in candidates:
    if not file.exists():
        continue

    with file.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, list):
        cameras = raw
    elif isinstance(raw, dict) and isinstance(raw.get("cameras"), list):
        cameras = raw["cameras"]

    if cameras:
        break

for cam in cameras:
    if not isinstance(cam, dict):
        continue
    if cam.get("enabled") is False:
        continue
    cam_id = cam.get("id")
    if cam_id:
        print(cam_id)
PY

if [ ! -s "$CAMERA_ID_FILE" ]; then
  echo "No camera IDs found. Check camera config file location."
  exit 1
fi

while read -r id; do
  [ -z "$id" ] && continue

  out="$THUMB_DIR/${id}.jpg"
  tmp="$THUMB_DIR/${id}.tmp.jpg"
  url="$HLS_BASE/${id}/index.m3u8"

  timeout 25 ffmpeg \
    -hide_banner -loglevel error \
    -y \
    -i "$url" \
    -frames:v 1 \
    -update 1 \
    -q:v 4 \
    -vf "scale=640:-2" \
    "$tmp" >/dev/null 2>&1

  if [ -s "$tmp" ]; then
    mv "$tmp" "$out"
    echo "updated $id"
  else
    rm -f "$tmp"
    echo "skipped $id"
  fi
done < "$CAMERA_ID_FILE"
