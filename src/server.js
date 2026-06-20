const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

const app = express();

const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.MULTIVIEW_PUBLIC_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.MULTIVIEW_DATA_DIR || '/app/data';
const CAMERAS_FILE = path.join(DATA_DIR, 'cameras.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const HLS_DIR = path.join(DATA_DIR, 'hls');
const MEDIAMTX_HLS_BASE = process.env.MEDIAMTX_HLS_BASE || 'http://172.16.2.85:8888';
const MEDIAMTX_API_BASE = process.env.MEDIAMTX_API_BASE || 'http://127.0.0.1:9997';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/thumbs', express.static(THUMBS_DIR));
app.use('/hls', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}, express.static(HLS_DIR));

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(CAMERAS_FILE)) {
    fs.writeFileSync(CAMERAS_FILE, JSON.stringify([], null, 2));
  }

  if (!fs.existsSync(GROUPS_FILE)) {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify([], null, 2));
  }

  if (!fs.existsSync(THUMBS_DIR)) {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
  }

  if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
  }
}

function loadCameras() {
  ensureDataFiles();

  try {
    const raw = fs.readFileSync(CAMERAS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load cameras.json:', err);
    return [];
  }
}

function saveCameras(cameras) {
  ensureDataFiles();
  fs.writeFileSync(CAMERAS_FILE, JSON.stringify(cameras, null, 2));
}

function loadGroups() {
  ensureDataFiles();

  try {
    const raw = fs.readFileSync(GROUPS_FILE, 'utf8');
    const groups = JSON.parse(raw);
    return Array.isArray(groups) ? groups.filter(Boolean).map(String) : [];
  } catch (err) {
    console.error('Failed to load groups.json:', err);
    return [];
  }
}

function saveGroups(groups) {
  ensureDataFiles();

  const cleaned = [...new Set(groups
    .map(group => String(group || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  fs.writeFileSync(GROUPS_FILE, JSON.stringify(cleaned, null, 2));
}

function getGroupNames(cameras = loadCameras()) {
  const configuredGroups = loadGroups();
  const cameraGroups = cameras.map(camera => camera.group || 'Default');

  return [...new Set([...configuredGroups, ...cameraGroups])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function ensureGroupExists(groupName) {
  const group = String(groupName || 'Default').trim() || 'Default';
  const groups = getGroupNames();

  if (!groups.includes(group)) {
    groups.push(group);
    saveGroups(groups);
  }

  return group;
}

function safeId(name) {
  return String(name || 'camera')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `camera-${Date.now()}`;
}



const liveProcesses = new Map();

function stopOtherLiveStreams(activeCameraId) {
  for (const [cameraId, entry] of liveProcesses.entries()) {
    if (cameraId === activeCameraId) continue;

    try {
      entry.process.kill('SIGTERM');
    } catch (err) {}

    liveProcesses.delete(cameraId);
  }
}

function cleanOtherHlsDirs(activeCameraId) {
  ensureDataFiles();

  if (!fs.existsSync(HLS_DIR)) return;

  for (const name of fs.readdirSync(HLS_DIR)) {
    if (name === activeCameraId) continue;

    const fullPath = path.join(HLS_DIR, name);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch (err) {}
  }
}

function getLiveStatus(cameraId) {
  const entry = liveProcesses.get(cameraId);
  if (!entry) return { running: false };

  if (entry.process.exitCode !== null) {
    liveProcesses.delete(cameraId);
    return { running: false };
  }

  return {
    running: true,
    startedAt: entry.startedAt,
    hlsUrl: `/hls/${cameraId}/index.m3u8`
  };
}

function startLiveStream(camera) {
  ensureDataFiles();

  stopOtherLiveStreams(camera.id);
  cleanOtherHlsDirs(camera.id);

  const existing = getLiveStatus(camera.id);
  if (existing.running) {
    return existing;
  }

  const cameraHlsDir = path.join(HLS_DIR, camera.id);
  fs.rmSync(cameraHlsDir, { recursive: true, force: true });
  fs.mkdirSync(cameraHlsDir, { recursive: true });

  const indexPath = path.join(cameraHlsDir, 'index.m3u8');
  const sessionId = Date.now().toString(36);

  const liveProfile = camera.liveProfile || 'copy';

  const videoArgs = liveProfile === 'transcode720'
    ? [
        '-map', '0:v:0',
        '-vf', 'scale=-2:720',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '3000k',
        '-maxrate', '4000k',
        '-bufsize', '7000k',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0'
      ]
    : liveProfile === 'transcode1080'
      ? [
          '-map', '0:v:0',
          '-vf', 'scale=-2:1080',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-tune', 'zerolatency',
          '-b:v', '5000k',
          '-maxrate', '7000k',
          '-bufsize', '10000k',
          '-g', '60',
          '-keyint_min', '60',
          '-sc_threshold', '0'
        ]
      : [
          '-map', '0:v:0',
          '-c:v', 'copy'
        ];

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-timeout', '8000000',
    '-i', camera.rtspUrl,
    ...videoArgs,
    '-map', '0:a:0?',
    '-c:a', 'aac',
    '-ac', '1',
    '-ar', '48000',
    '-b:a', '64k',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(cameraHlsDir, `segment_${sessionId}_%05d.ts`),
    indexPath
  ];

  const ff = spawn('ffmpeg', args);

  let stderr = '';
  ff.stderr.on('data', data => {
    stderr += data.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  ff.on('close', code => {
    const entry = liveProcesses.get(camera.id);
    if (entry && entry.process === ff) {
      entry.exitedAt = new Date().toISOString();
      entry.exitCode = code;
      entry.lastError = stderr;
      liveProcesses.delete(camera.id);
    }
  });

  const entry = {
    process: ff,
    startedAt: new Date().toISOString(),
    hlsUrl: `/hls/${camera.id}/index.m3u8`,
    lastError: () => stderr
  };

  liveProcesses.set(camera.id, entry);

  return {
    running: true,
    startedAt: entry.startedAt,
    hlsUrl: entry.hlsUrl
  };
}

function stopLiveStream(cameraId) {
  const entry = liveProcesses.get(cameraId);
  if (!entry) return false;

  entry.process.kill('SIGTERM');
  liveProcesses.delete(cameraId);
  return true;
}

function getHlsReadiness(cameraId) {
  const cameraHlsDir = path.join(HLS_DIR, cameraId);
  const indexPath = path.join(cameraHlsDir, 'index.m3u8');
  const sessionId = Date.now().toString(36);

  const playlistExists = fs.existsSync(indexPath);
  let segmentCount = 0;
  let playlist = '';

  if (fs.existsSync(cameraHlsDir)) {
    segmentCount = fs.readdirSync(cameraHlsDir).filter(name => name.endsWith('.ts')).length;
  }

  if (playlistExists) {
    try {
      playlist = fs.readFileSync(indexPath, 'utf8');
    } catch {
      playlist = '';
    }
  }

  return {
    ready: playlistExists && segmentCount >= 5,
    playlistExists,
    segmentCount,
    hlsUrl: `/hls/${cameraId}/index.m3u8`,
    playlistUpdatedAt: playlistExists ? fs.statSync(indexPath).mtime.toISOString() : null,
    playlistPreview: playlist.slice(0, 500)
  };
}

function captureThumbnail(camera) {
  return new Promise((resolve) => {
    ensureDataFiles();

    const thumbPath = path.join(THUMBS_DIR, `${camera.id}.jpg`);
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-timeout', '8000000',
      '-i', camera.rtspUrl,
      '-an',
      '-vf', 'fps=1,scale=640:-2',
      '-update', '1',
      '-frames:v', '1',
      '-ss', '4',
      '-q:v', '3',
      '-y',
      thumbPath
    ];

    const startedAt = Date.now();
    const ff = spawn('ffmpeg', args);

    let stderr = '';

    ff.stderr.on('data', data => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
    }, 12000);

    ff.on('close', (code) => {
      clearTimeout(timer);

      const ok = code === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;

      resolve({
        ok,
        code,
        durationMs: Date.now() - startedAt,
        thumbnail: ok ? `/thumbs/${camera.id}.jpg?ts=${Date.now()}` : null,
        error: ok ? null : (stderr || `ffmpeg exited with code ${code}`)
      });
    });
  });
}


function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderPage(content) {
  return `
<!doctype html>
<html>
<head>
  <title>ScottiBYTE MultiView Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg: #0b111c;
      --panel: #172235;
      --panel2: #111827;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --good: #16a34a;
      --bad: #dc2626;
      --warn: #f59e0b;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    header {
      padding: 24px 32px;
      background: linear-gradient(90deg, #0f172a, #1e293b);
      border-bottom: 1px solid var(--border);
    }

    header h1 {
      margin: 0;
      font-size: 30px;
    }

    header .subtitle {
      color: var(--muted);
      margin-top: 6px;
    }

    nav {
      display: flex;
      gap: 10px;
      padding: 14px 32px;
      background: #0f172a;
      border-bottom: 1px solid var(--border);
    }

    nav a {
      color: var(--text);
      text-decoration: none;
      background: #1e293b;
      border: 1px solid var(--border);
      padding: 9px 13px;
      border-radius: 10px;
      font-weight: bold;
      font-size: 14px;
    }

    nav a:hover {
      border-color: var(--accent);
    }

    main {
      padding: 32px;
      max-width: 1800px;
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 22px;
      margin-bottom: 22px;
      box-shadow: 0 10px 30px rgba(0,0,0,.28);
    }

    .status {
      display: inline-block;
      padding: 8px 12px;
      background: #14532d;
      color: #dcfce7;
      border-radius: 999px;
      font-weight: bold;
    }

    .muted {
      color: var(--muted);
    }

    code {
      color: #93c5fd;
    }

    label {
      display: block;
      margin-bottom: 6px;
      color: #cbd5e1;
      font-weight: bold;
      font-size: 14px;
    }

    input, select {
      width: 100%;
      padding: 11px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #0f172a;
      color: var(--text);
      font-size: 15px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    .form-actions {
      margin-top: 18px;
    }

    button {
      border: 0;
      border-radius: 10px;
      padding: 11px 15px;
      color: white;
      background: #2563eb;
      font-weight: bold;
      cursor: pointer;
    }

    button.danger {
      background: #b91c1c;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
      border-radius: 12px;
    }

    th, td {
      text-align: left;
      padding: 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }

    th {
      color: #cbd5e1;
      background: #0f172a;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .pill {
      display: inline-block;
      padding: 5px 9px;
      border-radius: 999px;
      background: #1e293b;
      border: 1px solid var(--border);
      color: #cbd5e1;
      font-size: 12px;
      font-weight: bold;
    }

    .empty {
      padding: 28px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--muted);
      background: rgba(255,255,255,.02);
    }


    .section-title {
      margin-bottom: 18px;
    }

    .section-title h2 {
      margin: 0 0 8px 0;
    }

    .camera-list-header {
      position: sticky;
      top: 0;
      z-index: 20;
      display: grid;
      grid-template-columns: 150px 190px 120px minmax(520px, 1fr) 130px 430px;
      gap: 12px;
      align-items: center;
      background: #0f172a;
      border: 1px solid var(--border);
      border-bottom: 0;
      border-radius: 12px 12px 0 0;
      padding: 12px;
      color: #cbd5e1;
      font-weight: bold;
      font-size: 14px;
      box-shadow: 0 2px 8px rgba(0,0,0,.35);
    }

    .camera-list-header a {
      color: #cbd5e1;
      text-decoration: none;
      border-bottom: 1px dotted #64748b;
      cursor: pointer;
    }

    .camera-list-header a::after {
      content: ' ⇅';
      color: #64748b;
      font-size: 11px;
      font-weight: normal;
    }

    .camera-list-header a:hover {
      color: var(--text);
      border-bottom-color: var(--accent);
    }

    .camera-list-header a:hover::after {
      color: var(--accent);
    }

    .camera-list-header a.active-sort::after {
      content: '';
    }

    .camera-table-scroll {
      max-height: calc(100vh - 300px);
      overflow-y: auto;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 0 0 12px 12px;
      position: relative;
    }

    .camera-row {
      min-width: 1540px;
      display: grid;
      grid-template-columns: 150px 190px 120px minmax(520px, 1fr) 130px 430px;
      gap: 12px;
      align-items: center;
      padding: 14px 12px;
      border-bottom: 1px solid var(--border);
    }

    .camera-row:last-child {
      border-bottom: 0;
    }

    .camera-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: flex-start;
      white-space: nowrap;
    }

    .sort-indicator {
      color: var(--accent);
      font-size: 12px;
      margin-left: 4px;
    }
    @media (max-width: 850px) {
      main {
        padding: 18px;
      }

      header {
        padding: 20px;
      }

      nav {
        padding: 12px 18px;
        flex-wrap: wrap;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      table {
        display: block;
        overflow-x: auto;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>ScottiBYTE MultiView Server</h1>
    <div class="subtitle">Self-hosted camera gateway for lightweight Android TV and remote clients</div>
  </header>

  <nav>
    <a href="/">Dashboard</a>
    <a href="/cameras">Cameras</a>
    <a href="/groups">Groups</a>
    <a href="/matrix">Matrix</a>
    <a href="/engine">Stream Engine</a>
    <a href="/api/health">API Health</a>
  </nav>

  <main>
    ${content}
  </main>
</body>
</html>
  `;
}


function fetchJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(parsed, response => {
      let body = '';

      response.on('data', chunk => {
        body += chunk.toString();
        if (body.length > 5_000_000) {
          req.destroy(new Error('Response too large'));
        }
      });

      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`HTTP ${response.statusCode}`));
        }

        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', reject);
  });
}

function normalizeMediaMtxPaths(payload) {
  if (!payload) return [];

  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.paths)) return payload.paths;
  if (Array.isArray(payload)) return payload;

  return [];
}

