const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.MULTIVIEW_PUBLIC_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.MULTIVIEW_DATA_DIR || '/app/data';
const CAMERAS_FILE = path.join(DATA_DIR, 'cameras.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TV_CLIENTS_FILE = path.join(DATA_DIR, 'tv-clients.json');
const PAIRING_REQUESTS_FILE = path.join(DATA_DIR, 'pairing-requests.json');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HLS_DIR = path.join(DATA_DIR, 'hls');
const MEDIAMTX_HLS_BASE = process.env.MEDIAMTX_HLS_BASE || 'http://172.16.2.85:8888';
const MEDIAMTX_API_BASE = process.env.MEDIAMTX_API_BASE || 'http://127.0.0.1:9997';

const SESSION_COOKIE = 'multiview_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/thumbs', express.static(THUMBS_DIR));
app.use(express.static(PUBLIC_DIR));
app.use('/hls', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}, express.static(HLS_DIR));

app.use(requireLogin);

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

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  }

  if (!fs.existsSync(TV_CLIENTS_FILE)) {
    fs.writeFileSync(TV_CLIENTS_FILE, JSON.stringify([], null, 2));
  }

  if (!fs.existsSync(PAIRING_REQUESTS_FILE)) {
    fs.writeFileSync(PAIRING_REQUESTS_FILE, JSON.stringify([], null, 2));
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


function loadUsers() {
  ensureDataFiles();

  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch (err) {
    console.error('Failed to load users.json:', err);
    return [];
  }
}

function saveUsers(users) {
  ensureDataFiles();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password) {
  const iterations = 210000;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');

  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }

  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], 'hex');

  if (!iterations || !salt || expected.length === 0) {
    return false;
  }

  const actual = crypto.pbkdf2Sync(String(password || ''), salt, iterations, expected.length, 'sha256');

  if (actual.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';

  return Object.fromEntries(
    header
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const splitAt = part.indexOf('=');
        if (splitAt === -1) return [part, ''];
        return [
          decodeURIComponent(part.slice(0, splitAt)),
          decodeURIComponent(part.slice(splitAt + 1))
        ];
      })
  );
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(token, {
    username: user.username,
    role: user.role || 'admin',
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  return token;
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];

  if (!token) return null;

  const session = sessions.get(token);

  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function hasAdminUser() {
  return loadUsers().some(user => user.role === 'admin');
}


function loadTvClients() {
  ensureDataFiles();

  try {
    const raw = fs.readFileSync(TV_CLIENTS_FILE, 'utf8');
    const clients = JSON.parse(raw);
    return Array.isArray(clients) ? clients : [];
  } catch (err) {
    console.error('Failed to load tv-clients.json:', err);
    return [];
  }
}

function saveTvClients(clients) {
  ensureDataFiles();
  fs.writeFileSync(TV_CLIENTS_FILE, JSON.stringify(clients, null, 2));
}

function loadPairingRequests() {
  ensureDataFiles();

  try {
    const raw = fs.readFileSync(PAIRING_REQUESTS_FILE, 'utf8');
    const requests = JSON.parse(raw);
    return Array.isArray(requests) ? requests : [];
  } catch (err) {
    console.error('Failed to load pairing-requests.json:', err);
    return [];
  }
}

function savePairingRequests(requests) {
  ensureDataFiles();
  fs.writeFileSync(PAIRING_REQUESTS_FILE, JSON.stringify(requests, null, 2));
}

function cleanupExpiredPairingRequests() {
  const now = Date.now();
  const active = loadPairingRequests().filter(request => {
    return !request.deniedAt && Date.parse(request.expiresAt || '') > now;
  });

  savePairingRequests(active);
  return active;
}

function generatePairingCode() {
  const requests = cleanupExpiredPairingRequests();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!requests.some(request => request.pairingCode === code)) {
      return code;
    }
  }

  return String(Date.now()).slice(-6);
}

