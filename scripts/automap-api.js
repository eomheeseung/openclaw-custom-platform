#!/usr/bin/env node
// OpenClaw API server
// POST /automap - Discord automap
// POST /sync - Sync agents
// GET /oauth/google - Start Google OAuth2
// GET /oauth/google/callback - OAuth2 callback
// GET /auth/me - Check current auth
// POST /auth/logout - Logout
// GET /api/admin/users - List all user slots
// POST /api/admin/users/assign - Assign email to slot
// POST /api/admin/users/remove - Remove user from slot
// GET /api/admin/containers - Container status
// GET /api/admin/containers/stats - Resource usage
// POST /api/admin/containers/restart - Restart container
// GET /api/admin/agents/:slot - Agent list for user
// GET /api/admin/config - System config overview
// POST /api/mail/send - Send email via Gmail API (tideflo.com)
// GET /api/mail/search - Search emails via Gmail API
// GET /api/mail/read - Read email thread via Gmail API
// GET /api/drive/list - List files/folders in Google Drive
// GET /api/drive/search - Search files in Google Drive
// GET /api/drive/read - Read file content from Google Drive
// GET /api/drive/shared - List shared drives
// POST /api/integrations/save - Save integration tokens (Dooray, GitHub)
// GET /api/integrations/load - Load integration tokens
// GET /api/dooray/projects - List Dooray projects
// GET /api/dooray/tasks - List/search tasks in a project
// GET /api/dooray/task - Get task detail

const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = 18799;
const AUTOMAP_SCRIPT = path.join(__dirname, 'discord-automap.sh');
const SYNC_SCRIPT = path.join(__dirname, 'sync-agents.sh');

// Container IP → userNN mapping (refreshed periodically)
let containerIpMap = {}; // { '172.18.0.6': '01', ... }
function refreshContainerIpMap() {
  try {
    const result = require('child_process').execSync(
      'docker inspect $(docker ps -q --filter "name=openclaw-user") --format="{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}} {{.Name}}"',
      { timeout: 5000 }
    ).toString().trim();
    const newMap = {};
    result.split('\n').forEach(line => {
      const parts = line.trim().split(' ');
      if (parts.length === 2) {
        const ip = parts[0];
        const match = parts[1].match(/user(\d+)/);
        if (match) newMap[ip] = match[1];
      }
    });
    containerIpMap = newMap;
    console.log('[ip-map] refreshed:', Object.keys(newMap).length, 'containers');
  } catch (err) {
    console.error('[ip-map] refresh failed:', err.message);
  }
}
refreshContainerIpMap();
setInterval(refreshContainerIpMap, 60000); // refresh every 60s

// ── rhwp helper ──────────────────────────────────────────────────────────────
const RHWP_HELPER = path.join(__dirname, 'rhwp-helper.mjs');

function hwpProcess(op, fileBase64, extra = {}) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ op, fileBase64, ...extra });
    const child = require('child_process').spawn('node', [RHWP_HELPER], { timeout: 60000 });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code) => {
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error(`rhwp-helper 파싱 실패 (code ${code}): ${err || out}`)); }
    });
    child.on('error', reject);
    child.stdin.write(input);
    child.stdin.end();
  });
}

// SVG 내보내기 저장 폴더 — 1시간 TTL 정리
const SVG_EXPORT_BASE = '/opt/openclaw/data';
function cleanupOldSvgExports() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    const users = fs.readdirSync(SVG_EXPORT_BASE).filter(d => d.startsWith('user'));
    for (const user of users) {
      const dir = path.join(SVG_EXPORT_BASE, user, 'workspace', 'hwp-exports');
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        const fp = path.join(dir, file);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch {}
      }
    }
  } catch {}
}
cleanupOldSvgExports();
setInterval(cleanupOldSvgExports, 60 * 60 * 1000);

// Resolve actual userNN from request IP (override whatever bot sends)
function resolveUserNN(req, paramUserNN) {
  const remoteIp = req.socket.remoteAddress?.replace('::ffff:', '') || '';
  const mappedNN = containerIpMap[remoteIp];
  if (mappedNN) {
    if (paramUserNN && paramUserNN !== mappedNN) {
      console.log(`[ip-map] override: userNN=${paramUserNN} → ${mappedNN} (ip=${remoteIp})`);
    }
    return mappedNN;
  }
  // Not from container (admin UI, direct call) — trust the parameter
  return paramUserNN;
}
const USERS_FILE = '/opt/openclaw/auth/users.json';
const ACTIVITY_FILE = '/opt/openclaw/auth/activity.json';
const TOKENS_DIR = '/opt/openclaw/auth/tokens';

// Google OAuth2 config
const GOOGLE_CLIENT_ID = '981747784874-vb0ckq8f8abmihqbcagi2ri5384eeoqf.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = 'http://claw.tideflo.work/oauth/google/callback';
const ALLOWED_DOMAIN = 'tideflo.com';

// Session store
const sessions = new Map();

// --- Helpers ---

function validateUserNN(userNN) {
  return /^(0[1-9]|1[0-5])$/.test(userNN);
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}

// 직원 이름 → 이메일 매핑
const MEMBER_MAP = {
  '엄희승': 'je_aime_she@tideflo.com',
  '손재민': 'zozohjk951@tideflo.com',
  '이찬양': 'paprikas@tideflo.com',
  '강석준': 'kangsj@tideflo.com',
  '김선혜': 'seonek@tideflo.com',
  '김예림': 'lynnekim@tideflo.com',
  '서완덕': 'blueleaf@tideflo.com',
  '정의원': 'ewj606@tideflo.com',
  '송정석': '0213hello@tideflo.com',
  '이준성': 'kimlsy2444@tideflo.com',
  '김진호': 'jhjkim92@tideflo.com',
  '이호원': 'howonhe@tideflo.com',
  '김다영': 'da0ab@tideflo.com',
  '차명건': 'blueyooe@tideflo.com',
  '황인영': '0930dlsdud@tideflo.com',
};

function resolveEmail(nameOrEmail) {
  if (!nameOrEmail) return nameOrEmail;
  // 쉼표로 구분된 여러 수신자 처리
  return nameOrEmail.split(',').map(s => {
    const trimmed = s.trim();
    // 이미 이메일이면 그대로
    if (trimmed.includes('@')) return trimmed;
    // 이름이면 매핑에서 찾기
    return MEMBER_MAP[trimmed] || trimmed;
  }).join(',');
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadActivity() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); }
  catch { return {}; }
}

function saveActivity(data) {
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2));
}

function recordLogin(email) {
  const activity = loadActivity();
  if (!activity[email]) activity[email] = { loginCount: 0 };
  activity[email].lastLogin = Date.now();
  activity[email].loginCount = (activity[email].loginCount || 0) + 1;
  saveActivity(activity);
}

function recordActivity(email) {
  const activity = loadActivity();
  if (!activity[email]) activity[email] = { loginCount: 0 };
  activity[email].lastActivity = Date.now();
  saveActivity(activity);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        // Auto-resolve userNN from container IP
        if (parsed.userNN) {
          parsed.userNN = resolveUserNN(req, parsed.userNN);
        }
        resolve(parsed);
      }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const parts = c.trim().split('=');
    const k = parts[0];
    const v = parts.slice(1).join('='); // value에 = 포함될 수 있음
    if (k) cookies[k.trim()] = decodeURIComponent(v || '');
  });
  return cookies;
}

function getAuthSession(req) {
  const cookies = parseCookies(req);
  const session = sessions.get(cookies.session);
  if (session && session.email?.endsWith(`@${ALLOWED_DOMAIN}`)) return session;
  // Cookie fallback — user_email 또는 gateway_token에서 유저 확인
  const email = cookies.user_email;
  if (email?.endsWith(`@${ALLOWED_DOMAIN}`)) {
    return { email, name: cookies.user_name || email, userNN: cookies.user_nn };
  }
  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function httpPost(url, params) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams(params).toString();
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function findNextAvailableSlot(users) {
  const taken = new Set(Object.values(users));
  for (let i = 1; i <= 15; i++) {
    const nn = String(i).padStart(2, '0');
    if (!taken.has(nn)) return nn;
  }
  return null;
}

function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// --- Gmail API Helpers ---

function loadGoogleToken(userNN) {
  const tokenFile = path.join(TOKENS_DIR, `${userNN}.json`);
  try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')); }
  catch { return null; }
}

function saveGoogleToken(userNN, tokenData) {
  const tokenFile = path.join(TOKENS_DIR, `${userNN}.json`);
  fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));
}