async function getStreamEngineStatus() {
  const cameras = loadCameras();

  let mediamtxOk = false;
  let mediamtxError = null;
  let paths = [];

  try {
    const payload = await fetchJson(`${MEDIAMTX_API_BASE}/v3/paths/list`);
    mediamtxOk = true;
    paths = normalizeMediaMtxPaths(payload);
  } catch (err) {
    mediamtxError = err.message || String(err);
  }

  const pathMap = new Map();

  for (const item of paths) {
    const name = item.name || item.path || item.confName;
    if (name) pathMap.set(name, item);
  }

  const cameraStatuses = cameras.map(camera => {
    const mediaPath = pathMap.get(camera.id) || null;
    const tracks2 = Array.isArray(mediaPath?.tracks2) ? mediaPath.tracks2 : [];
    const tracks = Array.isArray(mediaPath?.tracks) ? mediaPath.tracks : [];

    const videoTrack = tracks2.find(track => {
      const codec = String(track.codec || '').toLowerCase();
      return codec.includes('h264') || codec.includes('h265') || codec.includes('video');
    }) || null;

    const audioTrack = tracks2.find(track => {
      const codec = String(track.codec || '').toLowerCase();
      return codec.includes('audio') || codec.includes('aac') || codec.includes('opus');
    }) || null;

    const fallbackVideo = tracks.find(track => {
      const codec = String(track || '').toLowerCase();
      return codec.includes('h264') || codec.includes('h265') || codec.includes('video');
    }) || '';

    const fallbackAudio = tracks.find(track => {
      const codec = String(track || '').toLowerCase();
      return codec.includes('audio') || codec.includes('aac') || codec.includes('opus');
    }) || '';

    return {
      id: camera.id,
      name: camera.name,
      group: camera.group || 'Default',
      enabled: camera.enabled !== false,
      hlsUrl: `${MEDIAMTX_HLS_BASE}/${encodeURIComponent(camera.id)}/index.m3u8`,
      ready: Boolean(mediaPath?.ready),
      readers: Number(mediaPath?.readers?.length || mediaPath?.readerCount || 0),
      bytesReceived: Number(mediaPath?.bytesReceived || mediaPath?.inboundBytes || 0),
      bytesSent: Number(mediaPath?.bytesSent || mediaPath?.outboundBytes || 0),
      videoCodec: videoTrack?.codec || fallbackVideo || '',
      audioCodec: audioTrack?.codec || fallbackAudio || '',
      width: videoTrack?.codecProps?.width || '',
      height: videoTrack?.codecProps?.height || '',
      videoProfile: videoTrack?.codecProps?.profile || '',
      videoLevel: videoTrack?.codecProps?.level || ''
    };
  });

  return {
    ok: true,
    mediamtxOk,
    mediamtxError,
    mediamtxApiBase: MEDIAMTX_API_BASE,
    mediamtxHlsBase: MEDIAMTX_HLS_BASE,
    cameraCount: cameras.length,
    readyCount: cameraStatuses.filter(camera => camera.ready).length,
    cameras: cameraStatuses,
    timestamp: new Date().toISOString()
  };
}