function formatPairingCode(code) {
  const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
  return clean.length === 6 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
}

function generateTvClientId() {
  return `tv_${crypto.randomBytes(8).toString('hex')}`;
}

function generateTvClientToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function requireTvClientAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
  const suppliedToken = bearer ? bearer[1] : '';

  if (!suppliedToken) {
    return res.status(401).json({
      ok: false,
      error: 'Remote client token required'
    });
  }

  const clients = loadTvClients();
  const client = clients.find(client => {
    return !client.revokedAt && verifyPassword(suppliedToken, client.tokenHash);
  });

  if (!client) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid Remote client token'
    });
  }

  client.lastSeenAt = new Date().toISOString();
  saveTvClients(clients);

  req.tvClient = {
    id: client.id,
    name: client.name,
    role: 'tv-client'
  };

  return next();
}


function wantsJson(req) {
  return String(req.headers.accept || '').includes('application/json')
    || req.path.startsWith('/api/');
}

function requireLogin(req, res, next) {
  const publicPaths = new Set([
    '/favicon.png',
    '/login',
    '/setup',
    '/logout',
    '/api/health'
  ]);

  if (req.path === '/api/tv/config') {
    return requireTvClientAuth(req, res, next);
  }

  if (req.path === '/api/tv/pairing/request' || req.path === '/api/tv/pairing/status') {
    return next();
  }

  if (publicPaths.has(req.path)) {
    return next();
  }

  if (!hasAdminUser()) {
    if (wantsJson(req)) {
      return res.status(401).json({ ok: false, error: 'Admin setup required' });
    }
    return res.redirect('/setup');
  }

  const session = getSession(req);

  if (session && session.role === 'admin') {
    req.user = session;
    return next();
  }

  if (wantsJson(req)) {
    return res.status(401).json({ ok: false, error: 'Login required' });
  }

  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
}