async function getValidAccessToken(userNN) {
  const token = loadGoogleToken(userNN);
  if (!token) throw new Error(`No token for user${userNN}`);
  // Check if token is still valid (5 min buffer)
  if (token.expires_at && token.expires_at > Date.now() + 300000) {
    return token.access_token;
  }
  if (!token.refresh_token) throw new Error(`No refresh token for user${userNN}`);
  // Refresh
  const refreshData = await httpPost('https://oauth2.googleapis.com/token', {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  const newTokens = JSON.parse(refreshData);
  if (!newTokens.access_token) throw new Error('Token refresh failed');
  token.access_token = newTokens.access_token;
  token.expires_at = Date.now() + (newTokens.expires_in || 3600) * 1000;
  saveGoogleToken(userNN, token);
  console.log(`[mail] token refreshed for user${userNN}`);
  return token.access_token;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function doorayApiRequest(method, apiUrl, doorayToken, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(apiUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Authorization': `dooray-api ${doorayToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function gmailApiRequest(method, url, accessToken, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function getWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=일 1=월 ... 6=토
  const diffMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setDate(mon.getDate() + diffMon);
  const fri = new Date(mon);
  fri.setDate(fri.getDate() + 4);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { monday: fmt(mon), friday: fmt(fri), today: fmt(now) };
}

function buildRawEmail({ from, to, cc, subject, body, bodyHtml }) {
  const boundary = 'boundary_' + crypto.randomBytes(16).toString('hex');
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
  ];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body || '').toString('base64'),
  );
  if (bodyHtml) {
    lines.push(
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(bodyHtml).toString('base64'),
    );
  }
  lines.push(`--${boundary}--`);
  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // --- OAuth2: Start ---
  if (req.method === 'GET' && url.pathname === '/oauth/google') {
    // Encode return path in state (admin or user)
    const referer = req.headers.referer || '';
    const returnTo = referer.includes('/admin') ? '/admin' : '/';
    const stateData = JSON.stringify({ nonce: crypto.randomBytes(16).toString('hex'), returnTo });
    const state = Buffer.from(stateData).toString('base64url');
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${GOOGLE_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent('openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive')}` +
      `&state=${state}` +
      `&access_type=offline` +
      `&prompt=select_account`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // --- OAuth2: Callback ---
  if (req.method === 'GET' && url.pathname === '/oauth/google/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>\uc778\uc99d \uc2e4\ud328</h2><p>\ucf54\ub4dc\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.</p><a href="/">\ub3cc\uc544\uac00\uae30</a>');
      return;
    }

    try {
      const tokenData = await httpPost('https://oauth2.googleapis.com/token', {
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
      });
      const tokens = JSON.parse(tokenData);
      if (!tokens.access_token) throw new Error('No access token');

      const userInfoData = await httpGet(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokens.access_token}`);
      const userInfo = JSON.parse(userInfoData);
      const email = userInfo.email?.toLowerCase();
      const name = userInfo.name || email;

      if (!email) throw new Error('No email');
      if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>접근 거부</h2><p>${email}은(는) @${ALLOWED_DOMAIN} 도메인이 아닙니다.</p><a href="/">돌아가기</a>`);
        return;
      }

      const users = loadUsers();
      let userNN = users[email];
      if (!userNN) {
        userNN = findNextAvailableSlot(users);
        if (!userNN) {
          res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>사용자 슬롯 부족</h2><p>모든 슬롯(01~14)이 할당되어 있습니다.</p><a href="/">돌아가기</a>');
          return;
        }
        users[email] = userNN;
        saveUsers(users);
        console.log(`[auth] new user: ${email} -> user${userNN}`);
      }

      // Save Google tokens per user (for Gmail/Calendar/Drive access)
      const googleTokens = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        scope: tokens.scope || '',
      };
      const tokensDir = '/opt/openclaw/auth/tokens';
      if (!fs.existsSync(tokensDir)) fs.mkdirSync(tokensDir, { recursive: true });
      // Merge with existing (keep refresh_token if not returned this time)
      const tokenFile = `${tokensDir}/${userNN}.json`;
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch {}
      if (!googleTokens.refresh_token && existing.refresh_token) {
        googleTokens.refresh_token = existing.refresh_token;
      }
      fs.writeFileSync(tokenFile, JSON.stringify({ ...googleTokens, email }, null, 2));
      console.log(`[auth] google tokens saved for user${userNN} (refresh=${!!googleTokens.refresh_token})`);

      const sessionId = crypto.randomBytes(32).toString('hex');
      sessions.set(sessionId, { email, name, userNN, createdAt: Date.now() });
      recordLogin(email);

      const token = `tc-user${userNN}`;
      console.log(`[auth] login: ${email} -> user${userNN}`);

      // Determine redirect: admin or user workspace
      let returnTo = '/';
      try {
        const stateParam = url.searchParams.get('state') || '';
        const stateData = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
        if (stateData.returnTo === '/admin') returnTo = '/admin';
      } catch { /* ignore */ }
      const redirectUrl = returnTo === '/admin' ? '/admin' : `/?token=${token}`;

      res.writeHead(302, {
        Location: redirectUrl,
        'Set-Cookie': [
          `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400`,
          `user_email=${encodeURIComponent(email)}; Path=/; Max-Age=86400`,
          `user_name=${encodeURIComponent(name)}; Path=/; Max-Age=86400`,
          `user_nn=${userNN}; Path=/; Max-Age=86400`,
          `gateway_token=${token}; Path=/; Max-Age=86400`,
        ].join(', '),
      });
      res.end();
    } catch (err) {
      console.error('[auth] callback error:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>인증 오류</h2><p>${err.message}</p><a href="/">돌아가기</a>`);
    }
    return;
  }

  // --- Auth: Check session ---
  if (req.method === 'GET' && url.pathname === '/auth/me') {
    const cookies = parseCookies(req);
    const session = sessions.get(cookies.session);
    if (session) {
      recordActivity(session.email);
      jsonRes(res, 200, { ok: true, email: session.email, name: session.name, userNN: session.userNN, token: `tc-user${session.userNN}`, isAdmin: true });
    } else if (cookies.gateway_token) {
      jsonRes(res, 200, { ok: true, token: cookies.gateway_token, email: cookies.user_email, name: cookies.user_name, userNN: cookies.user_nn, isAdmin: true });
    } else {
      jsonRes(res, 401, { ok: false });
    }
    return;
  }

  // --- Auth: Logout ---
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    const cookies = parseCookies(req);
    sessions.delete(cookies.session);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': [
        'session=; Path=/; Max-Age=0', 'user_email=; Path=/; Max-Age=0',
        'user_name=; Path=/; Max-Age=0', 'user_nn=; Path=/; Max-Age=0',
        'gateway_token=; Path=/; Max-Age=0',
      ].join(', '),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ===== Admin API =====

  // GET /api/admin/users
  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }

    const users = loadUsers();
    const activity = loadActivity();
    const slotToEmail = {};
    for (const [email, nn] of Object.entries(users)) slotToEmail[nn] = email;

    const sessionCounts = {};
    for (const [, sess] of sessions) {
      sessionCounts[sess.email] = (sessionCounts[sess.email] || 0) + 1;
    }

    const slots = [];
    for (let i = 1; i <= 15; i++) {
      const nn = String(i).padStart(2, '0');
      const email = slotToEmail[nn] || null;
      slots.push({
        slot: nn, email,
        activeSessions: email ? (sessionCounts[email] || 0) : 0,
        lastLogin: email ? activity[email]?.lastLogin || null : null,
        lastActivity: email ? activity[email]?.lastActivity || null : null,
        loginCount: email ? activity[email]?.loginCount || 0 : 0,
      });
    }
    jsonRes(res, 200, { ok: true, slots });
    return;
  }

  // POST /api/admin/users/assign
  if (req.method === 'POST' && url.pathname === '/api/admin/users/assign') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const params = await parseBody(req);
    const { email, slot } = params;
    if (!email || !slot || !validateUserNN(slot)) {
      jsonRes(res, 400, { ok: false, error: 'Invalid email or slot' }); return;
    }
    const users = loadUsers();
    const existing = Object.entries(users).find(([, nn]) => nn === slot);
    if (existing && existing[0] !== email.toLowerCase()) {
      jsonRes(res, 409, { ok: false, error: `Slot ${slot} already assigned to ${existing[0]}` }); return;
    }
    users[email.toLowerCase()] = slot;
    saveUsers(users);
    console.log(`[admin] assign: ${email} -> slot ${slot}`);
    jsonRes(res, 200, { ok: true });
    return;
  }

  // POST /api/admin/users/remove
  if (req.method === 'POST' && url.pathname === '/api/admin/users/remove') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const params = await parseBody(req);
    const { email } = params;
    const users = loadUsers();
    if (!users[email?.toLowerCase()]) {
      jsonRes(res, 404, { ok: false, error: 'User not found' }); return;
    }
    delete users[email.toLowerCase()];
    saveUsers(users);
    console.log(`[admin] remove: ${email}`);
    jsonRes(res, 200, { ok: true });
    return;
  }

  // GET /api/admin/containers
  if (req.method === 'GET' && url.pathname === '/api/admin/containers') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    execFile('docker', ['ps', '-a', '--filter', 'name=openclaw-user',
      '--format', '{{.Names}}\t{{.Status}}\t{{.State}}'], { timeout: 10000 },
    (err, stdout) => {
      if (err) { jsonRes(res, 500, { ok: false, error: err.message }); return; }
      const containers = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [name, status, state] = line.split('\t');
        const match = name.match(/user(\d+)/);
        return { slot: match?.[1] || '', name, status, state };
      });
      jsonRes(res, 200, { ok: true, containers });
    });
    return;
  }

  // GET /api/admin/containers/stats
  if (req.method === 'GET' && url.pathname === '/api/admin/containers/stats') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    execFile('docker', ['stats', '--no-stream', '--filter', 'name=openclaw-user',
      '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'], { timeout: 15000 },
    (err, stdout) => {
      if (err) { jsonRes(res, 500, { ok: false, error: err.message }); return; }
      const stats = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [name, cpu, mem, memPerc] = line.split('\t');
        const match = name.match(/user(\d+)/);
        return { slot: match?.[1] || '', name, cpu, mem, memPerc };
      });
      jsonRes(res, 200, { ok: true, stats });
    });
    return;
  }

  // POST /api/vnc/status — port 6080 listening + chrome alive?
  if (req.method === 'POST' && url.pathname === '/api/vnc/status') {
    const params = await parseBody(req);
    const { userNN } = params;
    if (!validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    const cmd = 'VNC=0; CHR=0; ' +
      'netstat -tlnp 2>/dev/null | grep -q ":6080 " && VNC=1; ' +
      'ps -eo pid,stat,comm | grep -v "Z" | grep -q "chrome" && CHR=1; ' +
      'echo "vnc=$VNC chrome=$CHR"';
    execFile('docker', ['exec', `openclaw-user${userNN}`, 'bash', '-c', cmd],
      { timeout: 10000 }, (err, stdout) => {
        if (err) { jsonRes(res, 500, { ok: false, error: err.message }); return; }
        const out = String(stdout || '');
        const running = /vnc=1/.test(out);
        const chrome = /chrome=1/.test(out);
        jsonRes(res, 200, { ok: true, running, chrome });
      });
    return;
  }

  // POST /api/vnc/start — start Xvfb+x11vnc+websockify (+ Chrome) in target container
  if (req.method === 'POST' && url.pathname === '/api/vnc/start') {
    const params = await parseBody(req);
    const { userNN } = params;
    if (!validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    // 1단계: VNC 프로세스 (포트 점유 여부로 판정, 좀비 제외)
    //        좀비 chrome/Xvfb 먼저 정리
    const vncCmd = 'ZOMBIES=$(ps -eo pid,stat,comm | awk \'$2~/^Z/ && ($3~/chrome/||$3~/Xvfb/||$3~/x11vnc/||$3~/websockify/) {print $1}\' | head -20); ' +
      '[ -n "$ZOMBIES" ] && kill -9 $ZOMBIES 2>/dev/null; sleep 0.3; ' +
      'netstat -tlnp 2>/dev/null | grep -q ":6080 " && { echo ALREADY; exit 0; }; ' +
      'setsid Xvfb :99 -screen 0 1280x720x24 </dev/null >/dev/null 2>&1 & disown; sleep 1; ' +
      'setsid x11vnc -display :99 -nopw -forever -shared -rfbport 5900 </dev/null >/dev/null 2>&1 & disown; sleep 1; ' +
      'setsid websockify --web /usr/share/novnc 6080 localhost:5900 </dev/null >/dev/null 2>&1 & disown; sleep 1; ' +
      'for i in 1 2 3 4 5; do netstat -tlnp 2>/dev/null | grep -q ":6080 " && { echo STARTED; exit 0; }; sleep 0.5; done; echo TIMEOUT';
    // 2단계: Chrome은 node 유저로 (프로필 권한 맞춤)
    //        좀비 chrome 정리 + CDP 포트 18800 LISTEN 될 때까지 폴링
    const chromeCmd = 'ZOMBIES=$(ps -eo pid,stat,comm | awk \'$2~/^Z/ && $3~/chrome/ {print $1}\' | head -20); ' +
      '[ -n "$ZOMBIES" ] && kill -9 $ZOMBIES 2>/dev/null; sleep 0.3; ' +
      'ps -eo stat,comm | grep -v "Z" | grep -q "chrome" && netstat -tlnp 2>/dev/null | grep -q ":18800 " && { echo CHROME_ALREADY; exit 0; }; ' +
      'DISPLAY=:99 DBUS_SESSION_BUS_ADDRESS=/dev/null setsid google-chrome ' +
      '--user-data-dir=/home/node/.openclaw/browser/openclaw/user-data ' +
      '--no-sandbox --no-first-run --no-default-browser-check ' +
      '--disable-session-crashed-bubble --disable-infobars ' +
      '--disable-dev-shm-usage --disable-gpu --disable-software-rasterizer ' +
      '--disable-extensions --disable-plugins --disable-crash-reporter --disable-breakpad ' +
      '--disable-features=VizDisplayCompositor,Translate ' +
      '--remote-debugging-port=18800 --remote-debugging-address=127.0.0.1 ' +
      'https://www.google.com </dev/null >/dev/null 2>&1 & disown; sleep 1; ' +
      'for i in 1 2 3 4 5 6 7 8 9 10; do netstat -tlnp 2>/dev/null | grep -q ":18800 " && { echo CHROME_STARTED; exit 0; }; sleep 0.5; done; echo CHROME_TIMEOUT';
    execFile('docker', ['exec', '-u', 'root', `openclaw-user${userNN}`, 'bash', '-c', vncCmd],
      { timeout: 20000 }, (err1, stdout1) => {
        if (err1) { jsonRes(res, 500, { ok: false, error: 'VNC: ' + err1.message }); return; }
        const vncOut = String(stdout1 || '').trim();
        if (vncOut === 'TIMEOUT') { jsonRes(res, 500, { ok: false, error: 'VNC: websockify did not start (timeout)', vnc: vncOut }); return; }
        execFile('docker', ['exec', '-u', 'node', `openclaw-user${userNN}`, 'bash', '-c', chromeCmd],
          { timeout: 20000 }, (err2, stdout2) => {
            if (err2) { jsonRes(res, 500, { ok: false, error: 'Chrome: ' + err2.message, vnc: vncOut }); return; }
            const chromeOut = String(stdout2 || '').trim();
            if (chromeOut === 'CHROME_TIMEOUT') { jsonRes(res, 500, { ok: false, error: 'Chrome: CDP port 18800 did not listen within 5s', vnc: vncOut, chrome: chromeOut }); return; }
            jsonRes(res, 200, { ok: true, vnc: vncOut, chrome: chromeOut });
          });
      });
    return;
  }

  // --- bid.tideflo.work helpers (docker exec로 컨테이너 내부 /opt/scripts/bid-fetch.js 실행) ---
  async function runBidFetch(userNN, args, timeoutMs = 180000) {
    return new Promise((resolve) => {
      execFile('docker', ['exec', `openclaw-user${userNN}`, 'node', '/opt/scripts/bid-fetch.js', ...args],
        { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
          if (err && !stdout) { resolve({ ok: false, error: err.message }); return; }
          try { resolve(JSON.parse(stdout.toString().trim())); }
          catch { resolve({ ok: false, error: 'parse fail', raw: stdout.toString().slice(0, 500) }); }
        });
    });
  }
  function resolveBidUserNN(params) {
    const nn = params?.userNN;
    if (nn && validateUserNN(nn)) return nn;
    return null;
  }

  // GET/POST /api/bid/list?userNN=01&status=assigned
  if (url.pathname === '/api/bid/list' && (req.method === 'GET' || req.method === 'POST')) {
    const params = req.method === 'POST' ? (await parseBody(req)) : Object.fromEntries(url.searchParams);
    const userNN = resolveBidUserNN(params);
    if (!userNN) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    const status = params.status || '';
    const r = await runBidFetch(userNN, ['list', status]);
    jsonRes(res, r.ok ? 200 : 500, r);
    return;
  }

  // GET/POST /api/bid/detail?userNN=01&bidRowId=3331
  if (url.pathname === '/api/bid/detail' && (req.method === 'GET' || req.method === 'POST')) {
    const params = req.method === 'POST' ? (await parseBody(req)) : Object.fromEntries(url.searchParams);
    const userNN = resolveBidUserNN(params);
    if (!userNN) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    if (!params.bidRowId) { jsonRes(res, 400, { ok: false, error: 'bidRowId required' }); return; }
    const r = await runBidFetch(userNN, ['detail', String(params.bidRowId)]);
    jsonRes(res, r.ok ? 200 : 500, r);
    return;
  }

  // GET/POST /api/bid/document?userNN=01&docId=8858
  if (url.pathname === '/api/bid/document' && (req.method === 'GET' || req.method === 'POST')) {
    const params = req.method === 'POST' ? (await parseBody(req)) : Object.fromEntries(url.searchParams);
    const userNN = resolveBidUserNN(params);
    if (!userNN) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    if (!params.docId) { jsonRes(res, 400, { ok: false, error: 'docId required' }); return; }
    const r = await runBidFetch(userNN, ['document', String(params.docId)]);
    jsonRes(res, r.ok ? 200 : 500, r);
    return;
  }

  // GET/POST /api/bid/assigned?userNN=01 — 종합 조회
  if (url.pathname === '/api/bid/assigned' && (req.method === 'GET' || req.method === 'POST')) {
    const params = req.method === 'POST' ? (await parseBody(req)) : Object.fromEntries(url.searchParams);
    const userNN = resolveBidUserNN(params);
    if (!userNN) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    const r = await runBidFetch(userNN, ['assigned']);
    jsonRes(res, r.ok ? 200 : 500, r);
    return;
  }

  // POST /api/bid/queue-summarize — 큐 기반 병렬 요약 (kimi 직접 호출, 동시 3개)
  if (url.pathname === '/api/bid/queue-summarize' && req.method === 'POST') {
    const params = await parseBody(req);
    const userNN = resolveBidUserNN(params);
    if (!userNN) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    const detail = params.detail === 'deep' || params.detail === 'detailed' ? params.detail : 'normal';
    const concurrency = String(parseInt(params.concurrency || 3, 10) || 3);
    const r = await runBidFetch(userNN, ['queue_summarize', detail, concurrency], 600000);
    jsonRes(res, r.ok ? 200 : 500, r);
    return;
  }

  // POST /api/vnc/restart-chrome — kill & relaunch Chrome only (VNC stays)
  if (req.method === 'POST' && url.pathname === '/api/vnc/restart-chrome') {
    const params = await parseBody(req);
    const { userNN } = params;
    if (!validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    // pkill -f 가 자기 자신 shell을 매치하므로 PID 직접 찾아서 kill
    const killCmd = 'PIDS=$(ps -eo pid,comm,args | awk \'$2~/^chrome/ && $0~/user-data-dir=\\/home\\/node\\/.openclaw/ {print $1}\'); ' +
      '[ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null; ' +
      'sleep 0.5; echo KILLED; exit 0';
    const launchCmd = 'DISPLAY=:99 DBUS_SESSION_BUS_ADDRESS=/dev/null setsid google-chrome ' +
      '--user-data-dir=/home/node/.openclaw/browser/openclaw/user-data ' +
      '--no-sandbox --no-first-run --no-default-browser-check ' +
      '--disable-session-crashed-bubble --disable-infobars ' +
      '--disable-dev-shm-usage --disable-gpu --disable-software-rasterizer ' +
      '--disable-extensions --disable-plugins --disable-crash-reporter --disable-breakpad ' +
      '--disable-features=VizDisplayCompositor,Translate ' +
      '--remote-debugging-port=18800 --remote-debugging-address=127.0.0.1 ' +
      'https://www.google.com </dev/null >/dev/null 2>&1 & disown; sleep 1; ' +
      'for i in 1 2 3 4 5 6 7 8 9 10; do netstat -tlnp 2>/dev/null | grep -q ":18800 " && { echo CHROME_STARTED; exit 0; }; sleep 0.5; done; echo CHROME_TIMEOUT';
    execFile('docker', ['exec', '-u', 'root', `openclaw-user${userNN}`, 'bash', '-c', killCmd],
      { timeout: 10000 }, (err1) => {
        if (err1) { jsonRes(res, 500, { ok: false, error: 'kill failed: ' + err1.message }); return; }
        execFile('docker', ['exec', '-u', 'node', `openclaw-user${userNN}`, 'bash', '-c', launchCmd],
          { timeout: 20000 }, (err2, stdout2) => {
            if (err2) { jsonRes(res, 500, { ok: false, error: 'launch failed: ' + err2.message }); return; }
            const out = String(stdout2 || '').trim();
            if (out === 'CHROME_TIMEOUT') { jsonRes(res, 500, { ok: false, error: 'Chrome CDP timeout', chrome: out }); return; }
            jsonRes(res, 200, { ok: true, chrome: out });
          });
      });
    return;
  }

  // POST /api/admin/containers/restart
  if (req.method === 'POST' && url.pathname === '/api/admin/containers/restart') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const params = await parseBody(req);
    const { slot } = params;
    if (!validateUserNN(slot)) { jsonRes(res, 400, { ok: false, error: 'Invalid slot' }); return; }
    console.log(`[admin] restart: openclaw-user${slot}`);
    execFile('docker', ['restart', `openclaw-user${slot}`], { timeout: 60000 }, (err) => {
      if (err) { jsonRes(res, 500, { ok: false, error: err.message }); return; }
      jsonRes(res, 200, { ok: true });
    });
    return;
  }

  // GET /api/admin/agents/:slot
  const agentsMatch = url.pathname.match(/^\/api\/admin\/agents\/(\d{2})$/);
  if (req.method === 'GET' && agentsMatch) {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const slot = agentsMatch[1];
    if (!validateUserNN(slot)) { jsonRes(res, 400, { ok: false, error: 'Invalid slot' }); return; }
    const configPath = `/opt/openclaw/data/user${slot}/openclaw.json`;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const agentList = (config.agents?.list || []).map(a => ({
        id: a.id, name: a.identity?.name || a.name || a.id,
        emoji: a.identity?.emoji || '', default: !!a.default,
        isDiscord: a.id.endsWith('-discord'),
      }));
      const model = config.agents?.defaults?.model?.primary || 'unknown';
      const discordAccounts = Object.keys(config.channels?.discord?.accounts || {});
      jsonRes(res, 200, { ok: true, agents: agentList, model, discordAccounts });
    } catch {
      jsonRes(res, 200, { ok: true, agents: [], model: 'unconfigured', discordAccounts: [] });
    }
    return;
  }

  // GET /api/admin/config
  if (req.method === 'GET' && url.pathname === '/api/admin/config') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    jsonRes(res, 200, {
      ok: true,
      apiKeys: {
        openai: !!process.env.OPENAI_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        moonshot: !!process.env.MOONSHOT_API_KEY,
      },
      totalSlots: 15,
      usersAssigned: Object.keys(loadUsers()).length,
      activeSessions: sessions.size,
    });
    return;
  }

  // ===== Mail API =====

  // POST /api/mail/send
  if (req.method === 'POST' && url.pathname === '/api/mail/send') {
    try {
      const params = await parseBody(req);
      const { userNN, to, cc, subject, body, bodyHtml } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!to || !subject) { jsonRes(res, 400, { ok: false, error: 'Missing to or subject' }); return; }

      // 이름 → 이메일 자동 변환
      const resolvedTo = resolveEmail(to);
      const resolvedCc = cc ? resolveEmail(cc) : cc;

      const token = loadGoogleToken(userNN);
      if (!token?.email) { jsonRes(res, 400, { ok: false, error: `No email configured for user${userNN}` }); return; }
      const from = token.email;

      // 주간보고 제목이면 날짜를 서버가 강제 교체
      let fixedSubject = subject;
      if (subject.includes('주간보고')) {
        const week = getWeekRange();
        const correctRange = `${week.monday}~${week.friday}`;
        // [주간보고][날짜~날짜] 패턴을 올바른 날짜로 교체
        fixedSubject = fixedSubject.replace(/\[주간보고\]\[[^\]]*\]/, `[주간보고][${correctRange}]`);
        // 패턴이 없으면 추가
        if (!fixedSubject.includes(`[${correctRange}]`)) {
          fixedSubject = `[주간보고][${correctRange}]` + fixedSubject.replace(/\[주간보고\]/, '');
        }
      }

      // 본문에서도 잘못된 기간을 교체
      let fixedBody = body || '';
      if (subject.includes('주간보고') && fixedBody.includes('기간')) {
        const week = getWeekRange();
        const correctRange = `${week.monday}~${week.friday}`;
        // 기간(날짜~날짜) 패턴 교체
        fixedBody = fixedBody.replace(/기간\([^)]*\)/, `기간(${correctRange})`);
        // 기간: 날짜 ~ 날짜 패턴 교체
        fixedBody = fixedBody.replace(/기간[:\s]*\d{4}[-년]\s*\d{1,2}[-월]\s*\d{1,2}[일]?\s*~\s*\d{4}[-년]\s*\d{1,2}[-월]\s*\d{1,2}[일]?/, `기간: ${week.monday} ~ ${week.friday}`);
        fixedBody = fixedBody.replace(/기간[:\s]*\d{1,2}월\s*\d{1,2}일\s*~\s*\d{1,2}월\s*\d{1,2}일/, `기간: ${week.monday} ~ ${week.friday}`);
      }

      const accessToken = await getValidAccessToken(userNN);
      const raw = buildRawEmail({ from, to: resolvedTo, cc: resolvedCc, subject: fixedSubject, body: fixedBody, bodyHtml });
      const result = await gmailApiRequest('POST',
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        accessToken, { raw });

      if (result.status >= 400) {
        console.error(`[mail] send failed for user${userNN}:`, result.data);
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Send failed' });
        return;
      }
      console.log(`[mail] sent from ${from} to ${resolvedTo} cc=${resolvedCc || ''} subject="${subject}"`);
      const week = getWeekRange();
      jsonRes(res, 200, { ok: true, messageId: result.data.id, threadId: result.data.threadId, from, weekRange: `${week.monday}~${week.friday}`, today: week.today });
    } catch (err) {
      console.error('[mail] send error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/mail/search?userNN=01&q=from:me&max=10
  if (req.method === 'GET' && url.pathname === '/api/mail/search') {
    try {
      const userNN = url.searchParams.get('userNN');
      const query = url.searchParams.get('q') || '';
      const maxResults = parseInt(url.searchParams.get('max') || '10', 10);
      const pageToken = url.searchParams.get('page') || '';
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      let apiUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
      if (pageToken) apiUrl += `&pageToken=${encodeURIComponent(pageToken)}`;

      const listResult = await gmailApiRequest('GET', apiUrl, accessToken);
      if (listResult.status >= 400) {
        jsonRes(res, listResult.status, { ok: false, error: listResult.data?.error?.message || 'Search failed' }); return;
      }

      const messages = listResult.data.messages || [];
      // Fetch headers for each message
      const details = await Promise.all(messages.slice(0, maxResults).map(async (msg) => {
        const detail = await gmailApiRequest('GET',
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          accessToken);
        if (detail.status >= 400) return { id: msg.id, error: 'fetch failed' };
        const headers = {};
        (detail.data.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });
        return {
          id: msg.id,
          threadId: detail.data.threadId,
          from: headers.from || '',
          to: headers.to || '',
          subject: headers.subject || '',
          date: headers.date || '',
          snippet: detail.data.snippet || '',
          labels: (detail.data.labelIds || []).join(','),
        };
      }));

      const token = loadGoogleToken(userNN);
      const week = getWeekRange();
      jsonRes(res, 200, {
        ok: true, account: token?.email || '', messages: details,
        nextPageToken: listResult.data.nextPageToken || null,
        resultSizeEstimate: listResult.data.resultSizeEstimate || 0,
        weekRange: `${week.monday}~${week.friday}`, today: week.today,
      });
    } catch (err) {
      console.error('[mail] search error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/mail/read?userNN=01&id=<messageId>
  if (req.method === 'GET' && url.pathname === '/api/mail/read') {
    try {
      const userNN = url.searchParams.get('userNN');
      const messageId = url.searchParams.get('id');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!messageId) { jsonRes(res, 400, { ok: false, error: 'Missing id' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const result = await gmailApiRequest('GET',
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
        accessToken);
      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Read failed' }); return;
      }

      const headers = {};
      (result.data.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });

      // Extract body + attachments
      let textBody = '', htmlBody = '';
      const attachments = [];
      function extractParts(payload) {
        if (payload.body?.data) {
          const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf8');
          if (payload.mimeType === 'text/plain') textBody = decoded;
          if (payload.mimeType === 'text/html') htmlBody = decoded;
        }
        if (payload.filename && payload.filename.length > 0) {
          attachments.push({
            filename: payload.filename,
            mimeType: payload.mimeType || '',
            size: payload.body?.size || 0,
            attachmentId: payload.body?.attachmentId || '',
          });
        }
        if (payload.parts) payload.parts.forEach(extractParts);
      }
      extractParts(result.data.payload);

      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, {
        ok: true, account: token?.email || '',
        id: result.data.id, threadId: result.data.threadId,
        from: headers.from || '', to: headers.to || '',
        cc: headers.cc || '', subject: headers.subject || '',
        date: headers.date || '', snippet: result.data.snippet || '',
        labels: (result.data.labelIds || []).join(','),
        body: textBody, bodyHtml: htmlBody,
        attachments,
      });
    } catch (err) {
      console.error('[mail] read error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ===== Drive API =====

  // GET /api/drive/shared - List shared drives
  if (req.method === 'GET' && url.pathname === '/api/drive/shared') {
    try {
      const userNN = url.searchParams.get('userNN');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const result = await gmailApiRequest('GET',
        'https://www.googleapis.com/drive/v3/drives?pageSize=100',
        accessToken);
      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Failed' }); return;
      }
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, { ok: true, account: token?.email || '', drives: result.data.drives || [] });
    } catch (err) {
      console.error('[drive] shared error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/drive/list?userNN=01&folderId=root&max=20
  if (req.method === 'GET' && url.pathname === '/api/drive/list') {
    try {
      const userNN = url.searchParams.get('userNN');
      const folderId = url.searchParams.get('folderId') || 'root';
      const maxResults = parseInt(url.searchParams.get('max') || '30', 10);
      const pageToken = url.searchParams.get('page') || '';
      const driveId = url.searchParams.get('driveId') || '';
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const q = `'${folderId}' in parents and trashed = false`;
      let apiUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${maxResults}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,owners,shared,lastModifyingUser)&orderBy=folder,name`;
      if (driveId) {
        apiUrl += `&driveId=${encodeURIComponent(driveId)}&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=drive`;
      } else {
        apiUrl += '&includeItemsFromAllDrives=true&supportsAllDrives=true';
      }
      if (pageToken) apiUrl += `&pageToken=${encodeURIComponent(pageToken)}`;

      const result = await gmailApiRequest('GET', apiUrl, accessToken);
      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'List failed' }); return;
      }
      const files = (result.data.files || []).map(f => ({
        id: f.id, name: f.name, type: f.mimeType,
        isFolder: f.mimeType === 'application/vnd.google-apps.folder',
        size: f.size || null, modified: f.modifiedTime || null, modifiedBy: f.lastModifyingUser?.displayName || f.lastModifyingUser?.emailAddress || null,
        shared: f.shared || false,
      }));
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, {
        ok: true, account: token?.email || '', folderId, files,
        nextPageToken: result.data.nextPageToken || null,
      });
    } catch (err) {
      console.error('[drive] list error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/drive/search?userNN=01&q=검색어&max=30
  if (req.method === 'GET' && url.pathname === '/api/drive/search') {
    try {
      const userNN = url.searchParams.get('userNN');
      const query = url.searchParams.get('q') || '';
      const maxResults = parseInt(url.searchParams.get('max') || '30', 10);
      const pageToken = url.searchParams.get('page') || '';
      const type = url.searchParams.get('type') || ''; // folder, doc, sheet, etc
      const shared = url.searchParams.get('shared') || ''; // 'true' for sharedWithMe
      const after = url.searchParams.get('after') || ''; // 날짜 필터: 2026-03-30
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      let qParts = ['trashed = false'];
      if (shared === 'true') qParts.push('sharedWithMe = true');
      if (query) qParts.push(`(fullText contains '${query.replace(/'/g, "\\'")}' or name contains '${query.replace(/'/g, "\\'")}')`);
      if (after) qParts.push(`modifiedTime > '${after}T00:00:00'`);

      if (type === 'folder') qParts.push("mimeType = 'application/vnd.google-apps.folder'");
      else if (type === 'doc') qParts.push("mimeType = 'application/vnd.google-apps.document'");
      else if (type === 'sheet') qParts.push("mimeType = 'application/vnd.google-apps.spreadsheet'");
      else if (type === 'slide') qParts.push("mimeType = 'application/vnd.google-apps.presentation'");
      else if (type === 'pdf') qParts.push("mimeType = 'application/pdf'");
      const q = qParts.join(' and ');

      // 항상 allDrives로 검색 (공유 드라이브 하위 폴더 포함)
      let apiUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${maxResults}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,shared,lastModifyingUser)&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives&orderBy=modifiedTime desc`;
      if (pageToken) apiUrl += `&pageToken=${encodeURIComponent(pageToken)}`;

      const result = await gmailApiRequest('GET', apiUrl, accessToken);
      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Search failed' }); return;
      }
      const files = (result.data.files || []).map(f => ({
        id: f.id, name: f.name, type: f.mimeType,
        isFolder: f.mimeType === 'application/vnd.google-apps.folder',
        size: f.size || null, modified: f.modifiedTime || null, modifiedBy: f.lastModifyingUser?.displayName || f.lastModifyingUser?.emailAddress || null,
        parents: f.parents || [], shared: f.shared || false,
      }));
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, {
        ok: true, account: token?.email || '', query, files,
        nextPageToken: result.data.nextPageToken || null,
      });
    } catch (err) {
      console.error('[drive] search error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/drive/advanced-search
  // Body: { userNN, modifiedAfter, modifiedBefore, modifiedByName, modifiedByEmail,
  //         nameContains, fullTextContains, mimeType, driveId, includeFolders,
  //         pageSize(100), maxPages(10) }
  if (req.method === 'POST' && url.pathname === '/api/drive/advanced-search') {
    try {
      const body = await parseBody(req);
      const {
        userNN,
        modifiedAfter, modifiedBefore,
        modifiedByName, modifiedByEmail,
        nameContains, fullTextContains,
        mimeType, driveId,
        includeFolders = false,
        pageSize = 100, maxPages = 10,
      } = body || {};
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const esc = s => String(s).replace(/'/g, "\\'");

      const qParts = ['trashed = false'];
      if (modifiedAfter)  qParts.push(`modifiedTime > '${esc(modifiedAfter)}T00:00:00'`);
      if (modifiedBefore) qParts.push(`modifiedTime < '${esc(modifiedBefore)}T23:59:59'`);
      if (nameContains)     qParts.push(`name contains '${esc(nameContains)}'`);
      if (fullTextContains) qParts.push(`fullText contains '${esc(fullTextContains)}'`);
      if (mimeType) qParts.push(`mimeType = '${esc(mimeType)}'`);
      if (!includeFolders) qParts.push("mimeType != 'application/vnd.google-apps.folder'");
      const q = qParts.join(' and ');

      // corpora / driveId
      const corporaParams = driveId
        ? `corpora=drive&driveId=${encodeURIComponent(driveId)}`
        : 'corpora=allDrives';

      const nameLower = modifiedByName ? String(modifiedByName).toLowerCase() : null;
      const emailLower = modifiedByEmail ? String(modifiedByEmail).toLowerCase() : null;

      const cappedPageSize = Math.max(1, Math.min(1000, parseInt(pageSize, 10) || 100));
      const cappedMaxPages = Math.max(1, Math.min(50, parseInt(maxPages, 10) || 10));

      let pageToken = '';
      let totalFetched = 0;
      const collected = [];
      let stoppedReason = 'end';

      for (let page = 0; page < cappedMaxPages; page++) {
        const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,webViewLink,driveId,lastModifyingUser)';
        let apiUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${cappedPageSize}&fields=${encodeURIComponent(fields)}&includeItemsFromAllDrives=true&supportsAllDrives=true&${corporaParams}&orderBy=modifiedTime desc`;
        if (pageToken) apiUrl += `&pageToken=${encodeURIComponent(pageToken)}`;

        const result = await gmailApiRequest('GET', apiUrl, accessToken);
        if (result.status >= 400) {
          jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Search failed', page, totalFetched });
          return;
        }
        const files = result.data.files || [];
        totalFetched += files.length;

        for (const f of files) {
          const mb = f.lastModifyingUser || {};
          if (nameLower && (mb.displayName || '').toLowerCase() !== nameLower) continue;
          if (emailLower && (mb.emailAddress || '').toLowerCase() !== emailLower) continue;
          collected.push({
            id: f.id, name: f.name, mimeType: f.mimeType,
            size: f.size || null, modifiedTime: f.modifiedTime || null,
            modifiedBy: { name: mb.displayName || null, email: mb.emailAddress || null },
            parents: f.parents || [], driveId: f.driveId || null,
            webViewLink: f.webViewLink || null,
          });
        }

        pageToken = result.data.nextPageToken || '';
        if (!pageToken) { stoppedReason = 'end'; break; }
        if (page + 1 >= cappedMaxPages) { stoppedReason = 'maxPages'; break; }
      }

      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, {
        ok: true, account: token?.email || '',
        query: q, corpora: driveId ? `drive:${driveId}` : 'allDrives',
        files: collected,
        totalFetched, matched: collected.length,
        stoppedReason,
        nextPageToken: pageToken || null,
      });
    } catch (err) {
      console.error('[drive] advanced-search error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/g2b/history
  // Body: { agency(=dminsttNm), agencyCode(=dminsttCd), businessType("용역"|"물품"|"공사"|"외자"),
  //         yearsBack(=3), fromDate(YYYY-MM-DD), toDate(YYYY-MM-DD),
  //         ntceInsttNm, ntceInsttCd, bidNtceNm, indstrytyNm,
  //         pageSize(100), maxPages(20) }
  if (req.method === 'POST' && url.pathname === '/api/g2b/history') {
    try {
      const body = await parseBody(req) || {};
      const {
        agency, agencyCode,
        businessType = '용역',
        yearsBack = 3, fromDate, toDate,
        ntceInsttNm, ntceInsttCd, bidNtceNm, indstrytyNm,
        pageSize = 100, maxPages = 20,
      } = body;

      const G2B_KEY = process.env.G2B_SERVICE_KEY || '';
      if (!G2B_KEY) { jsonRes(res, 500, { ok: false, error: 'G2B_SERVICE_KEY not configured' }); return; }

      // 업무 분야 → 메서드 (개찰결과 PPS검색이 사전 필터 + 낙찰자 정보 풍부)
      const methodMap = {
        '물품': 'getOpengResultListInfoThngPPSSrch',
        '공사': 'getOpengResultListInfoCnstwkPPSSrch',
        '용역': 'getOpengResultListInfoServcPPSSrch',
        '외자': 'getOpengResultListInfoFrgcptPPSSrch',
      };
      const method = methodMap[businessType];
      if (!method) {
        jsonRes(res, 400, { ok: false, error: `Invalid businessType: ${businessType}. Use one of: ${Object.keys(methodMap).join(', ')}` });
        return;
      }

      // 기간 계산 (Date 객체)
      let from, to;
      if (fromDate && toDate) {
        from = new Date(fromDate + 'T00:00:00');
        to   = new Date(toDate   + 'T23:59:59');
      } else {
        const now = new Date();
        const curYear = now.getFullYear();
        from = new Date(`${curYear - yearsBack}-01-01T00:00:00`);
        to   = new Date(`${curYear - 1}-12-31T23:59:59`);
      }

      // 1개월씩 청크 분할
      const chunks = [];
      let cur = new Date(from.getTime());
      while (cur < to) {
        const chunkEnd = new Date(cur.getTime());
        chunkEnd.setMonth(chunkEnd.getMonth() + 1);
        chunkEnd.setDate(chunkEnd.getDate() - 1);
        chunkEnd.setHours(23, 59, 59);
        const e = chunkEnd > to ? to : chunkEnd;
        const fmt = d => d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
        chunks.push({ bgn: fmt(cur), end: fmt(e) });
        cur = new Date(e.getTime());
        cur.setSeconds(cur.getSeconds() + 1);
      }

      const baseUrl = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService/' + method;
      const cappedPageSize = Math.max(1, Math.min(999, parseInt(pageSize, 10) || 100));
      const cappedMaxPagesPerChunk = Math.max(1, Math.min(50, parseInt(maxPages, 10) || 20));

      const collected = [];
      let totalApiCalls = 0;
      let totalFetched = 0;
      let stoppedReason = 'end';

      chunkLoop:
      for (const chunk of chunks) {
        for (let page = 1; page <= cappedMaxPagesPerChunk; page++) {
          const params = new URLSearchParams({
            serviceKey: G2B_KEY,
            pageNo: String(page),
            numOfRows: String(cappedPageSize),
            type: 'json',
            inqryDiv: '1', // 등록일시 기준
            inqryBgnDt: chunk.bgn,
            inqryEndDt: chunk.end,
          });
          if (agency)       params.set('dminsttNm', agency);
          if (agencyCode)   params.set('dminsttCd', agencyCode);
          if (ntceInsttNm)  params.set('ntceInsttNm', ntceInsttNm);
          if (ntceInsttCd)  params.set('ntceInsttCd', ntceInsttCd);
          if (bidNtceNm)    params.set('bidNtceNm', bidNtceNm);
          if (indstrytyNm)  params.set('indstrytyNm', indstrytyNm);

          const reqUrl = baseUrl + '?' + params.toString();
          totalApiCalls++;
          const apiRes = await new Promise((resolve, reject) => {
            https.get(reqUrl, r => {
              let data = '';
              r.on('data', c => { data += c; });
              r.on('end', () => resolve({ status: r.statusCode, body: data }));
            }).on('error', reject);
          });

          if (apiRes.status !== 200) {
            jsonRes(res, apiRes.status, { ok: false, error: `G2B API HTTP ${apiRes.status}`, body: apiRes.body.slice(0, 300), chunk, page });
            return;
          }
          let parsed;
          try { parsed = JSON.parse(apiRes.body); } catch {
            jsonRes(res, 502, { ok: false, error: 'G2B API non-JSON', body: apiRes.body.slice(0, 300), chunk, page });
            return;
          }

          const respBody = parsed?.response?.body;
          if (!respBody) {
            // 에러 응답일 수 있음
            const errHdr = parsed?.['nkoneps.com.response.ResponseError']?.header;
            jsonRes(res, 502, { ok: false, error: errHdr ? `G2B: ${errHdr.resultMsg}` : 'Unexpected response', body: apiRes.body.slice(0, 300), chunk });
            return;
          }
          const items = respBody.items || [];
          totalFetched += items.length;
          for (const it of items) {
            // opengCorpInfo: "회사명^사업자번호^대표자^낙찰금액^?"
            const corpInfo = (it.opengCorpInfo || '').split('^');
            collected.push({
              bidNtceNo: it.bidNtceNo,
              bidNtceNm: it.bidNtceNm,
              opengDt: it.opengDt || it.opengDate,
              dminsttCd: it.dminsttCd,
              dminsttNm: it.dminsttNm || it.dmndInsttNm,
              ntceInsttNm: it.ntceInsttNm,
              prtcptCnum: it.prtcptCnum,
              progrsDivCdNm: it.progrsDivCdNm,
              winnerName: corpInfo[0] || null,
              winnerBizno: corpInfo[1] || null,
              winnerCeo: corpInfo[2] || null,
              winnerAmt: corpInfo[3] || null,
            });
          }
          if (items.length < cappedPageSize) break; // 이 청크 완료
          if (page >= cappedMaxPagesPerChunk) { stoppedReason = 'maxPagesPerChunk'; break chunkLoop; }
        }
      }

      jsonRes(res, 200, {
        ok: true,
        method, businessType,
        period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        filters: { agency, agencyCode, ntceInsttNm, ntceInsttCd, bidNtceNm, indstrytyNm },
        chunks: chunks.length,
        totalApiCalls,
        totalFetched,
        items: collected,
        stoppedReason,
      });
    } catch (err) {
      console.error('[g2b] history error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/drive/read?userNN=01&fileId=xxx
  if (req.method === 'GET' && url.pathname === '/api/drive/read') {
    try {
      const userNN = url.searchParams.get('userNN');
      const fileId = url.searchParams.get('fileId');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!fileId) { jsonRes(res, 400, { ok: false, error: 'Missing fileId' }); return; }

      const accessToken = await getValidAccessToken(userNN);

      // First get file metadata
      const meta = await gmailApiRequest('GET',
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,modifiedTime,owners,shared&supportsAllDrives=true`,
        accessToken);
      if (meta.status >= 400) {
        jsonRes(res, meta.status, { ok: false, error: meta.data?.error?.message || 'Metadata failed' }); return;
      }

      const mimeType = meta.data.mimeType;
      let content = null;

      // Google Docs/Sheets/Slides → export as text
      if (mimeType === 'application/vnd.google-apps.document') {
        const exp = await gmailApiRequest('GET',
          `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
          accessToken);
        content = typeof exp.data === 'string' ? exp.data : JSON.stringify(exp.data);
      } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        const exp = await gmailApiRequest('GET',
          `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`,
          accessToken);
        content = typeof exp.data === 'string' ? exp.data : JSON.stringify(exp.data);
      } else if (mimeType === 'application/vnd.google-apps.presentation') {
        const exp = await gmailApiRequest('GET',
          `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
          accessToken);
        content = typeof exp.data === 'string' ? exp.data : JSON.stringify(exp.data);
      } else if (mimeType === 'application/vnd.google-apps.folder') {
        // Folder → list contents
        const listResult = await gmailApiRequest('GET',
          `https://www.googleapis.com/drive/v3/files?q='${fileId}'+in+parents+and+trashed+=+false&pageSize=50&fields=files(id,name,mimeType,size,modifiedTime,lastModifyingUser)&includeItemsFromAllDrives=true&supportsAllDrives=true&orderBy=folder,name`,
          accessToken);
        content = (listResult.data?.files || []).map(f => ({
          id: f.id, name: f.name, type: f.mimeType,
          isFolder: f.mimeType === 'application/vnd.google-apps.folder',
          size: f.size || null, modified: f.modifiedTime || null, modifiedBy: f.lastModifyingUser?.displayName || f.lastModifyingUser?.emailAddress || null,
        }));
        jsonRes(res, 200, { ok: true, file: meta.data, contentType: 'folder_listing', content });
        return;
      } else {
        const sizeNum = parseInt(meta.data.size || '0', 10);
        if (mimeType?.startsWith('text/') || mimeType === 'application/json' || mimeType === 'text/csv') {
          // Text files — download directly
          const dl = await new Promise((resolve, reject) => {
            https.get(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
              headers: { 'Authorization': `Bearer ${accessToken}` },
            }, (dlRes) => {
              let data = '';
              dlRes.on('data', chunk => { data += chunk; });
              dlRes.on('end', () => resolve(data));
            }).on('error', reject);
          });
          content = dl;
        } else {
          // Binary files (PDF, DOCX, XLSX, PPTX, etc.) — copy as Google Docs, export text, delete copy
          const convertible = ['application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint',
            'application/rtf', 'text/rtf',
            'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
            'application/vnd.oasis.opendocument.presentation'];
          const spreadsheetTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
            'application/vnd.oasis.opendocument.spreadsheet'];

          // HWP/HWPX → download + rhwp
          const hwpTypes = ['application/x-hwp', 'application/haansofthwp', 'application/vnd.hancom.hwp',
            'application/vnd.hancom.hwpx', 'application/octet-stream'];
          const ext = (meta.data.name || '').split('.').pop()?.toLowerCase() || '';
          if (['hwp', 'hwpx'].includes(ext) || (hwpTypes.includes(mimeType) && !convertible.includes(mimeType))) {
            if (sizeNum > 50 * 1048576) {
              content = `[파일 크기 ${(sizeNum / 1048576).toFixed(1)}MB — HWP 최대 50MB까지 지원]`;
            } else {
              const tmpPath = `/tmp/drive_hwp_${fileId}_${Date.now()}.${ext}`;
              try {
                await new Promise((resolve, reject) => {
                  const child = require('child_process').spawn('curl', [
                    '-s', '-L', '-o', tmpPath,
                    '-H', `Authorization: Bearer ${accessToken}`,
                    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
                  ], { timeout: 60000 });
                  child.on('close', (code) => { if (code !== 0) reject(new Error(`다운로드 실패 (exit ${code})`)); else resolve(); });
                  child.on('error', reject);
                });
                const fileBase64 = fs.readFileSync(tmpPath).toString('base64');
                const hwpResult = await hwpProcess('parse', fileBase64);
                content = hwpResult.ok ? hwpResult.text : `[HWP 변환 실패: ${hwpResult.error}]`;
              } finally {
                try { fs.unlinkSync(tmpPath); } catch {}
              }
            }
          } else if (!convertible.includes(mimeType)) {
            content = `[지원하지 않는 파일 형식: ${mimeType}, ${(sizeNum / 1024).toFixed(1)}KB]`;
          } else {
            // Determine target Google type
            const targetMime = spreadsheetTypes.includes(mimeType)
              ? 'application/vnd.google-apps.spreadsheet'
              : 'application/vnd.google-apps.document';
            const exportMime = spreadsheetTypes.includes(mimeType) ? 'text/csv' : 'text/plain';

            let copyId = null;
            try {
              // Copy file as Google Docs/Sheets (triggers conversion)
              const copyResult = await gmailApiRequest('POST',
                `https://www.googleapis.com/drive/v3/files/${fileId}/copy?supportsAllDrives=true`,
                accessToken,
                { name: `_tmp_convert_${Date.now()}`, mimeType: targetMime });

              if (copyResult.status >= 400) {
                content = `[변환 실패: ${copyResult.data?.error?.message || 'copy failed'}]`;
              } else {
                copyId = copyResult.data.id;
                // Export as text/csv
                const exp = await gmailApiRequest('GET',
                  `https://www.googleapis.com/drive/v3/files/${copyId}/export?mimeType=${encodeURIComponent(exportMime)}`,
                  accessToken);
                content = typeof exp.data === 'string' ? exp.data : JSON.stringify(exp.data);
              }
            } finally {
              // Delete temporary copy
              if (copyId) {
                try {
                  await gmailApiRequest('DELETE',
                    `https://www.googleapis.com/drive/v3/files/${copyId}?supportsAllDrives=true`,
                    accessToken);
                } catch {}
              }
            }
          }
        }
      }

      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, { ok: true, account: token?.email || '', file: meta.data, content });
    } catch (err) {
      console.error('[drive] read error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ===== Calendar API =====

  // GET /api/calendar/list?userNN=01&days=7
  if (req.method === 'GET' && url.pathname === '/api/calendar/list') {
    try {
      const userNN = url.searchParams.get('userNN');
      const days = parseInt(url.searchParams.get('days') || '7', 10);
      const q = url.searchParams.get('q') || '';
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const now = new Date();
      const timeMin = now.toISOString();
      const future = new Date(now.getTime() + days * 86400000);
      const timeMax = future.toISOString();

      let apiUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=50`;
      if (q) apiUrl += `&q=${encodeURIComponent(q)}`;

      const result = await gmailApiRequest('GET', apiUrl, accessToken);
      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Calendar failed' }); return;
      }
      const events = (result.data.items || []).map(e => ({
        id: e.id,
        title: e.summary || '(제목 없음)',
        start: e.start?.dateTime || e.start?.date || '',
        end: e.end?.dateTime || e.end?.date || '',
        location: e.location || '',
        description: e.description || '',
        allDay: !!e.start?.date,
        status: e.status || '',
        organizer: e.organizer?.email || '',
        attendees: (e.attendees || []).map(a => a.email),
      }));
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, { ok: true, account: token?.email || '', days, eventCount: events.length, events });
    } catch (err) {
      console.error('[calendar] list error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/calendar/today?userNN=01
  if (req.method === 'GET' && url.pathname === '/api/calendar/today') {
    try {
      const userNN = url.searchParams.get('userNN');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayEnd = new Date(todayStart.getTime() + 86400000);

      const apiUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(todayStart.toISOString())}&timeMax=${encodeURIComponent(todayEnd.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=50`;

      const result = await gmailApiRequest('GET', apiUrl, accessToken);
      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Calendar failed' }); return;
      }
      const events = (result.data.items || []).map(e => ({
        id: e.id,
        title: e.summary || '(제목 없음)',
        start: e.start?.dateTime || e.start?.date || '',
        end: e.end?.dateTime || e.end?.date || '',
        location: e.location || '',
        description: e.description || '',
        allDay: !!e.start?.date,
      }));
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, { ok: true, account: token?.email || '', date: todayStart.toISOString().slice(0, 10), eventCount: events.length, events });
    } catch (err) {
      console.error('[calendar] today error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/calendar/add
  if (req.method === 'POST' && url.pathname === '/api/calendar/add') {
    try {
      const params = await parseBody(req);
      const { userNN, title, start, end, location, description, attendees } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!title || !start) { jsonRes(res, 400, { ok: false, error: 'Missing title or start' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const event = {
        summary: title,
        location: location || '',
        description: description || '',
        start: start.length === 10 ? { date: start } : { dateTime: start, timeZone: 'Asia/Seoul' },
        end: end ? (end.length === 10 ? { date: end } : { dateTime: end, timeZone: 'Asia/Seoul' }) : (start.length === 10 ? { date: start } : { dateTime: new Date(new Date(start).getTime() + 3600000).toISOString(), timeZone: 'Asia/Seoul' }),
      };
      if (attendees && attendees.length > 0) {
        event.attendees = attendees.map(e => ({ email: e }));
      }

      const result = await gmailApiRequest('POST',
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        accessToken, event);
      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Create failed' }); return;
      }
      console.log(`[calendar] event created: ${title} at ${start}`);
      jsonRes(res, 200, { ok: true, event: { id: result.data.id, title: result.data.summary, start: result.data.start, end: result.data.end, link: result.data.htmlLink } });
    } catch (err) {
      console.error('[calendar] add error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // DELETE /api/calendar/delete?userNN=01&eventId=xxx
  if (req.method === 'GET' && url.pathname === '/api/calendar/delete') {
    try {
      const userNN = url.searchParams.get('userNN');
      const eventId = url.searchParams.get('eventId');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!eventId) { jsonRes(res, 400, { ok: false, error: 'Missing eventId' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const result = await gmailApiRequest('DELETE',
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        accessToken);

      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Delete failed' }); return;
      }
      console.log(`[calendar] event deleted: ${eventId}`);
      jsonRes(res, 200, { ok: true, deletedEventId: eventId });
    } catch (err) {
      console.error('[calendar] delete error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ===== File Upload & Read API =====

  // POST /api/file/upload — Upload file, extract text, return content
  if (req.method === 'POST' && url.pathname === '/api/file/upload') {
    try {
      const params = await parseBody(req);
      const { userNN, fileName, mimeType, content } = params; // content = base64
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!content || !fileName) { jsonRes(res, 400, { ok: false, error: 'Missing fileName or content' }); return; }

      const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
      const fileBuffer = Buffer.from(content, 'base64');
      const tmpPath = `/tmp/upload_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
      fs.writeFileSync(tmpPath, fileBuffer);

      let textContent = null;
      const sizeNum = fileBuffer.length;

      try {
        if (sizeNum > 20 * 1048576) {
          textContent = `[파일 크기 ${(sizeNum / 1048576).toFixed(1)}MB — 너무 커서 처리할 수 없습니다 (최대 20MB)]`;
        } else if (['txt', 'csv', 'json', 'xml', 'md'].includes(ext)) {
          textContent = fileBuffer.toString('utf8');
        } else if (ext === 'pdf') {
          // PDF → Google Docs 변환 → 텍스트 추출 → 삭제
          const accessToken = await getValidAccessToken(userNN);
          // Upload PDF to Drive
          const boundary = 'upload_' + Date.now();
          const metadata = JSON.stringify({ name: `_tmp_upload_${Date.now()}`, mimeType: 'application/vnd.google-apps.document' });
          const multipartBody = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
            fileBuffer,
            Buffer.from(`\r\n--${boundary}--`),
          ]);
          const uploadResult = await new Promise((resolve, reject) => {
            const uploadReq = https.request({
              hostname: 'www.googleapis.com',
              path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': multipartBody.length,
              },
            }, (uploadRes) => {
              let data = '';
              uploadRes.on('data', chunk => { data += chunk; });
              uploadRes.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
            });
            uploadReq.on('error', reject);
            uploadReq.write(multipartBody);
            uploadReq.end();
          });
          const docId = uploadResult.id;
          if (docId) {
            const exp = await gmailApiRequest('GET',
              `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`, accessToken);
            textContent = typeof exp.data === 'string' ? exp.data : JSON.stringify(exp.data);
            try { await gmailApiRequest('DELETE', `https://www.googleapis.com/drive/v3/files/${docId}`, accessToken); } catch {}
          } else {
            textContent = '[PDF 변환 실패]';
          }
        } else if (['docx', 'doc', 'pptx', 'ppt', 'rtf', 'odt', 'odp'].includes(ext)) {
          // Office → Google Docs 변환
          const accessToken = await getValidAccessToken(userNN);
          const fileMime = {
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            doc: 'application/msword', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            ppt: 'application/vnd.ms-powerpoint', rtf: 'application/rtf',
            odt: 'application/vnd.oasis.opendocument.text', odp: 'application/vnd.oasis.opendocument.presentation',
          }[ext] || 'application/octet-stream';
          const boundary = 'upload_' + Date.now();
          const metadata = JSON.stringify({ name: `_tmp_upload_${Date.now()}`, mimeType: 'application/vnd.google-apps.document' });
          const multipartBody = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${fileMime}\r\n\r\n`),
            fileBuffer,
            Buffer.from(`\r\n--${boundary}--`),
          ]);
          const uploadResult = await new Promise((resolve, reject) => {
            const uploadReq = https.request({
              hostname: 'www.googleapis.com',
              path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': multipartBody.length,
              },
            }, (uploadRes) => {
              let data = '';
              uploadRes.on('data', chunk => { data += chunk; });
              uploadRes.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
            });
            uploadReq.on('error', reject);
            uploadReq.write(multipartBody);
            uploadReq.end();
          });
          const docId = uploadResult.id;
          if (docId) {
            const exp = await gmailApiRequest('GET',
              `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`, accessToken);
            textContent = typeof exp.data === 'string' ? exp.data : JSON.stringify(exp.data);
            try { await gmailApiRequest('DELETE', `https://www.googleapis.com/drive/v3/files/${docId}`, accessToken); } catch {}
          } else {
            textContent = '[문서 변환 실패]';
          }
        } else if (['xlsx', 'xls', 'ods'].includes(ext)) {
          // Spreadsheet → Google Sheets 변환 → CSV
          const accessToken = await getValidAccessToken(userNN);
          const fileMime = {
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            xls: 'application/vnd.ms-excel', ods: 'application/vnd.oasis.opendocument.spreadsheet',
          }[ext] || 'application/octet-stream';
          const boundary = 'upload_' + Date.now();
          const metadata = JSON.stringify({ name: `_tmp_upload_${Date.now()}`, mimeType: 'application/vnd.google-apps.spreadsheet' });
          const multipartBody = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${fileMime}\r\n\r\n`),
            fileBuffer,
            Buffer.from(`\r\n--${boundary}--`),
          ]);
          const uploadResult = await new Promise((resolve, reject) => {
            const uploadReq = https.request({
              hostname: 'www.googleapis.com',
              path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': multipartBody.length,
              },
            }, (uploadRes) => {
              let data = '';
              uploadRes.on('data', chunk => { data += chunk; });
              uploadRes.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
            });
            uploadReq.on('error', reject);
            uploadReq.write(multipartBody);
            uploadReq.end();
          });
          const sheetId = uploadResult.id;
          if (sheetId) {
            const exp = await gmailApiRequest('GET',
              `https://www.googleapis.com/drive/v3/files/${sheetId}/export?mimeType=text/csv`, accessToken);
            textContent = typeof exp.data === 'string' ? exp.data : JSON.stringify(exp.data);
            try { await gmailApiRequest('DELETE', `https://www.googleapis.com/drive/v3/files/${sheetId}`, accessToken); } catch {}
          } else {
            textContent = '[스프레드시트 변환 실패]';
          }
        } else if (['hwp', 'hwpx'].includes(ext)) {
          // HWP → rhwp → text + documents에 원본 저장 (이미지 변환용)
          const fileBase64 = fs.readFileSync(tmpPath).toString('base64');
          const hwpResult = await hwpProcess('parse', fileBase64);
          textContent = hwpResult.ok ? hwpResult.text : `[HWP 변환 실패: ${hwpResult.error}]`;
          // 원본 파일을 documents에 저장해서 hwp_export_page 호출 가능하게
          try {
            const docsDir = `/opt/openclaw/shared/user${userNN}`;
            if (fs.existsSync(docsDir)) {
              const safeName = fileName.replace(/[^a-zA-Z0-9가-힣._-]/g, '_');
              const destPath = path.join(docsDir, safeName);
              fs.copyFileSync(tmpPath, destPath);
              textContent += `\n\n[파일 저장 경로: /home/node/documents/${safeName}]`;
            }
          } catch {}
        } else {
          textContent = `[지원하지 않는 파일 형식: ${ext}]`;
        }
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }

      console.log(`[file] upload: ${fileName} (${ext}, ${(sizeNum/1024).toFixed(1)}KB) → ${textContent ? textContent.length : 0} chars`);
      jsonRes(res, 200, { ok: true, fileName, ext, size: sizeNum, contentLength: textContent?.length || 0, content: textContent });
    } catch (err) {
      console.error('[file] upload error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/drive/upload — Upload file to Google Drive folder
  if (req.method === 'POST' && url.pathname === '/api/drive/upload') {
    try {
      const params = await parseBody(req);
      const { userNN, fileName, mimeType, content, folderId } = params; // content = base64
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!content || !fileName) { jsonRes(res, 400, { ok: false, error: 'Missing fileName or content' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const fileBuffer = Buffer.from(content, 'base64');
      const fileMimeType = mimeType || 'application/octet-stream';

      const boundary = 'drive_upload_' + Date.now();
      const metadata = JSON.stringify({
        name: fileName,
        ...(folderId ? { parents: [folderId] } : {}),
      });
      const multipartBody = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${fileMimeType}\r\n\r\n`),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}--`),
      ]);

      const uploadResult = await new Promise((resolve, reject) => {
        const uploadReq = https.request({
          hostname: 'www.googleapis.com',
          path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': multipartBody.length,
          },
        }, (uploadRes) => {
          let data = '';
          uploadRes.on('data', chunk => { data += chunk; });
          uploadRes.on('end', () => { try { resolve({ status: uploadRes.statusCode, data: JSON.parse(data) }); } catch { resolve({ status: uploadRes.statusCode, data }); } });
        });
        uploadReq.on('error', reject);
        uploadReq.write(multipartBody);
        uploadReq.end();
      });

      if (uploadResult.status >= 400) {
        jsonRes(res, uploadResult.status, { ok: false, error: uploadResult.data?.error?.message || 'Upload failed' }); return;
      }

      console.log(`[drive] upload: ${fileName} → ${uploadResult.data.id} folder=${folderId || 'root'}`);
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, { ok: true, account: token?.email || '', fileId: uploadResult.data.id, fileName });
    } catch (err) {
      console.error('[drive] upload error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/drive/revisions?userNN=01&fileId=xxx
  if (req.method === 'GET' && url.pathname === '/api/drive/revisions') {
    try {
      const userNN = url.searchParams.get('userNN');
      const fileId = url.searchParams.get('fileId');
      const max = parseInt(url.searchParams.get('max') || '20', 10);
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!fileId) { jsonRes(res, 400, { ok: false, error: 'Missing fileId' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const result = await gmailApiRequest('GET',
        `https://www.googleapis.com/drive/v3/files/${fileId}/revisions?pageSize=${max}&fields=revisions(id,modifiedTime,lastModifyingUser)`,
        accessToken);
      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Revisions failed' }); return;
      }
      const revisions = (result.data.revisions || []).map(r => ({
        id: r.id,
        modified: r.modifiedTime || null,
        modifiedBy: r.lastModifyingUser?.displayName || r.lastModifyingUser?.emailAddress || null,
        email: r.lastModifyingUser?.emailAddress || null,
      }));
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, { ok: true, account: token?.email || '', fileId, revisionCount: revisions.length, revisions });
    } catch (err) {
      console.error('[drive] revisions error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ===== Sheets API =====

  // POST /api/sheets/create — Create Google Sheet (내 드라이브 or 공유 드라이브)
  if (req.method === 'POST' && url.pathname === '/api/sheets/create') {
    try {
      const params = await parseBody(req);
      const { userNN, title, headers, rows, folderId, driveId } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!title) { jsonRes(res, 400, { ok: false, error: 'Missing title' }); return; }

      const accessToken = await getValidAccessToken(userNN);

      // 1. Create empty spreadsheet via Drive API (supports shared drives)
      const fileMeta = {
        name: title,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        ...(folderId ? { parents: [folderId] } : {}),
      };
      let createUrl = 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true';
      const createResult = await gmailApiRequest('POST', createUrl, accessToken, fileMeta);
      if (createResult.status >= 400) {
        jsonRes(res, createResult.status, { ok: false, error: createResult.data?.error?.message || 'Create failed' }); return;
      }

      const spreadsheetId = createResult.data.id;
      const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

      // 2. Write data if provided
      if ((headers && headers.length > 0) || (rows && rows.length > 0)) {
        const values = [];
        if (headers) values.push(headers);
        if (rows) values.push(...rows);

        await gmailApiRequest('PUT',
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1?valueInputOption=USER_ENTERED`,
          accessToken, { range: 'Sheet1!A1', majorDimension: 'ROWS', values });
      }

      console.log(`[sheets] created: ${title} (${spreadsheetId}) folder=${folderId || 'root'} userNN=${userNN}`);
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, { ok: true, account: token?.email || '', spreadsheetId, title, url: spreadsheetUrl });
    } catch (err) {
      console.error('[sheets] create error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/sheets/update — Update existing Google Sheet
  if (req.method === 'POST' && url.pathname === '/api/sheets/update') {
    try {
      const params = await parseBody(req);
      const { userNN, spreadsheetId, range, values } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!spreadsheetId || !values) { jsonRes(res, 400, { ok: false, error: 'Missing spreadsheetId or values' }); return; }

      const accessToken = await getValidAccessToken(userNN);
      const sheetRange = range || 'Sheet1!A1';

      const result = await gmailApiRequest('PUT',
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetRange)}?valueInputOption=USER_ENTERED`,
        accessToken, { range: sheetRange, majorDimension: 'ROWS', values });

      if (result.status >= 400) {
        jsonRes(res, result.status, { ok: false, error: result.data?.error?.message || 'Update failed' }); return;
      }

      console.log(`[sheets] updated: ${spreadsheetId} range=${sheetRange}`);
      jsonRes(res, 200, { ok: true, updatedRange: result.data.updatedRange, updatedRows: result.data.updatedRows, updatedCells: result.data.updatedCells });
    } catch (err) {
      console.error('[sheets] update error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/sheets/xlsx — Create XLSX file and upload to Drive
  if (req.method === 'POST' && url.pathname === '/api/sheets/xlsx') {
    try {
      const params = await parseBody(req);
      const { userNN, title, headers, rows, folderId } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!title) { jsonRes(res, 400, { ok: false, error: 'Missing title' }); return; }

      const accessToken = await getValidAccessToken(userNN);

      // Build CSV content, then upload as Google Sheet which auto-converts
      const allRows = [];
      if (headers) allRows.push(headers);
      if (rows) allRows.push(...rows);
      const csvContent = allRows.map(row => row.map(cell => {
        const s = String(cell ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')).join('\n');

      // Upload as XLSX via multipart (metadata + CSV content, convert to Google Sheets then export as XLSX)
      // Simpler approach: create Google Sheet, write data, then export as XLSX
      const createResult = await gmailApiRequest('POST',
        'https://sheets.googleapis.com/v4/spreadsheets',
        accessToken, {
          properties: { title },
          sheets: [{ properties: { title: 'Sheet1' } }],
        });
      if (createResult.status >= 400) {
        jsonRes(res, createResult.status, { ok: false, error: createResult.data?.error?.message || 'Create failed' }); return;
      }
      const spreadsheetId = createResult.data.spreadsheetId;

      // Write data
      if (allRows.length > 0) {
        await gmailApiRequest('PUT',
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1?valueInputOption=USER_ENTERED`,
          accessToken, { range: 'Sheet1!A1', majorDimension: 'ROWS', values: allRows });
      }

      // Export as XLSX
      const xlsxUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?exportFormat=xlsx`;
      const tmpPath = `/tmp/sheet_${Date.now()}.xlsx`;
      await new Promise((resolve, reject) => {
        const child = require('child_process').spawn('curl', [
          '-s', '-L', '-o', tmpPath,
          '-H', `Authorization: Bearer ${accessToken}`,
          xlsxUrl,
        ], { timeout: 30000 });
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`XLSX export failed (exit ${code})`));
          else resolve();
        });
        child.on('error', reject);
      });

      // Upload XLSX to Drive
      const xlsxData = fs.readFileSync(tmpPath);
      const boundary = 'xlsx_boundary_' + Date.now();
      const metadata = JSON.stringify({
        name: title.endsWith('.xlsx') ? title : `${title}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ...(folderId ? { parents: [folderId] } : {}),
      });
      const multipartBody = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
        xlsxData,
        Buffer.from(`\r\n--${boundary}--`),
      ]);

      const uploadResult = await new Promise((resolve, reject) => {
        const uploadReq = https.request({
          hostname: 'www.googleapis.com',
          path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': multipartBody.length,
          },
        }, (uploadRes) => {
          let data = '';
          uploadRes.on('data', chunk => { data += chunk; });
          uploadRes.on('end', () => {
            try { resolve({ status: uploadRes.statusCode, data: JSON.parse(data) }); }
            catch { resolve({ status: uploadRes.statusCode, data }); }
          });
        });
        uploadReq.on('error', reject);
        uploadReq.write(multipartBody);
        uploadReq.end();
      });

      // Delete temp Google Sheet and local file
      try { await gmailApiRequest('DELETE', `https://www.googleapis.com/drive/v3/files/${spreadsheetId}`, accessToken); } catch {}
      try { fs.unlinkSync(tmpPath); } catch {}

      if (uploadResult.status >= 400) {
        jsonRes(res, uploadResult.status, { ok: false, error: uploadResult.data?.error || 'Upload failed' }); return;
      }

      console.log(`[sheets] xlsx created: ${title} (${uploadResult.data.id})`);
      const token = loadGoogleToken(userNN);
      jsonRes(res, 200, { ok: true, account: token?.email || '', fileId: uploadResult.data.id, title: `${title}.xlsx` });
    } catch (err) {
      console.error('[sheets] xlsx error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ============ INTEGRATIONS TOKEN SAVE/LOAD (유저별) ============
  if (req.method === 'POST' && url.pathname === '/api/integrations/save') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const userNN = data.userNN || url.searchParams.get('userNN');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      if (data.dooray) {
        existing.dooray = { ...existing.dooray, ...data.dooray, updatedAt: new Date().toISOString() };
        if (data.dooray.token) {
          try {
            const memberRes = await doorayApiRequest('GET', 'https://api.dooray.com/common/v1/members/me', data.dooray.token);
            if (memberRes.status < 400 && memberRes.data?.result?.id) {
              existing.dooray.memberId = memberRes.data.result.id;
              existing.dooray.memberName = memberRes.data.result.name || '';
              console.log(`[dooray] memberId saved for user${userNN}: ${existing.dooray.memberName} (${existing.dooray.memberId})`);
            }
          } catch (e) { console.warn('[dooray] memberId fetch failed:', e.message); }
        }
      }
      if (data.github) existing.github = { ...existing.github, ...data.github, updatedAt: new Date().toISOString() };
      fs.writeFileSync(intFile, JSON.stringify(existing, null, 2));
      jsonRes(res, 200, { ok: true });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/integrations/delete') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const userNN = data.userNN || url.searchParams.get('userNN');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      if (data.dooray) { delete existing.dooray; console.log(`[dooray] integration deleted for user${userNN}`); }
      if (data.github) { delete existing.github; }
      fs.writeFileSync(intFile, JSON.stringify(existing, null, 2));
      jsonRes(res, 200, { ok: true });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations/load') {
    try {
      const userNN = url.searchParams.get('userNN');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let data = {};
      try { data = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      const safe = {};
      if (data.dooray) safe.dooray = { token: data.dooray.token ? '••••' + data.dooray.token.slice(-4) : '', memberId: data.dooray.memberId || '', memberName: data.dooray.memberName || '', updatedAt: data.dooray.updatedAt || '' };
      if (data.github) safe.github = { owner: data.github.owner || '', repo: data.github.repo || '', token: data.github.token ? '••••' + data.github.token.slice(-4) : '', updatedAt: data.github.updatedAt || '' };
      jsonRes(res, 200, { ok: true, data: safe });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ============ FILE DOWNLOAD ============
  if (req.method === 'GET' && url.pathname === '/api/file/download') {
    try {
      const userNN = url.searchParams.get('userNN');
      const filePath = url.searchParams.get('path') || '';
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!filePath) { jsonRes(res, 400, { ok: false, error: 'path 필수' }); return; }

      // 보안: path traversal 방지 - documents 폴더 내 파일만 허용
      const baseDir = path.resolve(`/opt/openclaw/shared/user${userNN}`);
      const resolved = path.resolve(baseDir, filePath.replace(/^\/home\/node\/documents\//, '').replace(/^\//, ''));
      if (!resolved.startsWith(baseDir)) { jsonRes(res, 403, { ok: false, error: 'Access denied' }); return; }

      if (!fs.existsSync(resolved)) { jsonRes(res, 404, { ok: false, error: 'File not found' }); return; }

      const stat = fs.statSync(resolved);
      if (!stat.isFile()) { jsonRes(res, 400, { ok: false, error: 'Not a file' }); return; }

      const filename = path.basename(resolved);
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv',
        '.html': 'text/html', '.json': 'application/json',
        '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': stat.size,
      });
      fs.createReadStream(resolved).pipe(res);
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/file/list — 사용자 documents 폴더 파일 목록
  if (req.method === 'GET' && url.pathname === '/api/file/list') {
    try {
      const userNN = url.searchParams.get('userNN');
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const baseDir = `/opt/openclaw/shared/user${userNN}`;
      const subDir = url.searchParams.get('dir') || '';
      const targetDir = path.resolve(baseDir, subDir.replace(/^\//, ''));
      if (!targetDir.startsWith(baseDir)) { jsonRes(res, 403, { ok: false, error: 'Access denied' }); return; }
      if (!fs.existsSync(targetDir)) { jsonRes(res, 404, { ok: false, error: 'Directory not found' }); return; }

      const entries = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          isDir: e.isDirectory(),
          size: e.isFile() ? fs.statSync(path.join(targetDir, e.name)).size : null,
        }));
      jsonRes(res, 200, { ok: true, files: entries });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ============ DOORAY API ============
  // 요청 로깅
  if (url.pathname.startsWith('/api/dooray/')) {
    console.log(`[dooray] ${req.method} ${url.pathname}${url.search} from ${req.socket.remoteAddress}`);
  }
  if (req.method === 'GET' && url.pathname === '/api/dooray/projects') {
    try {
      const userNN = url.searchParams.get('userNN') || '01';
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let intData = {};
      try { intData = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      const token = intData?.dooray?.token;
      if (!token) { jsonRes(res, 400, { ok: false, error: 'Dooray 토큰이 설정되지 않았습니다' }); return; }
      const result = await doorayApiRequest('GET', 'https://api.dooray.com/project/v1/projects?page=0&size=100', token);
      if (result.status >= 400) { jsonRes(res, result.status, { ok: false, error: result.data?.message || 'Dooray API error' }); return; }
      const projects = (result.data?.result || []).map(p => ({
        id: p.id, name: p.code || p.name, description: p.description || '', scope: p.scope || '', state: p.state || ''
      }));
      jsonRes(res, 200, { ok: true, projects });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/dooray/tasks') {
    try {
      const projectId = url.searchParams.get('projectId');
      const page = url.searchParams.get('page') || '0';
      const size = url.searchParams.get('size') || '20';
      const status = url.searchParams.get('status') || '';
      if (!projectId) { jsonRes(res, 400, { ok: false, error: 'projectId 필수' }); return; }
      const userNN = url.searchParams.get('userNN') || '01';
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let intData = {};
      try { intData = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      const token = intData?.dooray?.token;
      if (!token) { jsonRes(res, 400, { ok: false, error: 'Dooray 토큰이 설정되지 않았습니다' }); return; }
      const memberIds = url.searchParams.get('memberIds') || '';
      const ccMemberIds = url.searchParams.get('ccMemberIds') || '';
      let apiUrl = `https://api.dooray.com/project/v1/projects/${projectId}/posts?page=${page}&size=${size}&order=-updatedAt`;
      if (status) apiUrl += `&workflowClasses=${status}`;
      if (memberIds) apiUrl += `&memberIds=${memberIds}`;
      if (ccMemberIds) apiUrl += `&ccMemberIds=${ccMemberIds}`;
      const result = await doorayApiRequest('GET', apiUrl, token);
      if (result.status >= 400) { jsonRes(res, result.status, { ok: false, error: result.data?.message || 'Dooray API error' }); return; }
      const tasks = (result.data?.result || []).map(t => ({
        id: t.id, number: t.number, subject: t.subject || t.parent?.subject || '',
        workflowClass: t.workflowClass || '', priority: t.priority || '',
        createdAt: t.createdAt || '', updatedAt: t.updatedAt || '',
        dueDate: t.dueDateFlag ? (t.dueDate || '') : '',
        users: { to: (t.users?.to || []).map(u => u.member?.name || u.member?.id || '') }
      }));
      const totalCount = result.data?.totalCount || tasks.length;
      jsonRes(res, 200, { ok: true, tasks, totalCount, page: parseInt(page), size: parseInt(size) });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/dooray/task') {
    try {
      const projectId = url.searchParams.get('projectId');
      const taskId = url.searchParams.get('taskId');
      if (!projectId || !taskId) { jsonRes(res, 400, { ok: false, error: 'projectId, taskId 필수' }); return; }
      const userNN = url.searchParams.get('userNN') || '01';
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let intData = {};
      try { intData = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      const token = intData?.dooray?.token;
      if (!token) { jsonRes(res, 400, { ok: false, error: 'Dooray 토큰이 설정되지 않았습니다' }); return; }
      const result = await doorayApiRequest('GET', `https://api.dooray.com/project/v1/projects/${projectId}/posts/${taskId}`, token);
      if (result.status >= 400) { jsonRes(res, result.status, { ok: false, error: result.data?.message || 'Dooray API error' }); return; }
      const t = result.data?.result || {};
      jsonRes(res, 200, {
        ok: true, task: {
          id: t.id, number: t.number, subject: t.subject || '',
          body: t.body?.content || '', mimeType: t.body?.mimeType || '',
          workflowClass: t.workflowClass || '', priority: t.priority || '',
          createdAt: t.createdAt || '', updatedAt: t.updatedAt || '',
          dueDate: t.dueDateFlag ? (t.dueDate || '') : '',
          users: {
            to: (t.users?.to || []).map(u => ({ name: u.member?.name || '', email: u.member?.emailAddress || '' })),
            cc: (t.users?.cc || []).map(u => ({ name: u.member?.name || '', email: u.member?.emailAddress || '' }))
          },
          tags: (t.tags || []).map(tag => tag.name || ''),
          milestone: t.milestone?.name || ''
        }
      });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/dooray/member?email=xxx 또는 ?name=xxx
  if (req.method === 'GET' && url.pathname === '/api/dooray/member') {
    try {
      const email = url.searchParams.get('email') || '';
      const name = url.searchParams.get('name') || '';
      if (!email && !name) { jsonRes(res, 400, { ok: false, error: 'email 또는 name 필수' }); return; }
      const userNN = url.searchParams.get('userNN') || '01';
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let intData = {};
      try { intData = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      const token = intData?.dooray?.token;
      if (!token) { jsonRes(res, 400, { ok: false, error: 'Dooray 토큰이 설정되지 않았습니다' }); return; }
      let apiUrl = 'https://api.dooray.com/common/v1/members?';
      if (email) apiUrl += `externalEmailAddresses=${encodeURIComponent(email)}`;
      else apiUrl += `name=${encodeURIComponent(name)}`;
      const result = await doorayApiRequest('GET', apiUrl, token);
      if (result.status >= 400) { jsonRes(res, result.status, { ok: false, error: result.data?.message || 'Dooray API error' }); return; }
      const members = (result.data?.result || []).map(m => ({
        id: m.id, name: m.name, email: m.externalEmailAddress || '', userCode: m.userCode || ''
      }));
      jsonRes(res, 200, { ok: true, members });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ===== Existing API routes =====
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    jsonRes(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  let params;
  try { params = await parseBody(req); }
  catch { jsonRes(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

  if (url.pathname === '/automap') {
    const { userNN, agentId, token } = params;
    if (!userNN || !agentId || !token) { jsonRes(res, 400, { ok: false, error: 'Missing params' }); return; }
    if (!validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) { jsonRes(res, 400, { ok: false, error: 'Invalid agentId' }); return; }
    execFile('/bin/bash', [AUTOMAP_SCRIPT, userNN, agentId, token], {
      timeout: 90000, env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
    }, (err, stdout, stderr) => {
      if (err) { jsonRes(res, 500, { ok: false, error: stderr || err.message, output: stdout }); return; }
      jsonRes(res, 200, { ok: true, output: stdout });
    });

  } else if (url.pathname === '/sync') {
    const { userNN } = params;
    if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    execFile('/bin/bash', [SYNC_SCRIPT, userNN], {
      timeout: 30000, env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
    }, (err, stdout, stderr) => {
      if (err) { jsonRes(res, 500, { ok: false, error: stderr || err.message, output: stdout }); return; }
      jsonRes(res, 200, { ok: true, output: stdout });
    });

  // POST /api/hwp/parse — HWP/HWPX 텍스트 추출
  } else if (url.pathname === '/api/hwp/parse') {
    try {
      const { userNN, fileBase64, fileName } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!fileBase64) { jsonRes(res, 400, { ok: false, error: 'Missing fileBase64' }); return; }
      const result = await hwpProcess('parse', fileBase64);
      if (!result.ok) { jsonRes(res, 422, { ok: false, error: result.error }); return; }
      console.log(`[hwp] parse: ${fileName || 'file'} → ${result.text?.length || 0} chars, ${result.pageCount} pages`);
      jsonRes(res, 200, { ok: true, text: result.text, pageCount: result.pageCount });
    } catch (err) {
      console.error('[hwp] parse error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }

  // POST /api/hwp/info — HWP/HWPX 문서 메타데이터
  } else if (url.pathname === '/api/hwp/info') {
    try {
      const { userNN, fileBase64 } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!fileBase64) { jsonRes(res, 400, { ok: false, error: 'Missing fileBase64' }); return; }
      const result = await hwpProcess('info', fileBase64);
      if (!result.ok) { jsonRes(res, 422, { ok: false, error: result.error }); return; }
      jsonRes(res, 200, { ok: true, info: result.info });
    } catch (err) {
      console.error('[hwp] info error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }

  // POST /api/hwp/export-svg — HWP/HWPX 페이지 SVG 변환
  } else if (url.pathname === '/api/hwp/export-svg') {
    try {
      const { userNN, fileBase64, page, fileName } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!fileBase64) { jsonRes(res, 400, { ok: false, error: 'Missing fileBase64' }); return; }
      const pageNum = typeof page === 'number' ? page : parseInt(page ?? '0', 10) || 0;
      const result = await hwpProcess('export-svg', fileBase64, { page: pageNum });
      if (!result.ok) { jsonRes(res, 422, { ok: false, error: result.error }); return; }
      // SVG를 workspace/hwp-exports/ 에 저장
      const exportDir = path.join(SVG_EXPORT_BASE, `user${userNN}`, 'workspace', 'hwp-exports');
      fs.mkdirSync(exportDir, { recursive: true });
      const baseName = (fileName || 'document').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
      const svgName = `${baseName}_p${pageNum + 1}_${Date.now()}.svg`;
      const svgPath = path.join(exportDir, svgName);
      fs.writeFileSync(svgPath, result.svg, 'utf8');
      const downloadUrl = `http://claw.tideflo.work/api/file/download?userNN=${userNN}&file=hwp-exports/${svgName}`;
      console.log(`[hwp] export-svg: page ${pageNum} → ${svgName}`);
      jsonRes(res, 200, { ok: true, svgPath: `/home/node/documents/hwp-exports/${svgName}`, downloadUrl, pageCount: result.pageCount });
    } catch (err) {
      console.error('[hwp] export-svg error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }

  } else {
    jsonRes(res, 404, { ok: false, error: 'Not found' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[openclaw-api] listening on 0.0.0.0:${PORT}`);
});