app.get('/', (req, res) => {
  const cameras = loadCameras();

  res.send(renderPage(`
    <div class="card">
      <p><span class="status">Server Online</span></p>
      <p>This container is the camera gateway for MultiView.</p>
      <p>Public URL: <code>${PUBLIC_URL}</code></p>
      <p>Configured cameras: <strong>${cameras.length}</strong></p>
    </div>

    <div class="card">
      <h2>System Role</h2>
      <p>The server stores camera definitions, publishes RTSP cameras through MediaMTX, and provides web and Android TV clients with stable HLS stream URLs.</p>
      <ul>
        <li>Camera credentials stay server-side</li>
        <li>MediaMTX provides persistent HLS streams</li>
        <li>Web and Android TV clients receive safe stream URLs</li>
        <li>Remote access can be added externally through a reverse proxy or VPN</li>
      </ul>
    </div>
  `));
});



app.get('/engine', async (req, res) => {
  const status = await getStreamEngineStatus();

  const rows = status.cameras.map(camera => {
    const readyPill = camera.ready
      ? '<span class="pill" style="background:#14532d;color:#dcfce7;">Ready</span>'
      : '<span class="pill" style="background:#7f1d1d;color:#fee2e2;">Not Ready</span>';

    const resolution = camera.width && camera.height
      ? `${escapeHtml(camera.width)}x${escapeHtml(camera.height)}`
      : '<span class="muted">Unknown</span>';

    const video = camera.videoCodec
      ? `${escapeHtml(camera.videoCodec)}${camera.videoProfile ? ` ${escapeHtml(camera.videoProfile)}` : ''}${camera.videoLevel ? ` L${escapeHtml(camera.videoLevel)}` : ''}`
      : '<span class="muted">Unknown</span>';

    const audio = camera.audioCodec
      ? escapeHtml(camera.audioCodec)
      : '<span class="muted">None / Unknown</span>';

    return `
      <tr>
        <td>
          <strong>${escapeHtml(camera.name)}</strong><br>
          <span class="muted">${escapeHtml(camera.id)}</span>
        </td>
        <td>${escapeHtml(camera.group)}</td>
        <td>${readyPill}</td>
        <td>${resolution}</td>
        <td>${video}</td>
        <td>${audio}</td>
        <td>${camera.readers}</td>
        <td><code>${escapeHtml(camera.hlsUrl)}</code></td>
        <td style="white-space:nowrap;">
          <a href="/live/${encodeURIComponent(camera.id)}" style="text-decoration:none;">
            <button type="button">Open Live</button>
          </a>
        </td>
      </tr>
    `;
  }).join('');

  const engineStatus = status.mediamtxOk
    ? `<span class="status">MediaMTX Online</span>`
    : `<span class="pill" style="background:#7f1d1d;color:#fee2e2;">MediaMTX API Error</span>`;

  res.send(renderPage(`
    <div class="card">
      <h2>Stream Engine</h2>
      <p>${engineStatus}</p>
      <p class="muted">Read-only view of the persistent MediaMTX stream engine.</p>
      <p>Ready streams: <strong>${status.readyCount}</strong> / <strong>${status.cameraCount}</strong></p>
      <p>MediaMTX API: <code>${escapeHtml(status.mediamtxApiBase)}</code></p>
      <p>MediaMTX HLS: <code>${escapeHtml(status.mediamtxHlsBase)}</code></p>
      ${status.mediamtxError ? `<p><strong>Error:</strong> <code>${escapeHtml(status.mediamtxError)}</code></p>` : ''}
    </div>

    <div class="card">
      <h2>Camera Stream Status</h2>
      <table>
        <thead>
          <tr>
            <th>Camera</th>
            <th>Group</th>
            <th>Status</th>
            <th>Resolution</th>
            <th>Video</th>
            <th>Audio</th>
            <th>Readers</th>
            <th>HLS URL</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="9" class="muted">No cameras configured.</td></tr>'}
        </tbody>
      </table>
    </div>
  `));
});