function safeId(name) {
  return String(name || 'camera')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `camera-${Date.now()}`;
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


// Container-managed FFmpeg publishers.
// These replace the old host-side systemd publisher services for Docker installs.
const publishers = new Map();

function isPublisherCameraEnabled(camera) {
  return Boolean(camera && camera.enabled !== false && camera.rtspUrl && camera.id);
}

function buildPublisherArgs(camera) {
  const camId = camera.id;
  const rtspUrl = camera.rtspUrl;
  const liveProfile = camera.liveProfile || 'copy';
  const rtspLower = String(rtspUrl || '').toLowerCase();

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-map', '0:v:0'
  ];

  const shouldTranscode =
    liveProfile === 'transcode720' ||
    liveProfile === 'transcode1080' ||
    rtspLower.includes('h265') ||
    rtspLower.includes('hevc');

  if (shouldTranscode) {
    const height = liveProfile === 'transcode1080' ? '1080' : '720';
    const bitrate = liveProfile === 'transcode1080' ? '5000k' : '3000k';
    const maxrate = liveProfile === 'transcode1080' ? '6500k' : '4000k';
    const bufsize = liveProfile === 'transcode1080' ? '10000k' : '7000k';

    args.push(
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-b:v', bitrate,
      '-maxrate', maxrate,
      '-bufsize', bufsize,
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0'
    );
  } else {
    args.push('-c:v', 'copy');
  }

  if (camera.audioEnabled === false) {
    args.push('-an');
  } else {
    args.push(
      '-map', '0:a:0?',
      '-c:a', 'aac',
      '-ac', '1',
      '-ar', '48000',
      '-b:a', '64k'
    );
  }

  args.push(
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:8554/${camId}`
  );

  return args;
}

function stopPublisher(cameraId) {
  const entry = publishers.get(cameraId);
  if (!entry) return;

  entry.stopping = true;
  publishers.delete(cameraId);

  try {
    entry.process.kill('SIGTERM');
  } catch (err) {
    console.warn(`Failed to stop publisher for ${cameraId}:`, err.message || err);
  }

  setTimeout(() => {
    try {
      if (!entry.process.killed) entry.process.kill('SIGKILL');
    } catch (_) {}
  }, 5000);
}

function startPublisher(camera) {
  if (!isPublisherCameraEnabled(camera)) return;

  stopPublisher(camera.id);

  const args = buildPublisherArgs(camera);
  console.log(`Starting publisher for ${camera.id}: ffmpeg ${args.join(' ')}`);

  const ff = spawn('ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'pipe']
  });

  const entry = {
    cameraId: camera.id,
    cameraName: camera.name || camera.id,
    args,
    process: ff,
    startedAt: new Date().toISOString(),
    stopping: false,
    lastError: ''
  };

  publishers.set(camera.id, entry);

  ff.stderr.on('data', data => {
    const text = data.toString().trim();
    if (text) entry.lastError = text.slice(-2000);
  });

  ff.on('exit', (code, signal) => {
    const current = publishers.get(camera.id);
    if (current !== entry) return;

    publishers.delete(camera.id);

    console.warn(`Publisher for ${camera.id} exited: code=${code} signal=${signal}`);

    if (!entry.stopping) {
      setTimeout(() => {
        const latest = loadCameras().find(cam => cam.id === camera.id);
        if (isPublisherCameraEnabled(latest)) {
          startPublisher(latest);
        }
      }, 5000);
    }
  });
}

function restartPublisher(camera) {
  stopPublisher(camera.id);
  if (isPublisherCameraEnabled(camera)) {
    startPublisher(camera);
  }
}

function startAllEnabledPublishers() {
  const cameras = loadCameras();
  for (const camera of cameras) {
    if (isPublisherCameraEnabled(camera)) {
      startPublisher(camera);
    }
  }
}

function stopAllPublishers() {
  for (const cameraId of [...publishers.keys()]) {
    stopPublisher(cameraId);
  }
}

process.on('SIGINT', () => {
  stopAllPublishers();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopAllPublishers();
  process.exit(0);
});



function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const APP_VERSION = 'v1.3.0';
const GITHUB_VERSION_URL = 'https://github.com/ScottiBYTE/multiview-server/releases/tag/v1.3.0';
const DONATE_URL = 'https://www.paypal.com/paypalme/ScottiBYTE';

function renderPage(content, options = {}) {
  const hideNav = Boolean(options.hideNav);
  return `
<!doctype html>
<html>
<head>
  <title>ScottiBYTE MultiView Server</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>
    (function () {
      const saved = localStorage.getItem('multiview-theme') || 'dark';
      document.documentElement.setAttribute('data-theme', saved);
    })();
  </script>
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
      --header-bg: linear-gradient(90deg, #0f172a, #1e293b);
      --nav-bg: #0f172a;
      --nav-pill: #1e293b;
      --input-bg: #0f172a;
      --table-head-bg: #0f172a;
      --empty-bg: rgba(255,255,255,.02);
      --shadow: rgba(0,0,0,.28);
    }

    :root[data-theme="light"] {
      --bg: #f8fafc;
      --panel: #ffffff;
      --panel2: #f1f5f9;
      --border: #cbd5e1;
      --text: #0f172a;
      --muted: #475569;
      --accent: #2563eb;
      --good: #15803d;
      --bad: #b91c1c;
      --warn: #b45309;
      --header-bg: linear-gradient(90deg, #e0f2fe, #dbeafe);
      --nav-bg: #e2e8f0;
      --nav-pill: #ffffff;
      --input-bg: #ffffff;
      --table-head-bg: #e2e8f0;
      --empty-bg: rgba(15,23,42,.035);
      --shadow: rgba(15,23,42,.12);
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
      background: var(--header-bg);
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

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .header-actions a {
      color: var(--accent);
      text-decoration: none;
      font-weight: bold;
      white-space: nowrap;
    }

    .header-actions a:hover {
      text-decoration: underline;
    }

    .theme-toggle {
      border: 0;
      border-radius: 8px;
      padding: 8px 12px;
      background: #2563eb;
      color: white;
      font-weight: bold;
      cursor: pointer;
      white-space: nowrap;
    }

    :root[data-theme="light"] .theme-toggle {
      background: #2563eb;
      color: white;
    }

    nav {
      display: flex;
      gap: 10px;
      padding: 14px 32px;
      background: var(--nav-bg);
      border-bottom: 1px solid var(--border);
    }

    nav a {
      color: var(--text);
      text-decoration: none;
      background: var(--nav-pill);
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
      box-shadow: 0 10px 30px var(--shadow);
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
      background: var(--input-bg);
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
      background: var(--table-head-bg);
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .pill {
      display: inline-block;
      padding: 5px 9px;
      border-radius: 999px;
      background: var(--nav-pill);
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
      background: var(--empty-bg);
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
      background: var(--table-head-bg);
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

      .topbar {
        flex-direction: column;
      }

      .header-actions {
        justify-content: flex-start;
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
  

/* ScottiBYTE light theme contrast refinements */
:root[data-theme="light"] code {
  color: #1d4ed8;
  font-weight: 600;
}

:root[data-theme="light"] label {
  color: #334155;
}

:root[data-theme="light"] th {
  color: #334155;
  background: var(--table-head-bg);
}

:root[data-theme="light"] .camera-list-header {
  color: #334155;
  background: var(--table-head-bg);
  box-shadow: 0 2px 8px rgba(15,23,42,.14);
}

:root[data-theme="light"] .camera-list-header a {
  color: #334155;
  border-bottom-color: #64748b;
}

:root[data-theme="light"] .camera-list-header a:hover {
  color: #1d4ed8;
  border-bottom-color: #1d4ed8;
}

:root[data-theme="light"] .camera-list-header a::after {
  color: #64748b;
}

:root[data-theme="light"] .camera-list-header a:hover::after {
  color: #1d4ed8;
}

:root[data-theme="light"] .pill {
  color: #334155;
  background: #f8fafc;
  border-color: #94a3b8;
}

:root[data-theme="light"] .muted {
  color: #475569;
}

</style>
</head>
<body>
  <header>
    <div class="topbar">
      <div>
        <h1>ScottiBYTE MultiView Server</h1>
        <div class="subtitle">Self-hosted camera gateway for secure remote camera viewing.</div>
      </div>
      <div class="header-actions">
        <a href="${GITHUB_VERSION_URL}" target="_blank" rel="noopener noreferrer">GitHub ${APP_VERSION}</a>
        <a href="${DONATE_URL}" target="_blank" rel="noopener noreferrer">❤ Donate</a>
        <button class="theme-toggle" type="button" onclick="toggleTheme()">☀ Light</button>
      </div>
    </div>
  </header>

  ${hideNav ? '' : `
  <nav>
    <a href="/">Dashboard</a>
    <a href="/cameras">Cameras</a>
    <a href="/groups">Groups</a>
    <a href="/matrix">Matrix</a>
    <a href="/engine">Stream Engine</a>
    <a href="/tv-clients">Remote Clients</a>
    <a href="/api/health">API Health</a>
    <a href="/logout">Logout</a>
  </nav>
  `}

  <main>
    ${content}
  </main>
  <script>
    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('multiview-theme', theme);
      const button = document.querySelector('.theme-toggle');
      if (button) {
        button.textContent = theme === 'light' ? '🌙 Dark' : '☀ Light';
      }
    }


    function toggleRename(id) {
      const form = document.getElementById('rename-' + id);
      if (!form) return;
      form.style.display = form.style.display === 'none' ? 'flex' : 'none';
    }

    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      setTheme(current === 'light' ? 'dark' : 'light');
    }

    setTheme(localStorage.getItem('multiview-theme') || 'dark');
  </script>
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



app.get('/setup', (req, res) => {
  if (hasAdminUser()) {
    return res.redirect('/login');
  }

  res.send(renderPage(`
    <div class="card" style="max-width:640px;">
      <h2>Create Admin User</h2>
      <p class="muted">No admin account exists yet. Create the first administrator for ScottiBYTE MultiView Server.</p>

      <form method="post" action="/setup">
        <div style="margin-bottom:16px;">
          <label>Admin Username</label>
          <input name="username" value="scott" required autocomplete="username">
        </div>

        <div style="margin-bottom:16px;">
          <label>Password</label>
          <input name="password" type="password" required autocomplete="new-password">
        </div>

        <div style="margin-bottom:16px;">
          <label>Confirm Password</label>
          <input name="confirmPassword" type="password" required autocomplete="new-password">
        </div>

        <div class="form-actions">
          <button type="submit">Create Admin</button>
        </div>
      </form>
    </div>
  `, { hideNav: true }));
});

app.post('/setup', (req, res) => {
  if (hasAdminUser()) {
    return res.status(403).send(renderPage(`
      <div class="card">
        <h2>Setup Locked</h2>
        <p>An admin user already exists.</p>
        <p><a href="/login" style="color:#93c5fd;">Go to Login</a></p>
      </div>
    `, { hideNav: true }));
  }

  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || '');

  if (!username || password.length < 10) {
    return res.status(400).send(renderPage(`
      <div class="card">
        <h2>Invalid Setup</h2>
        <p>Username is required and password must be at least 10 characters.</p>
        <p><a href="/setup" style="color:#93c5fd;">Try again</a></p>
      </div>
    `, { hideNav: true }));
  }

  if (password !== confirmPassword) {
    return res.status(400).send(renderPage(`
      <div class="card">
        <h2>Passwords Do Not Match</h2>
        <p><a href="/setup" style="color:#93c5fd;">Try again</a></p>
      </div>
    `, { hideNav: true }));
  }

  const user = {
    username,
    role: 'admin',
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  saveUsers([user]);

  const token = createSession(user);
  setSessionCookie(res, token);

  res.redirect('/');
});

app.get('/login', (req, res) => {
  if (!hasAdminUser()) {
    return res.redirect('/setup');
  }

  const next = String(req.query.next || '/');

  res.send(renderPage(`
    <div class="card" style="max-width:520px;">
      <h2>Admin Login</h2>
      <p class="muted">Sign in to manage ScottiBYTE MultiView Server.</p>

      <form method="post" action="/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}">

        <div style="margin-bottom:16px;">
          <label>Username</label>
          <input name="username" required autocomplete="username">
        </div>

        <div style="margin-bottom:16px;">
          <label>Password</label>
          <input name="password" type="password" required autocomplete="current-password">
        </div>

        <div class="form-actions">
          <button type="submit">Login</button>
        </div>
      </form>
    </div>
  `, { hideNav: true }));
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const next = String(req.body.next || '/');

  const user = loadUsers().find(user => user.username === username && user.role === 'admin');

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).send(renderPage(`
      <div class="card" style="max-width:520px;">
        <h2>Login Failed</h2>
        <p>Invalid username or password.</p>
        <p><a href="/login" style="color:#93c5fd;">Try again</a></p>
      </div>
    `, { hideNav: true }));
  }

  const token = createSession(user);
  setSessionCookie(res, token);

  res.redirect(next.startsWith('/') ? next : '/');
});

app.get('/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.redirect('/login');
});


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
      <p>The server stores camera definitions, publishes RTSP cameras through MediaMTX, and provides web and remote clients with stable HLS stream URLs.</p>
      <ul>
        <li>Camera credentials stay server-side</li>
        <li>MediaMTX provides persistent HLS streams</li>
        <li>Web and remote clients receive safe stream URLs</li>
        <li>Remote access can be added externally through a reverse proxy or VPN</li>
      </ul>
    </div>
  `));
});




app.get('/tv-clients', (req, res) => {
  const pairingRequests = cleanupExpiredPairingRequests();
  const tvClients = loadTvClients().filter(client => !client.revokedAt);

  const pendingRows = pairingRequests
    .filter(request => !request.approvedAt && !request.deniedAt)
    .map(request => {
      return `
        <tr>
          <td><strong>${escapeHtml(request.name || 'Remote Client')}</strong><br><span class="muted">${escapeHtml(request.id)}</span></td>
          <td><code>${escapeHtml(formatPairingCode(request.pairingCode))}</code></td>
          <td>${escapeHtml(request.createdAt || '')}</td>
          <td>${escapeHtml(request.expiresAt || '')}</td>
          <td style="white-space:nowrap;">
            <form method="post" action="/api/tv/pairing/${encodeURIComponent(request.id)}/authorize" style="display:inline-block;margin-right:8px;">
              <button type="submit">Authorize</button>
            </form>
            <form method="post" action="/api/tv/pairing/${encodeURIComponent(request.id)}/delete" style="display:inline-block;">
              <button class="danger" type="submit">Delete</button>
            </form>
          </td>
        </tr>
      `;
    }).join('');

  const approvedWaitingRows = pairingRequests
    .filter(request => request.approvedAt && !request.deniedAt)
    .map(request => {
      return `
        <tr>
          <td><strong>${escapeHtml(request.name || 'Remote Client')}</strong><br><span class="muted">${escapeHtml(request.id)}</span></td>
          <td><code>${escapeHtml(formatPairingCode(request.pairingCode))}</code></td>
          <td>${escapeHtml(request.approvedAt || '')}</td>
          <td>${escapeHtml(request.expiresAt || '')}</td>
          <td style="white-space:nowrap;">
            <span class="pill" style="margin-right:8px;">Waiting for client</span>
            <form method="post" action="/api/tv/pairing/${encodeURIComponent(request.id)}/delete" style="display:inline-block;">
              <button class="danger" type="submit">Delete</button>
            </form>
          </td>
        </tr>
      `;
    }).join('');

  const clientRows = tvClients.map(client => {
    return `
      <tr>
        <td>
          <strong>${escapeHtml(client.displayName || client.name || 'Remote Client')}</strong>
          <div style="margin-top:6px;">
            <button type="button" onclick="toggleRename('${escapeHtml(client.id)}')">Rename</button>
          </div>
          <form id="rename-${escapeHtml(client.id)}" method="post" action="/api/tv/clients/${encodeURIComponent(client.id)}/rename" style="display:none;gap:8px;align-items:center;margin-top:6px;max-width:360px;">
            <div style="flex:1;">
              <label>Display Name</label>
              <input name="displayName" value="${escapeHtml(client.displayName || client.name || '')}" placeholder="Living Room TV">
            </div>
            <button type="submit">Save</button>
            <button type="button" onclick="toggleRename('${escapeHtml(client.id)}')">Cancel</button>
          </form>
        </td>
        <td>${escapeHtml(client.createdAt || '')}</td>
        <td>${client.lastSeenAt ? escapeHtml(client.lastSeenAt) : '<span class="muted">Never</span>'}</td>
        <td style="white-space:nowrap;">
          <form method="post" action="/api/tv/clients/${encodeURIComponent(client.id)}/revoke" style="display:inline-block;">
            <button class="danger" type="submit">Revoke</button>
          </form>
        </td>
      </tr>
    `;
  }).join('');

  res.send(renderPage(`
    <div class="card">
      <h2>Remote Clients</h2>
      <p class="muted">Authorize remote clients without giving them admin credentials. Remote clients receive read-only access to the camera catalog API.</p>
    </div>

    <div class="card">
      <h2>Authorize Client by Pairing Code</h2>
      <p class="muted">When a ScottiBYTE MultiView client starts for the first time, it displays a pairing code. Enter that code here to authorize the client.</p>

      <form method="post" action="/api/tv/pairing/authorize-code" style="display:flex;gap:10px;align-items:end;max-width:520px;">
        <div style="flex:1;">
          <label>Pairing Code</label>
          <input name="pairingCode" placeholder="483-927" required>
        </div>
        <button type="submit">Authorize</button>
      </form>
    </div>

    <div class="card">
      <h2>Pending Authorization</h2>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Pairing Code</th>
            <th>Requested</th>
            <th>Expires</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${pendingRows || '<tr><td colspan="5" class="muted">No pending remote clients.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Approved - Waiting for First Connection</h2>
      <p class="muted">These clients have been approved by an admin but have not yet picked up their device token.</p>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Pairing Code</th>
            <th>Approved</th>
            <th>Expires</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${approvedWaitingRows || '<tr><td colspan="5" class="muted">No approved clients waiting for token pickup.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Authorized Clients</h2>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Authorized</th>
            <th>Last Seen</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${clientRows || '<tr><td colspan="4" class="muted">No authorized remote clients.</td></tr>'}
        </tbody>
      </table>
    </div>
  `));
});

app.post('/api/tv/pairing/request', (req, res) => {
  if (!hasAdminUser()) {
    return res.status(503).json({
      ok: false,
      error: 'Server admin setup required before pairing Remote clients'
    });
  }

  const name = String(req.body.clientName || req.body.name || 'Remote Client').trim().slice(0, 80) || 'Remote Client';
  const pairingCode = generatePairingCode();
  const now = Date.now();

  const request = {
    id: `pair_${crypto.randomBytes(8).toString('hex')}`,
    name,
    pairingCode,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    approvedAt: null,
    deniedAt: null
  };

  const requests = cleanupExpiredPairingRequests();
  requests.push(request);
  savePairingRequests(requests);

  res.json({
    ok: true,
    pairingCode,
    displayCode: formatPairingCode(pairingCode),
    expiresAt: request.expiresAt
  });
});

app.get('/api/tv/pairing/status', (req, res) => {
  const pairingCode = String(req.query.pairingCode || '').replace(/\D/g, '');
  const requests = cleanupExpiredPairingRequests();
  const request = requests.find(request => request.pairingCode === pairingCode);

  if (!request) {
    return res.status(404).json({
      ok: false,
      authorized: false,
      error: 'Pairing request not found or expired'
    });
  }

  if (request.deniedAt) {
    return res.status(403).json({
      ok: false,
      authorized: false,
      denied: true,
      error: 'Pairing request denied'
    });
  }

  if (!request.approvedAt) {
    return res.json({
      ok: true,
      authorized: false,
      pending: true,
      expiresAt: request.expiresAt
    });
  }

  const token = generateTvClientToken();
  const client = {
    id: generateTvClientId(),
    name: request.name || 'Remote Client',
    tokenHash: hashPassword(token),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    pairingRequestId: request.id
  };

  const clients = loadTvClients();
  clients.push(client);
  saveTvClients(clients);

  savePairingRequests(requests.filter(item => item.id !== request.id));

  res.json({
    ok: true,
    authorized: true,
    clientId: client.id,
    clientName: client.name,
    token
  });
});

function authorizePairingRequestByCode(pairingCode) {
  const cleanCode = String(pairingCode || '').replace(/\D/g, '');
  const requests = cleanupExpiredPairingRequests();
  const request = requests.find(request => request.pairingCode === cleanCode && !request.deniedAt);

  if (!request) {
    return false;
  }

  request.approvedAt = new Date().toISOString();
  savePairingRequests(requests);
  return true;
}

app.post('/api/tv/pairing/authorize-code', (req, res) => {
  const ok = authorizePairingRequestByCode(req.body.pairingCode);

  if (!ok) {
    return res.status(404).send(renderPage(`
      <div class="card">
        <h2>Pairing Code Not Found</h2>
        <p>The pairing code was not found, expired, or already used.</p>
        <p><a href="/tv-clients" style="color:#93c5fd;">Return to Remote Clients</a></p>
      </div>
    `));
  }

  res.redirect('/tv-clients');
});

app.post('/api/tv/pairing/:id/authorize', (req, res) => {
  const requests = cleanupExpiredPairingRequests();
  const request = requests.find(request => request.id === req.params.id && !request.deniedAt);

  if (request) {
    request.approvedAt = new Date().toISOString();
    savePairingRequests(requests);
  }

  res.redirect('/tv-clients');
});

app.post('/api/tv/pairing/:id/deny', (req, res) => {
  const requests = cleanupExpiredPairingRequests();
  const request = requests.find(request => request.id === req.params.id);

  if (request) {
    request.deniedAt = new Date().toISOString();
    savePairingRequests(requests);
  }

  res.redirect('/tv-clients');
});


app.post('/api/tv/pairing/:id/delete', (req, res) => {
  const id = String(req.params.id || '');
  const requests = loadPairingRequests();
  const next = requests.filter(request => request.id !== id);
  savePairingRequests(next);
  res.redirect('/tv-clients');
});

app.post('/api/tv/clients/:id/rename', (req, res) => {
  const id = String(req.params.id || '');
  const displayName = String(req.body.displayName || '').trim().slice(0, 80);
  const clients = loadTvClients();
  const client = clients.find(client => client.id === id);

  if (client) {
    client.displayName = displayName || client.name || 'Remote Client';
    client.updatedAt = new Date().toISOString();
    saveTvClients(clients);
  }

  res.redirect('/tv-clients');
});

app.post('/api/tv/clients/:id/revoke', (req, res) => {
  const clients = loadTvClients();
  const client = clients.find(client => client.id === req.params.id);

  if (client) {
    client.revokedAt = new Date().toISOString();
    saveTvClients(clients);
  }

  res.redirect('/tv-clients');
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
      <p class="muted">Groups are admin metadata used to organize cameras. The Android Remote client may use these for filtering, but user-created viewing layouts belong in the Android app.</p>

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
        <a href="/cameras" style="color:#93c5fd;">Back to Cameras</a>
        <a href="/matrix" style="color:#93c5fd;">Matrix</a>
        <a href="/engine" style="color:#93c5fd;">Stream Engine</a>
      </div>

      <p class="muted">HLS URL: <code>${escapeHtml(hlsUrl)}</code></p>
    </div>

    <div id="streamStatus" class="muted" style="margin-top:12px;">Opening MediaMTX HLS stream...</div>

    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <script>
      const video = document.getElementById('video');
      const hlsUrl = ${JSON.stringify(hlsUrl)};
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
          statusEl.textContent = 'MediaMTX stream is available, but the browser player did not start. Refresh the page or check Stream Engine.';
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
  restartPublisher(camera);
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
      version: '1.0.0',
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
      defaultSort: 'name',
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
    version: '1.0.0',
    publicUrl: PUBLIC_URL,
    auth: {
      adminUserExists: hasAdminUser(),
      loginRequired: hasAdminUser()
    },
    tvClients: {
      authorizedCount: loadTvClients().filter(client => !client.revokedAt).length,
      pendingCount: cleanupExpiredPairingRequests().filter(request => !request.approvedAt && !request.deniedAt).length
    },
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

  const camera = {
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
  };

  cameras.push(camera);

  saveCameras(cameras);
  restartPublisher(camera);
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
  stopPublisher(req.params.id);
  res.redirect('/cameras');
});

ensureDataFiles();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ScottiBYTE MultiView Server listening on port ${PORT}`);

  setTimeout(() => {
    console.log('Starting enabled camera publishers...');
    startAllEnabledPublishers();
  }, 3000);
});
