#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/scott/multiview-server"
CAMERAS_JSON="${APP_DIR}/data/cameras.json"

if [ ! -f "$CAMERAS_JSON" ]; then
  echo "Missing $CAMERAS_JSON"
  exit 1
fi

python3 <<'PY'
import json
import shlex
from pathlib import Path

app_dir = Path("/home/scott/multiview-server")
cameras_file = app_dir / "data" / "cameras.json"

cameras = json.loads(cameras_file.read_text())

service_dir = Path("/tmp/multiview-server-services")
service_dir.mkdir(parents=True, exist_ok=True)

def service_name(cam_id):
    return f"multiview-server-{cam_id}.service"

def ffmpeg_args(camera):
    cam_id = camera["id"]
    rtsp = camera["rtspUrl"]

    base = [
        "/usr/bin/ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        "-rtsp_transport", "tcp",
        "-i", rtsp,
        "-map", "0:v:0",
    ]

    # Proven special cases from the old working app.
    if cam_id in {"mailbox", "sidewalk"} or "h265" in rtsp.lower():
        video = [
            "-vf", "scale=-2:720",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-tune", "zerolatency",
            "-b:v", "3000k",
            "-maxrate", "4000k",
            "-bufsize", "7000k",
            "-g", "60",
            "-keyint_min", "60",
            "-sc_threshold", "0",
        ]
    else:
        video = [
            "-c:v", "copy",
        ]

    audio = [
        "-map", "0:a:0?",
        "-c:a", "aac",
        "-ac", "1",
        "-ar", "48000",
        "-b:a", "64k",
        "-f", "rtsp",
        "-rtsp_transport", "tcp",
        f"rtsp://127.0.0.1:8554/{cam_id}",
    ]

    return " ".join(shlex.quote(x) for x in base + video + audio)

for camera in cameras:
    cam_id = camera.get("id")
    name = camera.get("name", cam_id)
    if not cam_id or not camera.get("rtspUrl"):
        continue

    text = f"""[Unit]
Description=ScottiBYTE MultiView Server {name} Publisher
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
ExecStart={ffmpeg_args(camera)}

[Install]
WantedBy=multi-user.target
"""
    (service_dir / service_name(cam_id)).write_text(text)

print(service_dir)
PY

sudo cp /tmp/multiview-server-services/*.service /etc/systemd/system/
sudo systemctl daemon-reload

echo
echo "Created services:"
ls -1 /tmp/multiview-server-services/*.service