app.get('/matrix', (req, res) => {
  const cameras = loadCameras();

  const cards = cameras.map(camera => {
    const thumbFile = path.join(THUMBS_DIR, `${camera.id}.jpg`);
    const thumbHtml = fs.existsSync(thumbFile)
      ? `<img src="/thumbs/${camera.id}.jpg?ts=${fs.statSync(thumbFile).mtimeMs}" style="width:100%;height:170px;object-fit:cover;border-radius:12px;border:1px solid var(--border);background:#020617;">`
      : `<div style="height:170px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--border);border-radius:12px;color:var(--muted);background:#0f172a;">No thumbnail</div>`;

    const lastTest = camera.lastTest
      ? (camera.lastTest.ok ? 'Last test: OK' : 'Last test: Failed')
      : 'Not tested';

    return `
      <div class="card" style="padding:14px;margin:0;">
        ${thumbHtml}
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:12px;">
          <div>
            <div style="font-weight:bold;font-size:17px;">${escapeHtml(camera.name)}</div>
            <div class="muted" style="font-size:13px;">${escapeHtml(camera.group || 'Default')} · ${escapeHtml(camera.liveProfile || 'copy')} · ${escapeHtml(lastTest)}</div>
          </div>
          <span class="pill">${escapeHtml(camera.type || 'rtsp')}</span>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <a href="/live/${encodeURIComponent(camera.id)}" style="text-decoration:none;">
            <button type="button">Live</button>
          </a>
          <a href="/cameras/${encodeURIComponent(camera.id)}/edit" style="text-decoration:none;">
            <button type="button">Edit</button>
          </a>
          <form method="post" action="/api/cameras/${camera.id}/test">
            <button type="submit">Refresh Thumbnail</button>
          </form>
        </div>
      </div>
    `;
  }).join('');

  res.send(renderPage(`
    <div class="card">
      <h2>Camera Matrix</h2>
      <p class="muted">Server-side camera thumbnails from configured RTSP sources.</p>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;">
      ${cards || '<div class="empty">No cameras configured yet.</div>'}
    </div>
  `));
});


app.get('/groups', (req, res) => {
  const cameras = loadCameras();
  const groups = getGroupNames(cameras);

  const groupRows = groups.map(group => {
    const count = cameras.filter(camera => (camera.group || 'Default') === group).length;
    const deleteControl = count === 0
      ? `<form method="post" action="/api/groups/${encodeURIComponent(group)}/delete" style="display:inline-block;">
           <button class="danger" type="submit">Delete</button>
         </form>`
      : `<span class="muted">Delete disabled while cameras are assigned</span>`;

    return `
      <tr>
        <td><strong>${escapeHtml(group)}</strong></td>
        <td>${count}</td>
        <td>
          <form method="post" action="/api/groups/${encodeURIComponent(group)}/rename" style="display:flex;gap:8px;align-items:center;">
            <input name="name" value="${escapeHtml(group)}" style="max-width:260px;">
            <button type="submit">Rename</button>
          </form>
        </td>
        <td>${deleteControl}</td>
      </tr>
    `;
  }).join('');

  const groupOptions = groups.map(group => {
    return `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`;
  }).join('');

  const cameraRows = cameras.map(camera => {
    const options = groups.map(group => {
      const selected = (camera.group || 'Default') === group ? 'selected' : '';
      return `<option value="${escapeHtml(group)}" ${selected}>${escapeHtml(group)}</option>`;
    }).join('');

    return `
      <tr>
        <td>
          <strong>${escapeHtml(camera.name)}</strong><br>
          <span class="muted">${escapeHtml(camera.id)}</span>
        </td>
        <td>${escapeHtml(camera.group || 'Default')}</td>
        <td>
          <form method="post" action="/api/cameras/${encodeURIComponent(camera.id)}/group" style="display:flex;gap:8px;align-items:center;">
            <select name="group" style="max-width:260px;">
              ${options}
            </select>
            <button type="submit">Assign</button>
          </form>
        </td>
      </tr>
    `;
  }).join('');

  res.send(renderPage(`
    <div class="card">
      <h2>Camera Groups</h2>
      <p class="muted">Groups are admin metadata used to organize cameras. The Android TV client may use these for filtering, but user-created viewing layouts belong in the Android app.</p>

      <form method="post" action="/api/groups" style="display:flex;gap:10px;align-items:end;max-width:560px;">
        <div style="flex:1;">
          <label>New Group Name</label>
          <input name="name" placeholder="Garage">
        </div>
        <button type="submit">Create Group</button>
      </form>
    </div>

    <div class="card">
      <h2>Existing Groups</h2>
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>Cameras</th>
            <th>Rename</th>
            <th>Delete</th>
          </tr>
        </thead>
        <tbody>
          ${groupRows || '<tr><td colspan="4" class="muted">No groups configured.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Assign Cameras to Groups</h2>
      <table>
        <thead>
          <tr>
            <th>Camera</th>
            <th>Current Group</th>
            <th>Assign Group</th>
          </tr>
        </thead>
        <tbody>
          ${cameraRows || '<tr><td colspan="3" class="muted">No cameras configured.</td></tr>'}
        </tbody>
      </table>
    </div>
  `));
});


app.get('/cameras', async (req, res) => {
  const cameras = loadCameras();
  const engine = await getStreamEngineStatus();
  const engineById = new Map(engine.cameras.map(camera => [camera.id, camera]));
  const sort = String(req.query.sort || 'name').toLowerCase();
  const dir = String(req.query.dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  const multiplier = dir === 'desc' ? -1 : 1;

  const sortedCameras = [...cameras].sort((a, b) => {
    if (sort === 'name') {
      return multiplier * String(a.name || '').localeCompare(String(b.name || ''));
    }

    if (sort === 'group') {
      const groupCompare = String(a.group || 'Default').localeCompare(String(b.group || 'Default'));
      return groupCompare !== 0
        ? multiplier * groupCompare
        : String(a.name || '').localeCompare(String(b.name || ''));
    }

    if (sort === 'audio') {
      const aAudio = Boolean(engineById.get(a.id)?.audioCodec);
      const bAudio = Boolean(engineById.get(b.id)?.audioCodec);
      const audioCompare = Number(aAudio) - Number(bAudio);
      return audioCompare !== 0
        ? multiplier * audioCompare
        : String(a.name || '').localeCompare(String(b.name || ''));
    }

    return 0;
  });

  const nextDir = dir === 'asc' ? 'desc' : 'asc';

  function sortHeader(label, key) {
    const targetDir = sort === key ? nextDir : 'asc';
    const indicator = sort === key
      ? `<span class="sort-indicator">${dir === 'asc' ? '▲' : '▼'}</span>`
      : '';
    const activeClass = sort === key ? ' class="active-sort"' : '';

    return `<a${activeClass} href="/cameras?sort=${key}&dir=${targetDir}" title="Sort by ${label}">${label}${indicator}</a>`;
  }

  const rows = sortedCameras.map(camera => {
    const thumbFile = path.join(THUMBS_DIR, `${camera.id}.jpg`);
    const thumbHtml = fs.existsSync(thumbFile)
      ? `<img src="/thumbs/${camera.id}.jpg?ts=${fs.statSync(thumbFile).mtimeMs}" style="width:160px;max-width:100%;border-radius:10px;border:1px solid var(--border);">`
      : `<span class="muted">No thumbnail yet</span>`;

    const streamInfo = engineById.get(camera.id);
    const audioHtml = streamInfo?.audioCodec
      ? `<span class="pill" style="background:#14532d;color:#dcfce7;" title="${escapeHtml(streamInfo.audioCodec)}">Audio</span>`
      : '<span class="pill">Video Only</span>';

    return `
    <div class="camera-row">
      <div>${thumbHtml}</div>
      <div><strong>${escapeHtml(camera.name)}</strong><br><span class="muted">${escapeHtml(camera.id)}</span></div>
      <div>${escapeHtml(camera.group || 'Default')}</div>
      <div><code>${escapeHtml(camera.rtspUrl).replace(/\/\/.*?:.*?@/, '//***:***@')}</code></div>
      <div>${audioHtml}</div>
      <div class="camera-actions">
        <a href="/live/${encodeURIComponent(camera.id)}" style="text-decoration:none;">
          <button type="button">Live</button>
        </a>
        <a href="/cameras/${encodeURIComponent(camera.id)}/edit" style="text-decoration:none;">
          <button type="button">Edit</button>
        </a>
        <form method="post" action="/api/cameras/${encodeURIComponent(camera.id)}/test">
          <button type="submit">Refresh Thumbnail</button>
        </form>
        <form method="post" action="/api/cameras/${encodeURIComponent(camera.id)}/delete">
          <button class="danger" type="submit">Delete</button>
        </form>
      </div>
    </div>
  `;
  }).join('');

  const groups = getGroupNames(cameras);
  const groupOptions = groups.map(group => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join('');

  res.send(renderPage(`
    <div class="card">
      <h2>Add RTSP Camera</h2>
      <p class="muted">Add a new RTSP camera source. The server stores the RTSP credentials and publishes the camera through MediaMTX.</p>

      <form method="post" action="/api/cameras">
        <div class="grid">
          <div>
            <label>Camera Name</label>
            <input name="name" placeholder="Front Door" required>
          </div>

          <div>
            <label>Group</label>
            <select name="group">
              ${groupOptions}
            </select>
          </div>

          <div>
            <label>Audio Enabled</label>
            <select name="audioEnabled">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
        </div>

        <input type="hidden" name="type" value="rtsp">
        <input type="hidden" name="liveProfile" value="copy">

        <div style="margin-top:16px;">
          <label>RTSP URL</label>
          <input name="rtspUrl" placeholder="rtsp://user:password@192.168.1.50:554/stream1" required>
        </div>

        <div class="form-actions">
          <button type="submit">Add Camera</button>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="section-title">
        <h2>Configured Cameras</h2>
        <p class="muted">RTSP camera inputs published through MediaMTX as stable HLS streams.</p>
      </div>

      ${cameras.length === 0 ? `
        <div class="empty">No cameras configured yet. Add your first RTSP camera above.</div>
      ` : `
        <div class="camera-list-header">
          <div>Thumbnail</div>
          <div>${sortHeader('Name', 'name')}</div>
          <div>${sortHeader('Group', 'group')}</div>
          <div>RTSP URL</div>
          <div>${sortHeader('Stream Audio', 'audio')}</div>
          <div>Action</div>
        </div>
        <div class="camera-table-scroll">
          ${rows}
        </div>
      `}
    </div>
  `));
});


app.get('/live/:id', (req, res) => {
  const cameras = loadCameras();
  const camera = cameras.find(camera => camera.id === req.params.id);

  if (!camera) {
    return res.status(404).send(renderPage(`
      <div class="card">
        <h2>Camera Not Found</h2>
        <p>No camera exists with ID <code>${escapeHtml(req.params.id)}</code>.</p>
        <p><a href="/matrix">Return to Matrix</a></p>
      </div>
    `));
  }

  const hlsUrl = `${MEDIAMTX_HLS_BASE}/${encodeURIComponent(camera.id)}/index.m3u8`;

  res.send(renderPage(`
    <div class="card">
      <h2>Live Preview: ${escapeHtml(camera.name)}</h2>
      <p class="muted">${escapeHtml(camera.group || 'Default')} · ${escapeHtml(camera.id)}</p>

      <video id="video" controls autoplay muted playsinline style="width:100%;max-width:1100px;background:#000;border-radius:14px;border:1px solid var(--border);"></video>

      <div style="margin-top:16px;display:flex;gap:10px;align-items:center;">
        <form method="post" action="/api/cameras/${encodeURIComponent(camera.id)}/live/start">
          <button type="submit">Restart Stream</button>
        </form>
        <form method="post" action="/api/cameras/${encodeURIComponent(camera.id)}/live/stop">
          <button class="danger" type="submit">Stop Stream</button>
        </form>
        <a href="/matrix" style="color:#93c5fd;">Back to Matrix</a>
      </div>

      <p class="muted">HLS URL: <code>${escapeHtml(hlsUrl)}</code></p>
    </div>

    <div id="streamStatus" class="muted" style="margin-top:12px;">Preparing stream...</div>

    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <script>
      const video = document.getElementById('video');
      const hlsUrl = ${JSON.stringify(hlsUrl)};
      const readyUrl = '/api/cameras/${encodeURIComponent(camera.id)}/live/ready';
      const statusEl = document.getElementById('streamStatus');

      let hls = null;
      let playerStarted = false;
      let playerStartTime = 0;
      let retryCount = 0;

      function destroyPlayer() {
        try {
          if (hls) {
            hls.destroy();
            hls = null;
          }
        } catch (err) {}
        video.removeAttribute('src');
        video.load();
        playerStarted = false;
      }

      function startPlayer() {
        if (playerStarted) return;
        playerStarted = true;
        playerStartTime = Date.now();

        statusEl.textContent = 'Stream ready. Starting player...';

        const sourceUrl = hlsUrl + '?ts=' + Date.now();

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = sourceUrl;
          video.play().catch(function() {});
        } else if (window.Hls && Hls.isSupported()) {
          hls = new Hls({
            lowLatencyMode: false,
            liveSyncDurationCount: 4,
            liveMaxLatencyDurationCount: 8,
            manifestLoadingTimeOut: 15000,
            manifestLoadingMaxRetry: 10,
            levelLoadingMaxRetry: 10,
            fragLoadingMaxRetry: 10,
            startFragPrefetch: true
          });

          hls.on(Hls.Events.ERROR, function(event, data) {
            console.warn('HLS error', data);

            if (data && data.fatal) {
              statusEl.textContent = 'Player retrying after fatal HLS error...';

              try {
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                  hls.startLoad();
                  return;
                }

                if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                  hls.recoverMediaError();
                  return;
                }
              } catch (err) {}

              retryPlayerSoon();
            } else if (data && data.details) {
              statusEl.textContent = 'Player warning: ' + data.details;
            }
          });

          hls.on(Hls.Events.MANIFEST_PARSED, function() {
            statusEl.textContent = 'Playing live stream.';
            video.play().catch(function() {});
          });

          hls.loadSource(sourceUrl);
          hls.attachMedia(video);
        } else {
          video.outerHTML = '<p>HLS playback is not supported in this browser.</p>';
          statusEl.textContent = 'HLS playback is not supported in this browser.';
        }

        setTimeout(function() {
          if (!video.currentTime || video.currentTime < 0.5) {
            retryPlayerSoon();
          }
        }, 8000);
      }

      function retryPlayerSoon() {
        if (retryCount >= 5) {
          statusEl.textContent = 'Stream is ready, but the browser player did not start. Press Restart Stream.';
          return;
        }

        retryCount += 1;
        destroyPlayer();
        statusEl.textContent = 'Retrying player startup... attempt ' + retryCount;

        setTimeout(function() {
          waitForStreamReady(1);
        }, 2000);
      }

      function waitForStreamReady() {
        statusEl.textContent = 'Opening persistent MediaMTX stream...';
        setTimeout(startPlayer, 1000);
      }

      waitForStreamReady();
    </script>
  `));
});

app.post('/api/cameras/:id/live/start', (req, res) => {
  const cameras = loadCameras();
  const camera = cameras.find(camera => camera.id === req.params.id);

  if (!camera) {
    return res.status(404).json({ ok: false, error: 'Camera not found.' });
  }

  stopLiveStream(camera.id);
  const status = startLiveStream(camera);

  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect(`/live/${encodeURIComponent(camera.id)}`);
  }

  res.json({ ok: true, ...status });
});

app.post('/api/cameras/:id/live/stop', (req, res) => {
  const stopped = stopLiveStream(req.params.id);

  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/matrix');
  }

  res.json({ ok: true, stopped });
});

app.get('/api/cameras/:id/live/ready', (req, res) => {
  res.json({
    ok: true,
    cameraId: req.params.id,
    ...getLiveStatus(req.params.id),
    ...getHlsReadiness(req.params.id)
  });
});

app.get('/api/cameras/:id/live/status', (req, res) => {
  res.json({
    ok: true,
    cameraId: req.params.id,
    ...getLiveStatus(req.params.id)
  });
});

app.get('/cameras/:id/edit', (req, res) => {
  const cameras = loadCameras();
  const camera = cameras.find(camera => camera.id === req.params.id);

  if (!camera) {
    return res.status(404).send(renderPage(`
      <div class="card">
        <h2>Camera Not Found</h2>
        <p>No camera exists with ID <code>${escapeHtml(req.params.id)}</code>.</p>
        <p><a href="/cameras">Return to Cameras</a></p>
      </div>
    `));
  }

  const lastTest = camera.lastTest
    ? `<p><strong>Last Test:</strong> ${camera.lastTest.ok ? 'Success' : 'Failed'} at ${escapeHtml(camera.lastTest.testedAt || '')}</p>
       ${camera.lastTest.error ? `<p><strong>Error:</strong> <code>${escapeHtml(camera.lastTest.error)}</code></p>` : ''}`
    : `<p class="muted">No test has been run for this camera yet.</p>`;

  res.send(renderPage(`
    <div class="card">
      <h2>Edit Camera</h2>
      <form method="post" action="/api/cameras/${encodeURIComponent(camera.id)}/update">
        <div class="grid">
          <div>
            <label>Camera Name</label>
            <input name="name" value="${escapeHtml(camera.name)}" required>
          </div>

          <div>
            <label>Group</label>
            <input name="group" value="${escapeHtml(camera.group || 'Default')}">
          </div>

          <div>
            <label>Type</label>
            <select name="type">
              <option value="rtsp" ${camera.type === 'rtsp' ? 'selected' : ''}>RTSP Camera</option>
            </select>
          </div>

          <div>
            <label>Audio Enabled</label>
            <select name="audioEnabled">
              <option value="true" ${camera.audioEnabled ? 'selected' : ''}>Yes</option>
              <option value="false" ${!camera.audioEnabled ? 'selected' : ''}>No</option>
            </select>
          </div>

          <div>
            <label>Live Profile</label>
            <select name="liveProfile">
              <option value="copy" ${(camera.liveProfile || 'copy') === 'copy' ? 'selected' : ''}>Copy Stream</option>
              <option value="transcode720" ${camera.liveProfile === 'transcode720' ? 'selected' : ''}>Transcode 720p</option>
              <option value="transcode1080" ${camera.liveProfile === 'transcode1080' ? 'selected' : ''}>Transcode 1080p</option>
            </select>
          </div>
        </div>

        <div style="margin-top:16px;">
          <label>RTSP URL</label>
          <input name="rtspUrl" value="${escapeHtml(camera.rtspUrl)}" required>
        </div>

        <div class="form-actions">
          <button type="submit">Save Changes</button>
          <a href="/cameras" style="margin-left:12px;color:#93c5fd;">Cancel</a>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Test Status</h2>
      ${lastTest}
    </div>
  `));
});

app.post('/api/cameras/:id/update', (req, res) => {
  const cameras = loadCameras();
  const camera = cameras.find(camera => camera.id === req.params.id);

  if (!camera) {
    return res.status(404).json({ ok: false, error: 'Camera not found.' });
  }

  const name = String(req.body.name || '').trim();
  const rtspUrl = String(req.body.rtspUrl || '').trim();

  if (!name || !rtspUrl) {
    return res.status(400).json({ ok: false, error: 'Camera name and RTSP URL are required.' });
  }

  camera.name = name;
  camera.type = req.body.type || 'rtsp';
  camera.group = ensureGroupExists(req.body.group);
  camera.rtspUrl = rtspUrl;
  camera.audioEnabled = req.body.audioEnabled === 'true';
  camera.liveProfile = req.body.liveProfile || 'copy';
  camera.updatedAt = new Date().toISOString();

  saveCameras(cameras);
  res.redirect('/cameras');
});


app.get('/api/engine/status', async (req, res) => {
  res.json(await getStreamEngineStatus());
});


app.get('/api/tv/config', async (req, res) => {
  const engine = await getStreamEngineStatus();

  const cameras = engine.cameras
    .filter(camera => camera.enabled !== false)
    .map((camera, index) => {
      const resolution = camera.width && camera.height
        ? `${camera.width}x${camera.height}`
        : null;

      return {
        id: camera.id,
        name: camera.name,
        group: camera.group || 'Default',
        enabled: camera.enabled !== false,
        ready: camera.ready,
        sortOrder: index,
        streams: {
          hls: camera.hlsUrl,
          livePage: `${PUBLIC_URL}/live/${encodeURIComponent(camera.id)}`
        },
        images: {
          thumbnail: `${PUBLIC_URL}/thumbs/${encodeURIComponent(camera.id)}.jpg`
        },
        video: {
          resolution,
          width: camera.width || null,
          height: camera.height || null,
          codec: camera.videoCodec || null,
          profile: camera.videoProfile || null,
          level: camera.videoLevel || null
        },
        audio: {
          codec: camera.audioCodec || null,
          available: Boolean(camera.audioCodec)
        }
      };
    });

  const groups = getGroupNames()
    .map(name => ({
      name,
      purpose: 'camera-metadata',
      cameraIds: cameras
        .filter(camera => camera.group === name)
        .map(camera => camera.id)
    }));

  res.json({
    ok: true,
    role: 'android-tv-camera-catalog',
    server: {
      name: 'ScottiBYTE MultiView Server',
      version: '0.3.1',
      publicUrl: PUBLIC_URL
    },
    streamEngine: {
      type: 'MediaMTX',
      online: engine.mediamtxOk,
      hlsBaseUrl: MEDIAMTX_HLS_BASE,
      cameraCount: cameras.length,
      readyCount: cameras.filter(camera => camera.ready).length
    },
    groups,
    cameras,
    clientHints: {
      layoutOwnership: 'client',
      groupPurpose: 'metadata',
      defaultSort: 'configured-order',
      recommendedStartupView: 'last-used-or-all-cameras',
      credentialsPolicy: 'server-side-only'
    },
    timestamp: new Date().toISOString()
  });
});


app.post('/api/groups', (req, res) => {
  const name = String(req.body.name || '').trim();

  if (!name) {
    return res.status(400).json({ ok: false, error: 'Group name is required.' });
  }

  ensureGroupExists(name);
  res.redirect('/groups');
});

app.post('/api/groups/:groupName/rename', (req, res) => {
  const oldName = String(req.params.groupName || '').trim();
  const newName = String(req.body.name || '').trim();

  if (!oldName || !newName) {
    return res.status(400).json({ ok: false, error: 'Old and new group names are required.' });
  }

  const cameras = loadCameras();
  let changed = false;

  for (const camera of cameras) {
    if ((camera.group || 'Default') === oldName) {
      camera.group = newName;
      camera.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) saveCameras(cameras);

  const groups = getGroupNames(cameras)
    .filter(group => group !== oldName);

  groups.push(newName);
  saveGroups(groups);

  res.redirect('/groups');
});

app.post('/api/groups/:groupName/delete', (req, res) => {
  const groupName = String(req.params.groupName || '').trim();
  const cameras = loadCameras();
  const count = cameras.filter(camera => (camera.group || 'Default') === groupName).length;

  if (count > 0) {
    return res.status(400).send(renderPage(`
      <div class="card">
        <h2>Cannot Delete Group</h2>
        <p>The group <code>${escapeHtml(groupName)}</code> still has ${count} camera(s) assigned.</p>
        <p><a href="/groups" style="color:#93c5fd;">Return to Groups</a></p>
      </div>
    `));
  }

  const groups = loadGroups().filter(group => group !== groupName);
  saveGroups(groups);

  res.redirect('/groups');
});

app.post('/api/cameras/:id/group', (req, res) => {
  const cameras = loadCameras();
  const camera = cameras.find(camera => camera.id === req.params.id);

  if (!camera) {
    return res.status(404).json({ ok: false, error: 'Camera not found.' });
  }

  const group = ensureGroupExists(req.body.group);
  camera.group = group;
  camera.updatedAt = new Date().toISOString();

  saveCameras(cameras);
  res.redirect('/groups');
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'ScottiBYTE MultiView Server',
    version: '0.3.1',
    publicUrl: PUBLIC_URL,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/cameras', (req, res) => {
  res.json(loadCameras());
});

app.post('/api/cameras', (req, res) => {
  const cameras = loadCameras();

  const name = String(req.body.name || '').trim();
  const rtspUrl = String(req.body.rtspUrl || '').trim();

  if (!name || !rtspUrl) {
    return res.status(400).json({ ok: false, error: 'Camera name and RTSP URL are required.' });
  }

  let id = safeId(name);
  if (cameras.some(camera => camera.id === id)) {
    id = `${id}-${Date.now()}`;
  }

  cameras.push({
    id,
    name,
    type: req.body.type || 'rtsp',
    group: ensureGroupExists(req.body.group),
    rtspUrl,
    audioEnabled: req.body.audioEnabled === 'true',
    liveProfile: req.body.liveProfile || 'copy',
    enabled: true,
    lastTest: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  saveCameras(cameras);
  res.redirect('/cameras');
});


app.post('/api/cameras/:id/test', async (req, res) => {
  const cameras = loadCameras();
  const camera = cameras.find(camera => camera.id === req.params.id);

  if (!camera) {
    return res.status(404).json({ ok: false, error: 'Camera not found.' });
  }

  const result = await captureThumbnail(camera);

  camera.lastTest = {
    ok: result.ok,
    testedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    error: result.error
  };
  camera.updatedAt = new Date().toISOString();

  saveCameras(cameras);

  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/cameras');
  }

  res.json(result);
});

app.post('/api/cameras/:id/delete', (req, res) => {
  const cameras = loadCameras();
  const next = cameras.filter(camera => camera.id !== req.params.id);

  saveCameras(next);
  res.redirect('/cameras');
});

ensureDataFiles();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ScottiBYTE MultiView Server listening on port ${PORT}`);
});
