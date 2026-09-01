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

// admin DB (SQLite) 통합 — Phase 1
const { openDb } = require('./admin-db/lib/db');
const { startWatcher } = require('./admin-db/watcher');
const { catchup } = require('./admin-db/catchup');

// per-user memories DB (SQLite + FTS5)
const { openMemoryDb } = require('./memories/lib/db');

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/* Moonshot multi-key rotation — 429/401/403 받으면 다음 키. 60초 cooldown. */
let _moonshotKeyIdx = -1;
const _moonshotKeyCooldown = new Map(); // key -> lastFailMs
const MOONSHOT_COOLDOWN_MS = 60_000;

function moonshotKeys() {
  const list = (process.env.MOONSHOT_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length > 0) return list;
  const primary = (process.env.MOONSHOT_API_KEY || '').trim();
  return primary ? [primary] : [];
}

function nextMoonshotKey() {
  const keys = moonshotKeys();
  if (keys.length === 0) return null;
  const now = Date.now();
  /* cooldown 안 걸린 키 우선 — 라운드 로빈 시작점부터 일주 */
  for (let i = 0; i < keys.length; i++) {
    _moonshotKeyIdx = (_moonshotKeyIdx + 1) % keys.length;
    const k = keys[_moonshotKeyIdx];
    const last = _moonshotKeyCooldown.get(k) || 0;
    if (now - last > MOONSHOT_COOLDOWN_MS) return k;
  }
  /* 다 cooldown 중이어도 그래도 하나 시도 (가장 최근 마지막 실패 키 다음 키) */
  return keys[_moonshotKeyIdx];
}

function markMoonshotKeyFail(key) {
  if (key) _moonshotKeyCooldown.set(key, Date.now());
}
let _adminDb = null;
function getAdminDb() {
  if (_adminDb) return _adminDb;
  try {
    _adminDb = openDb();
    try { catchup(_adminDb); } catch (e) { console.error('[admin-db] catchup error:', e.message); }
    try { startWatcher(_adminDb); } catch (e) { console.error('[admin-db] watcher error:', e.message); }
    console.log('[admin-db] ready');
  } catch (e) {
    console.error('[admin-db] init failed:', e.message);
  }
  return _adminDb;
}

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
  return /^(0[1-9]|1[0-6])$/.test(userNN);
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
  '황승현': 'dragonray@tideflo.com',
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

// 이메일 → 이름 역매핑
const EMAIL_TO_NAME = Object.fromEntries(Object.entries(MEMBER_MAP).map(([n, e]) => [e, n]));
function resolveName(email) {
  return EMAIL_TO_NAME[email] || null;
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
    const bodyChunks = [];
    req.on('data', chunk => { bodyChunks.push(chunk); });
    req.on('end', () => {
        const body = Buffer.concat(bodyChunks).toString('utf8');
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
      const dataChunks = [];
      res.on('data', chunk => { dataChunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(dataChunks).toString('utf8')));
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
      const dataChunks = [];
      res.on('data', chunk => { dataChunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(dataChunks).toString('utf8')));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function findNextAvailableSlot(users) {
  const taken = new Set(Object.values(users));
  for (let i = 1; i <= 16; i++) {
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
    const bodyChunks = [];
    req.on('data', chunk => { bodyChunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(bodyChunks).toString('utf8')));
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
      const dataChunks = [];
      res.on('data', chunk => { dataChunks.push(chunk); });
      res.on('end', () => {
        const data = Buffer.concat(dataChunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function figmaApi(path, token) {
  return new Promise((resolve) => {
    const r = https.request({ hostname: 'api.figma.com', path, method: 'GET',
                              headers: { 'X-Figma-Token': token } }, (res2) => {
      const dataChunks = [];
      res2.on('data', chunk => { dataChunks.push(chunk); });
      res2.on('end', () => {
        const data = Buffer.concat(dataChunks).toString('utf8'); try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null));
    r.end();
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
      const dataChunks = [];
      res.on('data', chunk => { dataChunks.push(chunk); });
      res.on('end', () => {
        const data = Buffer.concat(dataChunks).toString('utf8');
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

/* attachments: [{ filename, mimeType, data(base64 string) }] — 있으면 multipart/mixed wrapper.
   data는 base64 인코딩된 문자열. mimeType 누락 시 application/octet-stream. */
function buildRawEmail({ from, to, cc, subject, body, bodyHtml, attachments }) {
  const innerBoundary = 'alt_' + crypto.randomBytes(12).toString('hex');
  const hasAttach = Array.isArray(attachments) && attachments.length > 0;

  /* 본문 multipart/alternative 블록 (text + html) */
  const altLines = [
    `Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
    '',
    `--${innerBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body || '').toString('base64'),
  ];
  if (bodyHtml) {
    altLines.push(
      `--${innerBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(bodyHtml).toString('base64'),
    );
  }
  altLines.push(`--${innerBoundary}--`);

  const headerLines = [`From: ${from}`, `To: ${to}`];
  if (cc) headerLines.push(`Cc: ${cc}`);
  headerLines.push(
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
  );

  let raw;
  if (!hasAttach) {
    /* 첨부 없음: 기존 동작 — 헤더에 alternative content-type 직접 박음 */
    raw = [...headerLines, ...altLines].join('\r\n');
  } else {
    /* 첨부 있음: multipart/mixed wrapper. */
    const outerBoundary = 'mix_' + crypto.randomBytes(12).toString('hex');
    const parts = [
      ...headerLines,
      `Content-Type: multipart/mixed; boundary="${outerBoundary}"`,
      '',
      `--${outerBoundary}`,
      ...altLines,
    ];
    for (const a of attachments) {
      const filename = a.filename || 'attachment';
      const mime = a.mimeType || 'application/octet-stream';
      const dataB64 = typeof a.data === 'string' ? a.data.replace(/\s+/g, '') : '';
      if (!dataB64) continue;
      /* RFC 2047 헤더 인코딩 — 한글 파일명 호환 */
      const encName = `=?UTF-8?B?${Buffer.from(filename).toString('base64')}?=`;
      parts.push(
        `--${outerBoundary}`,
        `Content-Type: ${mime}; name="${encName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${encName}"`,
        '',
        /* base64는 76자마다 줄바꿈하는 게 RFC 권장 — gmail은 안 해도 받음 */
        dataB64.match(/.{1,76}/g)?.join('\r\n') || dataB64,
      );
    }
    parts.push(`--${outerBoundary}--`);
    raw = parts.join('\r\n');
  }
  return Buffer.from(raw).toString('base64url');
}

// ===== Mail Pending Queue (사용자 확인 강제) =====
// 봇이 어떤 에이전트로 동작하든, 어떤 프롬프트를 갖든 mail/send를 거치면 이 큐에 적재만 됨.
// 실제 발송은 UI의 [발송] 버튼 → /api/mail/send-confirm.
const pendingMails = new Map(); // mailId -> { userNN, payload, confirmToken, createdAt, from }
const briefCache = new Map();   // userNN -> { ts, data }
const BRIEF_TTL_MS = 60_000;
const MAIL_PENDING_TTL_MS = 10 * 60 * 1000;

function cleanupPendingMails() {
  const now = Date.now();
  for (const [id, m] of pendingMails) {
    if (now - m.createdAt > MAIL_PENDING_TTL_MS) pendingMails.delete(id);
  }
}
setInterval(cleanupPendingMails, 60 * 1000).unref?.();

function makeMailPreview(payload) {
  const bodyText = (payload.body || '').toString();
  const htmlText = (payload.bodyHtml || '').toString().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const src = bodyText || htmlText;
  return {
    to: payload.to,
    cc: payload.cc || null,
    subject: payload.subject,
    body: src,
    bodyPreview: src.length > 800 ? src.slice(0, 800) + '…' : src,
    bodyLength: src.length,
  };
}

async function actuallySendMail(userNN, payload) {
  const { to, cc, subject, body, bodyHtml, from: fromOverride, attachments } = payload;
  const resolvedTo = resolveEmail(to);
  const resolvedCc = cc ? resolveEmail(cc) : cc;
  const token = loadGoogleToken(userNN);
  if (!token?.email) throw new Error(`No email configured for user${userNN}`);
  // from은 기본 토큰의 이메일, 사용자가 명시 override 시 그것 사용 (Gmail send-as 별칭일 때만 실제로 적용됨)
  const from = fromOverride || token.email;

  let fixedSubject = subject;
  if (subject.includes('주간보고')) {
    const week = getWeekRange();
    const correctRange = `${week.monday}~${week.friday}`;
    fixedSubject = fixedSubject.replace(/\[주간보고\]\[[^\]]*\]/, `[주간보고][${correctRange}]`);
    if (!fixedSubject.includes(`[${correctRange}]`)) {
      fixedSubject = `[주간보고][${correctRange}]` + fixedSubject.replace(/\[주간보고\]/, '');
    }
  }
  let fixedBody = body || '';
  if (subject.includes('주간보고') && fixedBody.includes('기간')) {
    const week = getWeekRange();
    const correctRange = `${week.monday}~${week.friday}`;
    fixedBody = fixedBody.replace(/기간\([^)]*\)/, `기간(${correctRange})`);
    fixedBody = fixedBody.replace(/기간[:\s]*\d{4}[-년]\s*\d{1,2}[-월]\s*\d{1,2}[일]?\s*~\s*\d{4}[-년]\s*\d{1,2}[-월]\s*\d{1,2}[일]?/, `기간: ${week.monday} ~ ${week.friday}`);
    fixedBody = fixedBody.replace(/기간[:\s]*\d{1,2}월\s*\d{1,2}일\s*~\s*\d{1,2}월\s*\d{1,2}일/, `기간: ${week.monday} ~ ${week.friday}`);
  }

  const accessToken = await getValidAccessToken(userNN);
  const raw = buildRawEmail({ from, to: resolvedTo, cc: resolvedCc, subject: fixedSubject, body: fixedBody, bodyHtml, attachments });
  const result = await gmailApiRequest('POST',
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    accessToken, { raw });
  if (result.status >= 400) {
    const e = new Error(result.data?.error?.message || 'Send failed');
    e.gmailStatus = result.status;
    throw e;
  }
  return { from, resolvedTo, resolvedCc, fixedSubject, result };
}

// ===== 최근 수신자 저장 (UI 자동완성용) =====
const RECENT_CAP = 50;
function recentRecipientsFile(userNN) {
  return path.join(__dirname, '..', 'data', `user${userNN}`, 'recent-recipients.json');
}
function loadRecentRecipients(userNN) {
  try {
    const data = JSON.parse(fs.readFileSync(recentRecipientsFile(userNN), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function saveRecentRecipients(userNN, list) {
  try {
    const file = recentRecipientsFile(userNN);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  } catch (e) { console.error('[recent] save error:', e.message); }
}
function recordRecipientUse(userNN, addrList) {
  if (!addrList) return;
  const tokens = String(addrList).split(',').map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return;
  const list = loadRecentRecipients(userNN);
  const now = Date.now();
  for (const tok of tokens) {
    const email = tok.includes('@') ? tok : MEMBER_MAP[tok];
    if (!email) continue;
    const name = EMAIL_TO_NAME[email] || null;
    const idx = list.findIndex(r => r.email === email);
    if (idx >= 0) {
      list[idx].lastUsed = now;
      if (name && !list[idx].name) list[idx].name = name;
    } else {
      list.push({ email, name, lastUsed: now });
    }
  }
  list.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  if (list.length > RECENT_CAP) list.length = RECENT_CAP;
  saveRecentRecipients(userNN, list);
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
          res.end('<h2>사용자 슬롯 부족</h2><p>모든 슬롯(01~16)이 할당되어 있습니다.</p><a href="/">돌아가기</a>');
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

      /* Set-Cookie는 배열로 넘겨야 각 쿠키가 별개 헤더로 전송됨.
         이전엔 .join(', ')로 합쳐서 브라우저가 쿠키 하나만 파싱하는 버그 있었음. */
      res.writeHead(302, {
        Location: redirectUrl,
        'Set-Cookie': [
          `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400`,
          `user_email=${encodeURIComponent(email)}; Path=/; Max-Age=86400`,
          `user_name=${encodeURIComponent(name)}; Path=/; Max-Age=86400`,
          `user_nn=${userNN}; Path=/; Max-Age=86400`,
          `gateway_token=${token}; Path=/; Max-Age=86400`,
        ],
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
        'session=; Path=/; Max-Age=0',
        'user_email=; Path=/; Max-Age=0',
        'user_name=; Path=/; Max-Age=0',
        'user_nn=; Path=/; Max-Age=0',
        'gateway_token=; Path=/; Max-Age=0',
      ],
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ===== Admin DB API (Phase 1, SQLite 메타 인덱스) =====

  // GET /api/admin/db/users
  if (req.method === 'GET' && url.pathname === '/api/admin/db/users') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const db = getAdminDb();
      if (!db) { jsonRes(res, 503, { ok: false, error: 'admin-db not ready' }); return; }
      const rows = db.prepare(`
        SELECT u.slot, u.email, u.name, u.status, u.updated_at,
               (SELECT COUNT(*) FROM agents a WHERE a.user_slot = u.slot AND a.status = 'active') AS agent_count,
               (SELECT COUNT(*) FROM sessions s WHERE s.user_slot = u.slot AND s.status = 'active') AS session_count
        FROM users u
        ORDER BY u.slot
      `).all();
      jsonRes(res, 200, { ok: true, users: rows });
    } catch (e) {
      jsonRes(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // GET /api/admin/db/sessions?user=01&status=active
  if (req.method === 'GET' && url.pathname === '/api/admin/db/sessions') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const db = getAdminDb();
      if (!db) { jsonRes(res, 503, { ok: false, error: 'admin-db not ready' }); return; }
      const u = url.searchParams.get('user') || null;
      const st = url.searchParams.get('status') || null;
      let q = 'SELECT id, session_key, user_slot, agent_id, status, is_main, message_count, total_tokens, last_active_at FROM sessions WHERE 1=1';
      const params = [];
      if (u) { q += ' AND user_slot = ?'; params.push(u); }
      if (st) { q += ' AND status = ?'; params.push(st); }
      q += ' ORDER BY last_active_at DESC LIMIT 500';
      const rows = db.prepare(q).all(...params);
      jsonRes(res, 200, { ok: true, sessions: rows });
    } catch (e) {
      jsonRes(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // GET /api/admin/db/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&user=NN
  if (req.method === 'GET' && url.pathname === '/api/admin/db/usage') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const db = getAdminDb();
      if (!db) { jsonRes(res, 503, { ok: false, error: 'admin-db not ready' }); return; }
      const from = url.searchParams.get('from') || '1970-01-01';
      const to = url.searchParams.get('to') || '9999-12-31';
      const user = url.searchParams.get('user') || null;
      let q = `
        SELECT user_slot, date, model,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read) AS cache_read,
               SUM(cache_write) AS cache_write,
               SUM(message_count) AS message_count,
               SUM(cost_usd) AS cost_usd,
               SUM(cost_krw) AS cost_krw
        FROM api_usage_daily
        WHERE date BETWEEN ? AND ?`;
      const params = [from, to];
      if (user) { q += ' AND user_slot = ?'; params.push(user); }
      q += ' GROUP BY user_slot, date, model ORDER BY date DESC, user_slot, model';
      const rows = db.prepare(q).all(...params);
      jsonRes(res, 200, { ok: true, usage: rows });
    } catch (e) {
      jsonRes(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // GET /api/admin/db/fx (latest USD→KRW)
  if (req.method === 'GET' && url.pathname === '/api/admin/db/fx') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const db = getAdminDb();
      if (!db) { jsonRes(res, 503, { ok: false, error: 'admin-db not ready' }); return; }
      const row = db.prepare(`
        SELECT currency, to_currency, rate, fetched_at, source
        FROM fx_rates
        WHERE currency = 'USD'
        ORDER BY fetched_at DESC LIMIT 1
      `).get();
      jsonRes(res, 200, { ok: true, fx: row || null });
    } catch (e) {
      jsonRes(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  /* GET /api/work-report/businesses — 사업 마스터 (공용 · 관리자가 파일로 관리) */
  if (req.method === 'GET' && url.pathname === '/api/work-report/businesses') {
    try {
      const d = JSON.parse(fs.readFileSync('/opt/openclaw/data/businesses.json', 'utf8'));
      jsonRes(res, 200, { ok: true, businesses: d.businesses || [], all_access: d.all_access || [] });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* POST /api/calendar/search — 기간 지정 일정 조회.
     gog CLI 는 `calendar list [일수]` 로 **미래만** 본다(음수 무효, search 도 미래 30일).
     주간보고는 지나간 한 주를 정리하는 일이라 과거를 못 읽으면 수집이 무의미하다(실측).
     Body: { userNN, timeMin, timeMax } (YYYY-MM-DD) */
  if (req.method === 'POST' && url.pathname === '/api/calendar/search') {
    try {
      const body = await parseBody(req);
      const nn = resolveUserNN(req, body.userNN);
      if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
      const accessToken = await getValidAccessToken(nn);
      if (!accessToken) { jsonRes(res, 401, { ok: false, error: 'google not linked' }); return; }
      const tMin = new Date(`${body.timeMin || '1970-01-01'}T00:00:00+09:00`).toISOString();
      const tMax = new Date(`${body.timeMax || '2999-12-31'}T23:59:59+09:00`).toISOString();
      const qs = new URLSearchParams({
        timeMin: tMin, timeMax: tMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      });
      // 공휴일 달력(ko.south_korea#holiday@group.v.calendar.google.com)을 조회하려면
      // calendarId 를 받아야 한다 — 브리핑이 휴일에 안 오게 하는 데 쓴다.
      const calId = encodeURIComponent(body.calendarId || 'primary');
      const apiUrl = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${qs}`;
      const out = await gmailApiRequest('GET', apiUrl, accessToken);   // 같은 OAuth 토큰을 쓴다
      if (out.status >= 400) { jsonRes(res, out.status, { ok: false, error: out.data?.error?.message || 'calendar api error' }); return; }
      const events = (out.data?.items || []).map(e => ({
        id: e.id,
        title: e.summary || '',
        start: e.start?.dateTime || e.start?.date || '',
        end: e.end?.dateTime || e.end?.date || '',
        allDay: !e.start?.dateTime,
        status: e.status,
        organizer: e.organizer?.email || '',
        htmlLink: e.htmlLink || '',
        creator: e.creator?.email || '',
      }));
      jsonRes(res, 200, { ok: true, count: events.length, events });
    } catch (e) {
      jsonRes(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  /* POST /api/figma/resolve — 붙여넣은 URL 에서 파일 키를 뽑고 파일명을 조회한다.
     피그마는 **사용자 기준 파일 목록 API 가 없고**(명세 확인), 팀·폴더 조회는 관리자 권한이 필요해
     일반 멤버 토큰으로는 403 이다. 그래서 파일을 개별 등록할 수밖에 없다 —
     대신 URL 만 붙여넣으면 되도록 키 추출·이름 조회를 서버가 대신한다.
     Body: { userNN, urls: "여러 줄" } */
  if (req.method === 'POST' && url.pathname === '/api/figma/resolve') {
    try {
      const body = await parseBody(req);
      const nn = resolveUserNN(req, body.userNN);
      if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
      const integ = JSON.parse(fs.readFileSync(`/opt/openclaw/data/user${nn}/integrations.json`, 'utf8'));
      const token = integ?.figma?.token;
      if (!token) { jsonRes(res, 400, { ok: false, error: '피그마 토큰을 먼저 저장해주세요' }); return; }
      // /design/<key>/ 또는 /file/<key>/ — node-id 같은 쿼리는 무시한다(같은 파일의 다른 페이지일 뿐)
      const keys = [...new Set(
        [...String(body.urls || '').matchAll(/\/(?:design|file|board|slides)\/([A-Za-z0-9]{10,})/g)].map(m => m[1]),
      )];
      const files = [];
      for (const key of keys) {
        const meta = await figmaApi(`/v1/files/${key}?depth=1`, token);
        files.push({ key, name: meta?.name || '(이름 조회 실패)', ok: !!meta?.name });
      }
      jsonRes(res, 200, { ok: true, files });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* GET /api/agent-aliases — 에이전트 이름으로 안 잡히는 말투 보완용 별칭.
     openclaw.json 의 agents.list[].aliases 는 스키마가 거부하므로(재시작 루프) 별도 파일로 둔다.
     두레이 데몬은 파일을 직접 읽지만 화면은 브라우저에서 도니 API 가 필요하다. */
  if (req.method === 'GET' && url.pathname === '/api/agent-aliases') {
    const nn = resolveUserNN(req, url.searchParams.get('userNN'));
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const raw = JSON.parse(fs.readFileSync(`/opt/openclaw/data/user${nn}/agent-aliases.json`, 'utf8'));
      const aliases = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith('_') && Array.isArray(v)) aliases[k] = v;   // _comment 등 메타 키 제외
      }
      jsonRes(res, 200, { ok: true, aliases });
    } catch (e) { jsonRes(res, 200, { ok: true, aliases: {} }); }     // 파일이 없으면 별칭 없음 = 정상
    return;
  }

  /* GET /api/work-report/draft?week=2026-W33 — 초안 원본.
     화면이 exec 결과(build_draft.py 출력)를 보고 이걸 불러와 카드를 그린다.
     모델에게 카드 블록을 출력하게 시켰더니 매번 자기 말로 요약해 카드가 아예 안 나왔다(실측 5회+).
     스크립트 실행은 반드시 일어나므로, 카드 렌더를 모델 출력에서 떼어낸다. */
  if (req.method === 'GET' && url.pathname === '/api/work-report/draft') {
    // ⚠ 2번째 인자는 **문자열 userNN** 이다. url 객체를 넘기면 컨테이너 밖 호출에서
    // 그 객체가 그대로 경로에 박혀 404 가 난다 (브라우저는 nginx 를 거쳐 오므로 IP 매핑이 안 된다).
    const nn = resolveUserNN(req, url.searchParams.get('userNN'));
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    // week 생략 시 현재 주차 — 화면은 exec 실행만 감지하므로 주차를 모른다
    let week = (url.searchParams.get('week') || '').trim();
    if (!week) {
      const d = new Date();
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
      const y = t.getUTCFullYear();
      const w = Math.ceil(((t - new Date(Date.UTC(y, 0, 1))) / 86400000 + 1) / 7);
      week = `${y}-W${String(w).padStart(2, '0')}`;
    }
    if (!/^\d{4}-W\d{2}$/.test(week)) { jsonRes(res, 400, { ok: false, error: 'bad week' }); return; }
    try {
      const p = `/opt/openclaw/data/user${nn}/work-report/drafts/draft-${week}.json`;
      jsonRes(res, 200, { ok: true, draft: JSON.parse(fs.readFileSync(p, 'utf8')) });
    } catch (e) { jsonRes(res, 404, { ok: false, error: 'draft not found' }); }
    return;
  }

  /* PUT /api/work-report/draft — 카드에서 고친 항목을 초안 파일에 반영.
     화면 편집을 모델에게 시키면 한글을 새로 써서 글자가 깨지고(업무→업묵) 출처가 사라진다(실측).
     그래서 화면이 파일을 직접 고치고, 발송(send_report.py)은 그 파일만 읽는다.
     ⚠ profile·recipients·period 는 절대 받지 않는다 — 화면에서 수신자를 바꿀 수 있으면
       메일이 엉뚱한 곳으로 나간다. 서버에 있는 값을 그대로 둔다. */
  if (req.method === 'PUT' && url.pathname === '/api/work-report/draft') {
    const nn = resolveUserNN(req, url.searchParams.get('userNN'));
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const week = (url.searchParams.get('week') || '').trim();
    if (!/^\d{4}-W\d{2}$/.test(week)) { jsonRes(res, 400, { ok: false, error: 'bad week' }); return; }
    readBody(req).then(raw => {
      const body = JSON.parse(raw || '{}');   // readBody 는 문자열을 준다
      const p = `/opt/openclaw/data/user${nn}/work-report/drafts/draft-${week}.json`;
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
      const STATUS = new Set(['done', 'wip', 'next']);
      const PASSTHRU = ['n', 'source', 'biz_id', 'at', 'url', 'raw_text', 'project',
                        'folder', 'screens', 'frame_count', 'figma_file', 'figma_page',
                        'polished'];
      const cleanItem = (it) => ({
        text: String(it?.text || '').trim().slice(0, 300),
        status: STATUS.has(it?.status) ? it.status : 'done',
        // 출처는 화면에서 만들 수 없다 — 있는 것만 살린다 (증적을 지어내면 기관에 그대로 나간다)
        sources: Array.isArray(it?.sources)
          ? it.sources.filter(s => s && s.source).map(s => ({ source: String(s.source), url: s.url || null }))
          : [],
        ...(it?.carry ? { carry: true } : {}),
        ...(it?.merged_count ? { merged_count: it.merged_count } : {}),
        /* 파이프라인이 만든 메타는 그대로 돌려준다 — 화면이 지어낸 값이 아니라
           서버가 준 것을 되돌려받는 것이다. 잘라내면 이런 일이 생긴다(실측 2026-08-28):
             n 이 사라져 polish.py 가 번호로 항목을 못 찾고 finish.py 는 KeyError 로 죽음
             polished 가 사라져 이미 다듬은 항목이 다시 게이트에 걸림
             folder·screens·raw_text 가 사라져 다듬기가 쓸 재료를 잃음 */
        ...PASSTHRU.reduce((o, k) => (it?.[k] === undefined ? o : (o[k] = it[k], o)), {}),
      });
      const cleanItems = (arr) => (Array.isArray(arr) ? arr : []).map(cleanItem).filter(x => x.text);
      if (Array.isArray(body.businesses)) {
        const byId = new Map(body.businesses.map(b => [String(b.id), b]));
        const known = new Set((cur.businesses || []).map(b => String(b.id)));
        cur.businesses = (cur.businesses || []).map(b => ({
          ...b, items: cleanItems(byId.get(String(b.id))?.items),
        }));
        // 초안에 없던 사업으로 옮긴 항목은 그룹을 새로 만들어 받는다.
        // 예전에는 서버 목록만 썼기 때문에 **옮긴 항목이 저장에서 통째로 사라졌다.**
        // 단 사업을 화면에서 창작할 수는 없다 — biz_options(서버가 정한 후보)에 있는 것만 허용.
        const opts = new Map((cur.biz_options || []).map(o => [String(o.id), o]));
        for (const b of body.businesses) {
          const id = String(b?.id);
          if (!id || known.has(id)) continue;
          const items = cleanItems(b.items);
          const opt = opts.get(id);
          if (!opt) {
            // 알 수 없는 사업. 그냥 건너뛰면 **그 안의 항목이 조용히 사라진다**
            // (요청 본문에서는 원래 사업에서 이미 빠져 있기 때문. 실측으로 1건 유실 확인).
            if (items.length) {
              jsonRes(res, 400, { ok: false, error: `알 수 없는 사업(${id})으로 옮기려 해 저장하지 않았습니다` });
              return;
            }
            continue;
          }
          if (!items.length) continue;          // 빈 그룹은 만들지 않는다
          cur.businesses.push({ id: opt.id, name: opt.name, alias: opt.alias, items });
        }
      }
      if (Array.isArray(body.common)) cur.common = cleanItems(body.common);
      if (Array.isArray(body.ai)) cur.ai = cleanItems(body.ai);
      cur.edited_at = new Date().toISOString();
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
      // ⚠ 이 API 는 root 로 돈다. 그대로 두면 파일이 root 소유가 되어 컨테이너(node,
      //   uid 1000)가 다음 수집 때 덮어쓰지 못한다(실측: "draft 파일이 root 소유라 쓰기가 안 됩니다").
      try { fs.chownSync(tmp, 1000, 1000); } catch (err) { console.warn('[wr] chown failed:', err.message); }
      fs.renameSync(tmp, p);   // 원자적 교체 — 발송이 반쯤 쓰인 파일을 읽지 않게
      jsonRes(res, 200, { ok: true, draft: cur });
    }).catch(e => jsonRes(res, e.code === 'ENOENT' ? 404 : 500, { ok: false, error: e.message }));
    return;
  }

  /* GET /api/work-report/config — 개인 설정 + 내 담당 사업(마스터 역참조) */
  if (req.method === 'GET' && url.pathname === '/api/work-report/config') {
    const nn = resolveUserNN(req, url);
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const cfg = JSON.parse(fs.readFileSync(`/opt/openclaw/data/user${nn}/work-report/config.json`, 'utf8'));
      const master = JSON.parse(fs.readFileSync('/opt/openclaw/data/businesses.json', 'utf8'));
      const mine = (master.businesses || []).filter(b => (b.members || []).includes(nn));
      jsonRes(res, 200, { ok: true, config: cfg, businesses: mine });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* PUT /api/work-report/config — tools·recipients·schedule·profile 만 (담당 사업은 관리자 전용) */
  if (req.method === 'PUT' && url.pathname === '/api/work-report/config') {
    const nn = resolveUserNN(req, url);
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    readBody(req).then(raw => {
      // readBody 는 문자열을 준다 — 파싱하지 않으면 body.tools 가 undefined 라
      // 무엇을 보내도 조용히 아무것도 저장되지 않는다
      const body = JSON.parse(raw || '{}');
      const p = `/opt/openclaw/data/user${nn}/work-report/config.json`;
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(body.tools)) cur.tools = body.tools.filter(t => t !== 'sr');  /* SR 영구 차단 */
      if (body.recipients) cur.recipients = body.recipients;
      if (body.schedule) cur.schedule = body.schedule;
      if (body.profile) cur.profile = body.profile;
      fs.writeFileSync(p, JSON.stringify(cur, null, 2));
      jsonRes(res, 200, { ok: true, config: cur });
    }).catch(e => jsonRes(res, 500, { ok: false, error: e.message }));
    return;
  }

  // GET /api/admin/keys — Moonshot 멀티키 상태 (마스킹 + live/suspended 체크)
  if (req.method === 'GET' && url.pathname === '/api/admin/keys') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const rawList = (process.env.MOONSHOT_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
      const primary = (process.env.MOONSHOT_API_KEY || '').trim();
      const keys = rawList.length > 0 ? rawList : (primary ? [primary] : []);
      const masked = (k) => k.length > 14 ? `${k.slice(0,8)}…${k.slice(-4)}` : '***';

      // 각 키 ping (Moonshot chat completions로 빠른 1토큰 호출)
      const pingKey = (key) => new Promise((resolve) => {
        const data = JSON.stringify({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
        const req2 = https.request({
          method: 'POST', hostname: 'api.moonshot.ai', path: '/v1/chat/completions',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 8000,
        }, (resp) => {
          const bodyChunks = [];
          resp.on('data', chunk => { bodyChunks.push(chunk); });
          resp.on('end', () => {
        const body = Buffer.concat(bodyChunks).toString('utf8');
            let status = 'unknown';
            let reason = null;
            if (resp.statusCode === 200) status = 'live';
            else if (resp.statusCode === 401 || resp.statusCode === 403) { status = 'auth_error'; }
            else if (resp.statusCode === 429) {
              status = 'suspended_or_rate_limit';
              try { const j = JSON.parse(body); reason = j.error?.message || null; } catch {}
            } else status = `http_${resp.statusCode}`;
            resolve({ status, httpCode: resp.statusCode, reason });
          });
        });
        req2.on('error', e => resolve({ status: 'network_error', reason: e.message }));
        req2.on('timeout', () => { req2.destroy(); resolve({ status: 'timeout' }); });
        req2.write(data);
        req2.end();
      });

      /* Anthropic ping — Moonshot 과 실패 표현이 다르다:
         크레딧 소진이 429 가 아니라 400 + "credit balance is too low" 로 온다.
         잔액 조회 API 가 없어서 금액은 못 보여주고, 살아있는지 + 분당 한도만 확인 가능.
         조직/워크스페이스 ID 는 응답 헤더로만 나온다 (에러 응답에도 실려 옴). */
      const pingAnthropic = (key) => new Promise((resolve) => {
        const data = JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        });
        const req2 = https.request({
          method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
          timeout: 10000,
        }, (resp) => {
          const bodyChunks = [];
          resp.on('data', chunk => { bodyChunks.push(chunk); });
          resp.on('end', () => {
        const body = Buffer.concat(bodyChunks).toString('utf8');
            const h = resp.headers;
            let status = 'unknown';
            let reason = null;
            if (resp.statusCode === 200) status = 'live';
            else if (resp.statusCode === 401 || resp.statusCode === 403) status = 'auth_error';
            else if (resp.statusCode === 429) status = 'rate_limit';
            else {
              try { reason = JSON.parse(body).error?.message || null; } catch { /* noop */ }
              /* 크레딧 소진은 400 으로 온다 — Moonshot 분류(429=한도)와 다르므로 별도 상태 */
              status = (reason && /credit balance is too low/i.test(reason))
                ? 'credit_exhausted'
                : `http_${resp.statusCode}`;
            }
            resolve({
              status, httpCode: resp.statusCode, reason,
              orgId: h['anthropic-organization-id'] || null,
              workspaceId: h['anthropic-workspace-id'] || null,
              limits: h['anthropic-ratelimit-requests-limit'] ? {
                requests: h['anthropic-ratelimit-requests-limit'],
                inputTokens: h['anthropic-ratelimit-input-tokens-limit'] || null,
                outputTokens: h['anthropic-ratelimit-output-tokens-limit'] || null,
              } : null,
            });
          });
        });
        req2.on('error', e => resolve({ status: 'network_error', reason: e.message }));
        req2.on('timeout', () => { req2.destroy(); resolve({ status: 'timeout' }); });
        req2.write(data);
        req2.end();
      });

      /* 어느 사용자가 Anthropic 을 primary 로 쓰는지 (openclaw.json 스캔).
         16명 중 일부만 쓰므로, 장애 시 영향 범위를 바로 알 수 있어야 한다. */
      const anthropicUsers = [];
      for (let i = 1; i <= 16; i++) {
        const nn = String(i).padStart(2, '0');
        try {
          const cfg = fs.readFileSync(`/opt/openclaw/data/user${nn}/openclaw.json`, 'utf8');
          if (/"primary"\s*:\s*"anthropic\//.test(cfg)) anthropicUsers.push(`user${nn}`);
        } catch { /* 없는 슬롯 무시 */ }
      }

      /* 최근 24h 동안 Anthropic 이 실제로 반환한 에러를 컨테이너 로그에서 수집.
         ping 은 "지금 이 순간"만 보여주므로, 간헐적 실패·과거 장애는 이걸로만 보인다.
         (8/3~8/4 크레딧 소진 때 화면상 정상으로 보였던 게 이 정보가 없어서였음) */
      const collectAnthropicErrors = (users) => Promise.all(users.map(u => new Promise((resolve) => {
        execFile('docker', ['logs', `openclaw-${u}`, '--since', '24h'],
          { maxBuffer: 32 * 1024 * 1024, timeout: 15000 },
          (err, stdout, stderr) => {
            const out = `${stdout || ''}\n${stderr || ''}`;
            const rows = [];
            for (const line of out.split('\n')) {
              if (!/provider=anthropic/.test(line) || !/isError=true/.test(line)) continue;
              const time = (line.match(/^(\d{4}-\d{2}-\d{2}T[\d:]{8})/) || [])[1] || null;
              let msg = (line.match(/error=(.*?)(?:\s+rawError=|$)/) || [])[1] || line.slice(0, 200);
              msg = msg.trim().slice(0, 300);
              const httpCode = (line.match(/rawError=(\d{3})/) || [])[1] || null;
              rows.push({ time, user: u, message: msg, httpCode });
            }
            resolve(rows);
          });
      }))).then(all => {
        const flat = all.flat().sort((a, b) => String(b.time).localeCompare(String(a.time)));
        const byMessage = {};
        for (const r of flat) {
          const k = r.message.slice(0, 80);
          byMessage[k] = (byMessage[k] || 0) + 1;
        }
        return {
          count: flat.length,
          lastAt: flat.length ? flat[0].time : null,
          recent: flat.slice(0, 15),
          summary: Object.entries(byMessage)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([message, n]) => ({ message, count: n })),
        };
      }).catch(() => null);

      const antKey = (process.env.ANTHROPIC_API_KEY || '').trim();

      Promise.all([
        Promise.all(keys.map((k, i) => pingKey(k).then(r => ({
          label: `key${i + 1}`,
          masked: masked(k),
          ...r,
        })))),
        antKey ? pingAnthropic(antKey) : Promise.resolve(null),
        anthropicUsers.length ? collectAnthropicErrors(anthropicUsers) : Promise.resolve(null),
      ]).then(([results, ant, antErrors]) => {
        jsonRes(res, 200, {
          ok: true,
          provider: 'moonshot',
          count: keys.length,
          mode: keys.length > 1 ? 'round-robin' : 'single',
          keys: results,
          /* 기존 필드는 그대로 두고 anthropic 만 덧붙임 (프론트 하위호환) */
          anthropic: antKey
            ? { masked: masked(antKey), users: anthropicUsers, ...ant, errors: antErrors }
            : null,
        });
      }).catch(e => jsonRes(res, 500, { ok: false, error: e.message }));
    } catch (e) {
      jsonRes(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ===== Admin API =====

  // GET /api/admin/users
  /* ── 사업 마스터 (/opt/openclaw/data/businesses.json) ─────────────────────
     한 파일을 16명이 공유한다. owners/supporters 를 바꾸면 그 사람의 주간보고 내용이
     바뀌므로 관리자만 만진다. 양식 검증은 여기서 한다 — 화면에서만 막으면
     API 를 직접 부르는 경로로 깨진 데이터가 들어온다. */
  const BIZ_PATH = '/opt/openclaw/data/businesses.json';
  const loadBiz = () => JSON.parse(fs.readFileSync(BIZ_PATH, 'utf8'));
  const saveBiz = (doc) => {
    const tmp = `${BIZ_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    try { fs.chownSync(tmp, 1000, 1000); } catch {}
    fs.renameSync(tmp, BIZ_PATH);      // 원자적 교체 — 수집이 반쯤 쓰인 파일을 읽지 않게
  };
  const normKey = (v) => String(v || '').toLowerCase().replace(/[\s()[\]·・,.\-_/]+/g, '');

  /** 저장 전 검증. 통과하면 정규화된 사업 객체를, 아니면 에러 문자열을 돌려준다. */
  function validateBiz(input, doc, selfId) {
    const others = (doc.businesses || []).filter(b => b.id !== selfId && !b.closed);
    const name = String(input.name || '').trim();
    const alias = String(input.alias || '').trim();
    const org = String(input.org || '').trim();
    if (!name) return { error: '사업명을 입력하세요' };
    if (!alias) return { error: '별칭을 입력하세요 — 수집이 이 별칭으로 사업을 찾습니다' };
    if (alias.length < 2) return { error: '별칭은 2자 이상이어야 합니다 (짧으면 엉뚱한 항목이 붙습니다)' };
    if (!org) return { error: '발주처를 입력하세요' };
    if (others.some(b => normKey(b.name) === normKey(name))) return { error: `이미 있는 사업명입니다: ${name}` };

    const aliases = (Array.isArray(input.aliases) ? input.aliases : [])
      .map(a => String(a || '').trim()).filter(Boolean);
    const mine = [alias, ...aliases].map(normKey);
    if (new Set(mine).size !== mine.length) return { error: '별칭이 중복됩니다' };
    for (const b of others) {
      for (const a of [b.alias, ...(b.aliases || [])]) {
        if (a && mine.includes(normKey(a))) return { error: `다른 사업이 쓰는 별칭입니다: ${a} (${b.name})` };
      }
    }

    const validNN = (v) => /^\d{2}$/.test(v) && +v >= 1 && +v <= 16;
    const owners = [...new Set((input.owners || []).map(String))];
    const supporters = [...new Set((input.supporters || []).map(String))];
    if (owners.length === 0) return { error: '담당자를 한 명 이상 지정하세요' };
    for (const v of [...owners, ...supporters]) {
      if (!validNN(v)) return { error: `사용자 번호가 올바르지 않습니다: ${v}` };
    }
    const dup = owners.filter(v => supporters.includes(v));
    if (dup.length) return { error: `담당자와 지원자에 같이 들어간 사람이 있습니다: ${dup.join(', ')}` };

    const dooray = String(input.dooray_project_id || '').trim();
    if (dooray && !/^\d+$/.test(dooray)) return { error: '두레이 프로젝트 ID는 숫자입니다' };
    const figma = (Array.isArray(input.figma_file_keys) ? input.figma_file_keys : [])
      .map(k => String(k || '').trim()).filter(Boolean);
    for (const k of figma) {
      if (!/^[A-Za-z0-9]{10,}$/.test(k)) return { error: `피그마 파일 키 형식이 아닙니다: ${k}` };
    }

    return {
      biz: {
        name, alias, org,
        ...(aliases.length ? { aliases } : {}),
        owners, supporters,
        members: [...new Set([...owners, ...supporters])],   // 항상 유도한다 — 손으로 넣으면 어긋난다
        dooray_project_id: dooray,
        figma_file_keys: figma,
        ...(input.kind === 'service' ? { kind: 'service' } : {}),
      },
    };
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/businesses') {
    if (!getAuthSession(req)) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const doc = loadBiz();
      jsonRes(res, 200, { ok: true, businesses: doc.businesses || [], all_access: doc.all_access || [] });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/businesses') {
    if (!getAuthSession(req)) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    readBody(req).then(raw => {
      const input = JSON.parse(raw || '{}');
      const doc = loadBiz();
      const v = validateBiz(input, doc, null);
      if (v.error) { jsonRes(res, 400, { ok: false, error: v.error }); return; }
      // id 는 사용자가 못 정한다 — 자사 서비스는 svc-, 수주 사업은 biz-
      const prefix = input.kind === 'service' ? 'svc' : 'biz';
      const used = (doc.businesses || []).filter(b => b.id.startsWith(`${prefix}-`))
        .map(b => parseInt(b.id.slice(prefix.length + 1), 10) || 0);
      const id = `${prefix}-${String(Math.max(0, ...used) + 1).padStart(2, '0')}`;
      doc.businesses = [...(doc.businesses || []), { id, ...v.biz }];
      saveBiz(doc);
      jsonRes(res, 200, { ok: true, id, businesses: doc.businesses });
    }).catch(e => jsonRes(res, 500, { ok: false, error: e.message }));
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/businesses') {
    if (!getAuthSession(req)) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    readBody(req).then(raw => {
      const input = JSON.parse(raw || '{}');
      const doc = loadBiz();
      // all_access 만 바꾸는 요청 (전 사업 분류 대상 — 디자이너·팀장급)
      if (Array.isArray(input.all_access) && !input.id) {
        const bad = input.all_access.filter(v => !/^\d{2}$/.test(String(v)));
        if (bad.length) { jsonRes(res, 400, { ok: false, error: `사용자 번호가 올바르지 않습니다: ${bad.join(', ')}` }); return; }
        doc.all_access = [...new Set(input.all_access.map(String))];
        saveBiz(doc);
        jsonRes(res, 200, { ok: true, all_access: doc.all_access });
        return;
      }
      const idx = (doc.businesses || []).findIndex(b => b.id === input.id);
      if (idx < 0) { jsonRes(res, 404, { ok: false, error: '없는 사업입니다' }); return; }
      const v = validateBiz(input, doc, input.id);
      if (v.error) { jsonRes(res, 400, { ok: false, error: v.error }); return; }
      const prev = doc.businesses[idx];
      doc.businesses[idx] = { id: prev.id, ...v.biz, ...(prev.closed ? { closed: true } : {}) };
      saveBiz(doc);
      jsonRes(res, 200, { ok: true, businesses: doc.businesses });
    }).catch(e => jsonRes(res, 500, { ok: false, error: e.message }));
    return;
  }

  /* 삭제가 아니라 '종료' 다 — 지우면 지난 보고서의 사업 태그가 깨진다.
     closed 는 수집·분류에서 제외되고 화면에서는 접힌 목록으로 남는다. */
  if (req.method === 'DELETE' && url.pathname === '/api/admin/businesses') {
    if (!getAuthSession(req)) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const id = url.searchParams.get('id');
    const reopen = url.searchParams.get('reopen') === '1';
    try {
      const doc = loadBiz();
      const b = (doc.businesses || []).find(x => x.id === id);
      if (!b) { jsonRes(res, 404, { ok: false, error: '없는 사업입니다' }); return; }
      if (reopen) delete b.closed; else b.closed = true;
      saveBiz(doc);
      jsonRes(res, 200, { ok: true, businesses: doc.businesses });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* POST /api/dooray/bot-test — 봇 URL 로 실제 메시지를 보내본다.
     저장만 하고 끝내면 잘못된 URL 을 며칠 뒤에야 알게 된다. */
  if (req.method === 'POST' && url.pathname === '/api/dooray/bot-test') {
    readBody(req).then(async raw => {
      const body = JSON.parse(raw || '{}');
      const nn = resolveUserNN(req, body.userNN);
      if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
      let botUrl = String(body.botUrl || '').trim();
      if (!botUrl) {
        try { botUrl = JSON.parse(fs.readFileSync(`/opt/openclaw/data/user${nn}/integrations.json`, 'utf8'))?.dooray?.botUrl || ''; } catch {}
      }
      if (!botUrl) { jsonRes(res, 400, { ok: false, error: '봇 URL 이 없습니다' }); return; }
      try {
        const r = await fetch(botUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botName: 'TideClaw', text: '연결 테스트입니다. 이 메시지가 보이면 알림이 정상입니다 ✅' }),
        });
        if (!r.ok) { jsonRes(res, 200, { ok: false, error: `두레이가 거절했습니다 (HTTP ${r.status})` }); return; }
        jsonRes(res, 200, { ok: true });
      } catch (e) { jsonRes(res, 200, { ok: false, error: e.message }); }
    }).catch(e => jsonRes(res, 500, { ok: false, error: e.message }));
    return;
  }

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
    for (let i = 1; i <= 16; i++) {
      const nn = String(i).padStart(2, '0');
      const email = slotToEmail[nn] || null;
      slots.push({
        slot: nn, email,
        name: email ? resolveName(email) : null,
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

  // POST /api/bid/logout — bid.tideflo.work 쿠키 삭제 + 탭 로그인 페이지로 이동
  if (url.pathname === '/api/bid/logout' && req.method === 'POST') {
    const params = await parseBody(req);
    const userNN = resolveBidUserNN(params);
    if (!userNN) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    const r = await runBidFetch(userNN, ['logout'], 15000);
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
      // 주석이 섞인 설정(JSONC)도 읽어야 한다 — user07·13 에는 temperature 금지 주석이 있다
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
      const agentList = (config.agents?.list || []).map(a => ({
        id: a.id, name: a.identity?.name || a.name || a.id,
        emoji: a.identity?.emoji || '', default: !!a.default,
        isDiscord: a.id.endsWith('-discord'),
        // 에이전트마다 다른 모델을 쓸 수 있다. 계정 기본값만 보여주면 실제와 달라진다.
        model: typeof a.model === 'string' ? a.model : (a.model?.primary || ''),
      }));
      const model = config.agents?.defaults?.model?.primary || 'unknown';
      const discordAccounts = Object.keys(config.channels?.discord?.accounts || {});
      jsonRes(res, 200, { ok: true, agents: agentList, model, discordAccounts });
    } catch {
      jsonRes(res, 200, { ok: true, agents: [], model: 'unconfigured', discordAccounts: [] });
    }
    return;
  }

  /* ========== 시스템 기능 배포 관리 (business-report 등) ==========
     매니페스트: /opt/openclaw/business-report-deploy/features.json
     등록 상태: /opt/openclaw/business-report-deploy/enrolled-users.json
     스크립트: enroll.sh / unenroll.sh
  */
  const BR_DEPLOY_DIR = '/opt/openclaw/business-report-deploy';

  function loadFeaturesManifest() {
    try { return JSON.parse(fs.readFileSync(path.join(BR_DEPLOY_DIR, 'features.json'), 'utf-8')); }
    catch { return { features: [] }; }
  }
  function loadEnrolledUsers() {
    try { return JSON.parse(fs.readFileSync(path.join(BR_DEPLOY_DIR, 'enrolled-users.json'), 'utf-8')); }
    catch { return {}; }
  }

  /* GET /api/admin/features — 매니페스트 + 각 사용자 활성화 상태 */
  if (req.method === 'GET' && url.pathname === '/api/admin/features') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const manifest = loadFeaturesManifest();
    const enrolled = loadEnrolledUsers();
    jsonRes(res, 200, { ok: true, features: manifest.features || [], enrolled });
    return;
  }

  /* POST /api/admin/features/enroll  body: { featureId, userNN } */
  if (req.method === 'POST' && url.pathname === '/api/admin/features/enroll') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const body = await parseBody(req);
      const featureId = String(body.featureId || '').trim();
      const userNN = String(body.userNN || '').trim();
      if (!featureId || !/^\d{2}$/.test(userNN)) {
        jsonRes(res, 400, { ok: false, error: 'featureId 와 userNN(2자리) 필수' }); return;
      }
      const script = path.join(BR_DEPLOY_DIR, 'enroll.sh');
      if (!fs.existsSync(script)) { jsonRes(res, 500, { ok: false, error: 'enroll.sh 없음' }); return; }
      const { execSync } = require('child_process');
      const out = execSync(`${script} ${userNN}`, { encoding: 'utf-8', timeout: 30000 });
      jsonRes(res, 200, { ok: true, log: out });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message, log: err.stdout || err.stderr });
    }
    return;
  }

  /* POST /api/admin/features/unenroll  body: { featureId, userNN } */
  if (req.method === 'POST' && url.pathname === '/api/admin/features/unenroll') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const body = await parseBody(req);
      const featureId = String(body.featureId || '').trim();
      const userNN = String(body.userNN || '').trim();
      if (!featureId || !/^\d{2}$/.test(userNN)) {
        jsonRes(res, 400, { ok: false, error: 'featureId 와 userNN(2자리) 필수' }); return;
      }
      const script = path.join(BR_DEPLOY_DIR, 'unenroll.sh');
      if (!fs.existsSync(script)) { jsonRes(res, 500, { ok: false, error: 'unenroll.sh 없음' }); return; }
      const { execSync } = require('child_process');
      const out = execSync(`${script} ${userNN}`, { encoding: 'utf-8', timeout: 30000 });
      jsonRes(res, 200, { ok: true, log: out });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message, log: err.stdout || err.stderr });
    }
    return;
  }

  /* POST /api/admin/features/deploy-updates  body: { featureId }
     중앙 SOUL/스크립트 변경 후 활성 사용자에게 전체 재배포 */
  if (req.method === 'POST' && url.pathname === '/api/admin/features/deploy-updates') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const body = await parseBody(req);
      const featureId = String(body.featureId || '').trim();
      if (!featureId) { jsonRes(res, 400, { ok: false, error: 'featureId 필수' }); return; }
      const manifest = loadFeaturesManifest();
      const feature = (manifest.features || []).find(f => f.id === featureId);
      if (!feature) { jsonRes(res, 404, { ok: false, error: '매니페스트에 없음' }); return; }
      const enrolled = loadEnrolledUsers();
      const users = enrolled[featureId] || [];
      const results = [];
      for (const nn of users) {
        const workspace = `/opt/openclaw/data/user${nn}/workspace-${featureId}`;
        try {
          fs.mkdirSync(workspace, { recursive: true });
          fs.copyFileSync(feature.soul_template, path.join(workspace, 'SOUL.md'));
          fs.chmodSync(path.join(workspace, 'SOUL.md'), 0o666);
          // 스크립트도 재배포
          const scriptsDir = `/opt/openclaw/shared/user${nn}/business-report/scripts`;
          fs.mkdirSync(scriptsDir, { recursive: true });
          for (const f of fs.readdirSync(feature.scripts_dir)) {
            fs.copyFileSync(path.join(feature.scripts_dir, f), path.join(scriptsDir, f));
            fs.chmodSync(path.join(scriptsDir, f), 0o755);
          }
          results.push({ userNN: nn, ok: true });
        } catch (e) {
          results.push({ userNN: nn, ok: false, error: e.message });
        }
      }
      jsonRes(res, 200, { ok: true, results, count: users.length });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
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
      totalSlots: 16,
      usersAssigned: Object.keys(loadUsers()).length,
      activeSessions: sessions.size,
    });
    return;
  }

  // GET /api/admin/usage — 사용자별 토큰/비용 집계
  // 쿼리: from=YYYY-MM-DD, to=YYYY-MM-DD, userNN=02 (선택), groupBy=day|week
  if (req.method === 'GET' && url.pathname === '/api/admin/usage') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }

    try {
      const today = new Date();
      const kst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
      const todayStr = kst.toISOString().slice(0, 10);
      const defaultFrom = new Date(kst.getTime() - 30 * 86400000).toISOString().slice(0, 10);

      const fromDate = url.searchParams.get('from') || defaultFrom;
      const toDate = url.searchParams.get('to') || todayStr;
      const filterUser = url.searchParams.get('userNN');
      const groupBy = url.searchParams.get('groupBy') || 'day';

      const usageBase = '/opt/openclaw/data/usage';
      const userList = filterUser
        ? [filterUser]
        : Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, '0'));

      const result = {};
      let grandTotal = { totalTokens: 0, costUsd: 0, costKrw: 0, messageCount: 0 };

      for (const nn of userList) {
        const dir = path.join(usageBase, `user${nn}`);
        if (!fs.existsSync(dir)) {
          result[nn] = { days: [], total: { totalTokens: 0, costUsd: 0, costKrw: 0, messageCount: 0 }, models: {} };
          continue;
        }
        const days = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const userDays = [];
        const userTotal = { totalTokens: 0, costUsd: 0, costKrw: 0, messageCount: 0 };
        const userModels = {};

        for (const fname of days) {
          const dk = fname.replace('.json', '');
          if (dk < fromDate || dk > toDate) continue;
          try {
            const day = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8'));
            userDays.push({
              date: dk,
              totalTokens: day.totalTokens || 0,
              costUsd: day.costUsd || 0,
              costKrw: day.costKrw || 0,
              messageCount: day.messageCount || 0,
              models: day.models || {},
            });
            userTotal.totalTokens += day.totalTokens || 0;
            userTotal.costUsd += day.costUsd || 0;
            userTotal.costKrw += day.costKrw || 0;
            userTotal.messageCount += day.messageCount || 0;
            for (const [m, mdata] of Object.entries(day.models || {})) {
              if (!userModels[m]) userModels[m] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, messageCount: 0, costUsd: 0 };
              for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'messageCount', 'costUsd']) {
                userModels[m][k] += mdata[k] || 0;
              }
            }
          } catch { /* skip corrupt */ }
        }
        userDays.sort((a, b) => a.date.localeCompare(b.date));

        // 주별 그루핑이면 ISO 주차로 묶기
        let groupedDays = userDays;
        if (groupBy === 'week') {
          const weekMap = new Map();
          for (const d of userDays) {
            const dt = new Date(d.date + 'T00:00:00Z');
            const dayOfWeek = (dt.getUTCDay() + 6) % 7; // 월=0
            const monday = new Date(dt.getTime() - dayOfWeek * 86400000);
            const weekKey = monday.toISOString().slice(0, 10);
            if (!weekMap.has(weekKey)) {
              weekMap.set(weekKey, { weekStart: weekKey, totalTokens: 0, costUsd: 0, costKrw: 0, messageCount: 0 });
            }
            const w = weekMap.get(weekKey);
            w.totalTokens += d.totalTokens;
            w.costUsd += d.costUsd;
            w.costKrw += d.costKrw;
            w.messageCount += d.messageCount;
          }
          groupedDays = Array.from(weekMap.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
        }

        result[nn] = { days: groupedDays, total: userTotal, models: userModels };
        grandTotal.totalTokens += userTotal.totalTokens;
        grandTotal.costUsd += userTotal.costUsd;
        grandTotal.costKrw += userTotal.costKrw;
        grandTotal.messageCount += userTotal.messageCount;
      }

      // 환율 + 단가 정보 함께 반환 (UI에서 표시용)
      let pricing = null;
      try { pricing = JSON.parse(fs.readFileSync('/opt/openclaw/config/usage-pricing.json', 'utf8')); } catch {}

      // 사용자 이메일 + 이름 매핑
      const usersMap = loadUsers();
      const slotEmails = {};
      const slotNames = {};
      for (const [email, nn] of Object.entries(usersMap)) {
        slotEmails[nn] = email;
        const name = resolveName(email);
        if (name) slotNames[nn] = name;
      }

      jsonRes(res, 200, {
        ok: true,
        from: fromDate,
        to: toDate,
        groupBy,
        users: result,
        slotEmails,
        slotNames,
        grandTotal,
        fx: pricing?.fx || null,
        models: pricing?.models || null,
      });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/admin/usage/refresh — 오늘 데이터 즉시 재집계
  if (req.method === 'POST' && url.pathname === '/api/admin/usage/refresh') {
    const auth = getAuthSession(req);
    if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    const { exec } = require('child_process');
    exec('node /opt/openclaw/scripts/usage-aggregator.mjs', { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) { jsonRes(res, 500, { ok: false, error: stderr || err.message }); return; }
      jsonRes(res, 200, { ok: true, output: stdout.slice(-500) });
    });
    return;
  }

  // ===== Mail API =====

  // POST /api/mail/send — 사용자 확인 대기열에 등록 (실제 발송은 send-confirm에서)
  // 봇이 어떤 에이전트로 동작하든, 어떤 프롬프트를 갖든 이 엔드포인트를 거치므로 사용자 확인 강제됨
  if (req.method === 'POST' && url.pathname === '/api/mail/send') {
    try {
      const params = await parseBody(req);
      const { userNN, to, cc, subject, body, bodyHtml, attachments } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!to || !subject) { jsonRes(res, 400, { ok: false, error: 'Missing to or subject' }); return; }

      const token = loadGoogleToken(userNN);
      if (!token?.email) { jsonRes(res, 400, { ok: false, error: `No email configured for user${userNN}` }); return; }

      // 받는 사람 이름 → 이메일 변환은 미리보기 단계에서도 적용 (사용자가 실제 발송될 주소를 보고 확정하도록)
      const resolvedTo = resolveEmail(to);
      const resolvedCc = cc ? resolveEmail(cc) : cc;

      const payload = { to: resolvedTo, cc: resolvedCc, subject, body, bodyHtml, attachments };
      const mailId = crypto.randomBytes(8).toString('hex');
      const confirmToken = crypto.randomBytes(16).toString('hex');
      pendingMails.set(mailId, { userNN, payload, confirmToken, createdAt: Date.now(), from: token.email });
      cleanupPendingMails();

      const preview = makeMailPreview(payload);
      console.log(`[mail] PENDING user${userNN} to=${preview.to} subject="${preview.subject}" mailId=${mailId}`);
      jsonRes(res, 200, {
        ok: true,
        pending: true,
        mailId,
        from: token.email,
        preview,
        ttlSeconds: Math.floor(MAIL_PENDING_TTL_MS / 1000),
        message: '⚠️ 메일은 아직 발송되지 않았습니다. 사용자가 워크플로 화면 상단의 [메일 발송 대기] 카드에서 [발송] 버튼을 클릭해야 실제로 발송됩니다. 10분 안에 확인하지 않으면 자동 취소됩니다. 봇은 사용자에게 "확인 후 발송 버튼을 눌러달라"고 안내하세요.',
      });
    } catch (err) {
      console.error('[mail] stage error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/mail/send-now — 컨펌 카드 우회, 즉시 발송 (cron/예약 메일 전용)
  // 채팅 컨텍스트에서 봇이 직접 호출하면 안 됨. BOOTSTRAP 룰로 통제.
  if (req.method === 'POST' && url.pathname === '/api/mail/send-now') {
    try {
      const params = await parseBody(req);
      const { userNN, to, cc, subject, body, bodyHtml, from, attachments } = params;
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!to || !subject) { jsonRes(res, 400, { ok: false, error: 'Missing to or subject' }); return; }
      const sent = await actuallySendMail(userNN, { to, cc, subject, body, bodyHtml, from, attachments });
      recordRecipientUse(userNN, to);
      if (cc) recordRecipientUse(userNN, cc);
      console.log(`[mail] SENT-NOW user${userNN} to=${to} subject="${subject}" messageId=${sent?.id || 'n/a'}`);
      jsonRes(res, 200, { ok: true, sent: true, messageId: sent?.id });
    } catch (err) {
      console.error('[mail] send-now error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/mail/send-confirm — pending 메일 실제 발송
  if (req.method === 'POST' && url.pathname === '/api/mail/send-confirm') {
    try {
      const params = await parseBody(req);
      const { mailId, confirmToken, overrides } = params;
      if (!mailId || !confirmToken) { jsonRes(res, 400, { ok: false, error: 'Missing mailId or confirmToken' }); return; }
      const m = pendingMails.get(mailId);
      if (!m) { jsonRes(res, 404, { ok: false, error: 'Mail not found or expired' }); return; }
      if (m.confirmToken !== confirmToken) { jsonRes(res, 403, { ok: false, error: 'Invalid confirmToken' }); return; }
      if (Date.now() - m.createdAt > MAIL_PENDING_TTL_MS) {
        pendingMails.delete(mailId);
        jsonRes(res, 410, { ok: false, error: 'Mail expired' });
        return;
      }
      // 사용자가 UI에서 수정한 내용이 있으면 그것으로 발송
      const finalPayload = overrides && typeof overrides === 'object'
        ? { ...m.payload, ...overrides }
        : m.payload;
      pendingMails.delete(mailId);
      const sent = await actuallySendMail(m.userNN, finalPayload);
      // 발송 성공 → 최근 수신자 기록 (UI 자동완성용)
      try {
        recordRecipientUse(m.userNN, finalPayload.to);
        if (finalPayload.cc) recordRecipientUse(m.userNN, finalPayload.cc);
      } catch (e) { console.error('[recent] record error:', e.message); }
      const week = getWeekRange();
      console.log(`[mail] CONFIRMED user${m.userNN} from=${sent.from} to=${sent.resolvedTo} subject="${sent.fixedSubject}" id=${sent.result.data.id}`);
      jsonRes(res, 200, { ok: true, messageId: sent.result.data.id, threadId: sent.result.data.threadId, from: sent.from, weekRange: `${week.monday}~${week.friday}`, today: week.today });
    } catch (err) {
      console.error('[mail] confirm error:', err.message);
      jsonRes(res, err.gmailStatus || 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/mail/cancel — 대기 중인 메일 취소
  if (req.method === 'POST' && url.pathname === '/api/mail/cancel') {
    try {
      const params = await parseBody(req);
      const { mailId, confirmToken } = params;
      if (!mailId) { jsonRes(res, 400, { ok: false, error: 'Missing mailId' }); return; }
      const m = pendingMails.get(mailId);
      if (!m) { jsonRes(res, 404, { ok: false, error: 'Mail not found' }); return; }
      if (confirmToken && m.confirmToken !== confirmToken) {
        jsonRes(res, 403, { ok: false, error: 'Invalid confirmToken' });
        return;
      }
      pendingMails.delete(mailId);
      console.log(`[mail] CANCELED user${m.userNN} mailId=${mailId}`);
      jsonRes(res, 200, { ok: true, mailId });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/mail/recipients?userNN=NN — 자동완성용 수신자 목록 (최근 사용자 + 직원록 머지)
  if (req.method === 'GET' && url.pathname === '/api/mail/recipients') {
    const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
    if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    const recent = loadRecentRecipients(userNN); // 최근순 정렬됨
    const seen = new Set(recent.map(r => r.email));
    const items = recent.map(r => ({ email: r.email, name: r.name || EMAIL_TO_NAME[r.email] || null, source: 'recent', lastUsed: r.lastUsed }));
    // 직원록에서 아직 안 보낸 사람 추가
    for (const [name, email] of Object.entries(MEMBER_MAP)) {
      if (seen.has(email)) continue;
      items.push({ email, name, source: 'employee', lastUsed: null });
    }
    jsonRes(res, 200, { ok: true, count: items.length, items });
    return;
  }

  // GET /api/mail/pending?userNN=NN — 해당 유저의 대기 메일 목록
  if (req.method === 'GET' && url.pathname === '/api/mail/pending') {
    const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
    if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
    cleanupPendingMails();
    const items = [];
    for (const [id, m] of pendingMails) {
      if (m.userNN !== userNN) continue;
      items.push({
        mailId: id,
        confirmToken: m.confirmToken,
        from: m.from,
        preview: makeMailPreview(m.payload),
        createdAt: m.createdAt,
        expiresAt: m.createdAt + MAIL_PENDING_TTL_MS,
      });
    }
    items.sort((a, b) => a.createdAt - b.createdAt);
    jsonRes(res, 200, { ok: true, count: items.length, items });
    return;
  }

  // GET /api/mail/search?userNN=01&q=from:me&max=10
  if (req.method === 'GET' && url.pathname === '/api/mail/search') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
  /* POST /api/drive/folder-names — 폴더 ID → 이름.
     "발표자료.pptx" 처럼 파일명만으로는 무슨 일인지 알 수 없다. 들어 있는 폴더 이름이
     맥락을 준다("진로역량교육/발표자료"). 파일마다 호출하면 느리므로 ID 를 모아 한 번에 받는다. */
  if (req.method === 'POST' && url.pathname === '/api/drive/folder-names') {
    try {
      const body = await parseBody(req);
      const userNN = resolveUserNN(req, body.userNN);
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const ids = [...new Set((body.ids || []).map(String))].slice(0, 60);
      const accessToken = await getValidAccessToken(userNN);
      const out = {};
      await Promise.all(ids.map(async id => {
        const r = await gmailApiRequest('GET',
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`,
          accessToken).catch(() => null);
        if (r && r.status < 400 && r.data?.name) out[id] = r.data.name;
      }));
      jsonRes(res, 200, { ok: true, names: out });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/drive/shared') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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

        /* 구글 드라이브가 간헐적으로 500 "Internal Error" 를 준다 (실측 5회 중 1회).
           같은 요청을 잠깐 뒤에 다시 보내면 대개 성공하므로 여기서 삼킨다.
           호출하는 쪽에서 재시도하면 앞 페이지부터 다시 받아야 해서 비싸다. */
        let result = await gmailApiRequest('GET', apiUrl, accessToken);
        for (let retry = 0; retry < 2 && (result.status >= 500 || result.status === 429); retry++) {
          await new Promise(r => setTimeout(r, 400 * (retry + 1)));
          result = await gmailApiRequest('GET', apiUrl, accessToken);
        }
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
              const dataChunks = [];
              r.on('data', chunk => { dataChunks.push(chunk); });
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
              const dataChunks = [];
              dlRes.on('data', chunk => { dataChunks.push(chunk); });
              dlRes.on('end', () => resolve(Buffer.concat(dataChunks).toString('utf8')));
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
  /* ===== Memories (per-user SQLite + FTS5) ===== */

  /* POST /api/memory/remember — body: { scope?, subject, body, tags?, source?, source_ref?, expires_at? }
     scope: 'general' | 'person:이름' | 'project:키' 등 자유 문자열. tags: string[] (JSON 직렬화). */
  if (req.method === 'POST' && url.pathname === '/api/memory/remember') {
    try {
      const params = await parseBody(req);
      const userNN = resolveUserNN(req, params.userNN || url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const subject = String(params.subject || '').trim();
      const body = String(params.body || '').trim();
      if (!subject || !body) { jsonRes(res, 400, { ok: false, error: 'subject + body 필수' }); return; }
      const scope = String(params.scope || 'general').trim().slice(0, 200);
      const tagsArr = Array.isArray(params.tags) ? params.tags.map(t => String(t)).slice(0, 20) : [];
      const tagsJson = tagsArr.length > 0 ? JSON.stringify(tagsArr) : null;
      const source = params.source ? String(params.source).slice(0, 50) : null;
      const sourceRef = params.source_ref ? String(params.source_ref).slice(0, 200) : null;
      const expiresAt = typeof params.expires_at === 'number' ? params.expires_at : null;

      const db = openMemoryDb(userNN);
      const info = db.prepare(`
        INSERT INTO memories(scope, subject, body, tags, source, source_ref, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(scope, subject, body, tagsJson, source, sourceRef, expiresAt);
      jsonRes(res, 200, { ok: true, id: info.lastInsertRowid, scope, subject });
    } catch (err) {
      console.error('[memory] remember error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* GET /api/memory/recall?q=...&scope=...&limit=10&since=...
     q: FTS5 검색어 (subject + body + tags 통합). 빈 query면 최신순. */
  if (req.method === 'GET' && url.pathname === '/api/memory/recall') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const q = (url.searchParams.get('q') || '').trim();
      const scope = (url.searchParams.get('scope') || '').trim();
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10) || 10));
      const since = parseInt(url.searchParams.get('since') || '', 10);

      const db = openMemoryDb(userNN);
      let rows;
      if (q) {
        /* FTS5 MATCH + LIKE fallback (한글 토큰화 한계 우회 + scope/subject/body/tags 통합 매칭) */
        const safeQ = q.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
        const ftsQ = safeQ.split(' ').filter(Boolean).map(t => `"${t}"`).join(' OR ');
        const likeQ = `%${safeQ}%`;
        const matchClause = `(
          m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)
          OR m.scope LIKE ?
          OR m.subject LIKE ?
          OR m.body LIKE ?
          OR m.tags LIKE ?
        )`;
        const where = [matchClause];
        const args = [ftsQ, likeQ, likeQ, likeQ, likeQ];
        if (scope) { where.push('m.scope = ?'); args.push(scope); }
        if (Number.isFinite(since)) { where.push('m.created_at >= ?'); args.push(since); }
        where.push('(m.expires_at IS NULL OR m.expires_at > ?)');
        args.push(Date.now());
        rows = db.prepare(`
          SELECT DISTINCT m.id, m.scope, m.subject, m.body, m.tags, m.source, m.created_at, m.last_used_at, m.use_count
          FROM memories m
          WHERE ${where.join(' AND ')}
          ORDER BY m.created_at DESC
          LIMIT ?
        `).all(...args, limit);
      } else {
        const where = ['(expires_at IS NULL OR expires_at > ?)'];
        const args = [Date.now()];
        if (scope) { where.push('scope = ?'); args.push(scope); }
        if (Number.isFinite(since)) { where.push('created_at >= ?'); args.push(since); }
        rows = db.prepare(`
          SELECT id, scope, subject, body, tags, source, created_at, last_used_at, use_count
          FROM memories
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ?
        `).all(...args, limit);
      }

      /* last_used_at + use_count 갱신 */
      if (rows.length > 0) {
        const ids = rows.map(r => r.id);
        const now = Date.now();
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id IN (${placeholders})`)
          .run(now, ...ids);
      }

      /* tags JSON → array */
      const items = rows.map(r => ({
        ...r,
        tags: r.tags ? safeJsonParse(r.tags, []) : [],
      }));
      jsonRes(res, 200, { ok: true, count: items.length, items });
    } catch (err) {
      console.error('[memory] recall error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* GET /api/memory/list?limit=20&offset=0 — 단순 시간순 페이지네이션 (관리/디버그용) */
  if (req.method === 'GET' && url.pathname === '/api/memory/list') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const db = openMemoryDb(userNN);
      const total = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
      const rows = db.prepare(`
        SELECT id, scope, subject, body, tags, source, created_at, last_used_at, use_count
        FROM memories
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
      const items = rows.map(r => ({ ...r, tags: r.tags ? safeJsonParse(r.tags, []) : [] }));
      jsonRes(res, 200, { ok: true, total, offset, limit, items });
    } catch (err) {
      console.error('[memory] list error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* POST /api/memory/suggest — body: { messages: [{ role, content }], hint? }
     비서한테 후보 추출 prompt 보내고 candidates JSON 응답. UI 모달용. */
  if (req.method === 'POST' && url.pathname === '/api/memory/suggest') {
    try {
      const params = await parseBody(req);
      const userNN = resolveUserNN(req, params.userNN || url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const messages = Array.isArray(params.messages) ? params.messages : [];
      if (messages.length === 0) { jsonRes(res, 400, { ok: false, error: 'messages 필수' }); return; }

      /* 대화 본문 합치기 (최근 30개 + 사용자/비서만, 시스템 raw 제외) */
      const trimmed = messages.slice(-30).filter(m => {
        const role = String(m.role || '');
        const c = String(m.content || '').trim();
        if (!c) return false;
        if (role !== 'user' && role !== 'assistant') return false;
        /* 명백한 시스템/도구 dump 마커 제외 (frontend filter와 비슷) */
        if (c.startsWith('System (untrusted)')) return false;
        if (c.includes('An async command you ran earlier')) return false;
        if (c.startsWith('[Bootstrap pending]')) return false;
        return true;
      });

      const transcript = trimmed.map(m => {
        const role = m.role === 'user' ? '사용자' : '비서';
        const content = String(m.content || '').slice(0, 1500);
        return `[${role}] ${content}`;
      }).join('\n\n');

      const hint = params.hint ? String(params.hint).slice(0, 500) : '';

      const systemPrompt = `너는 다음 대화에서 사용자가 장기적으로 기억할 만한 사실/약속/결정/관찰을 추출하는 보조 도구다.

규칙:
- 명백한 사실/결정/약속만 추출. 모호한 추측 금지.
- 한 항목은 1개의 결정/약속/사실에 대응.
- 사람 이름이 등장하면 scope를 "person:이름" 형식으로.
- 프로젝트나 시스템 이름이 등장하면 scope를 "project:키" 형식으로.
- 그 외는 scope = "general".
- subject는 한국어 한 줄 8~30자.
- body는 한국어 1~3문장.
- tags는 한국어 키워드 1~4개 (예: 미팅, 약속, 결정, 마감).
- expires_at_hint는 명확한 시간 제한이 있으면 ISO 8601 (YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm)으로. 없으면 null.
- 도구 호출 결과나 시스템 dump는 무시.
- 최대 5개. 없으면 빈 배열.

응답은 반드시 다음 JSON 단일 객체만 출력:
{"candidates":[{"scope":"...","subject":"...","body":"...","tags":["..."],"expires_at_hint":"..."|null}]}`;

      const userPrompt = `대화:\n\n${transcript}\n\n${hint ? `힌트: ${hint}\n\n` : ''}위 대화에서 기억할 후보를 추출해서 JSON으로 응답.`;

      const totalKeys = moonshotKeys().length;
      if (totalKeys === 0) { jsonRes(res, 503, { ok: false, error: 'MOONSHOT_API_KEY not set' }); return; }

      /* 메모리 추출 모델 우선순위: k2.5(빠르고 저렴) 우선, 다 fail이면 k2.6(큐 한산) fallback */
      const MEMORY_MODELS = ['kimi-k2.5', 'kimi-k2.6'];
      const MAX_RETRY_PER_MODEL = Math.min(totalKeys + 1, 4);

      let moonshotResult = { status: 599, body: 'no attempt' };
      let attemptsMade = 0;
      let usedModel = null;

      outer:
      for (const model of MEMORY_MODELS) {
        usedModel = model;
        const bodyForModel = JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 1,
          /* k2.6은 reasoning 사용해서 토큰 더 필요 — 모델별로 max_tokens 다르게 */
          max_tokens: model === 'kimi-k2.6' ? 4000 : 2000,
          response_format: { type: 'json_object' },
        });

        for (let attempt = 0; attempt < MAX_RETRY_PER_MODEL; attempt++) {
          const apiKey = nextMoonshotKey();
          if (!apiKey) break outer;
          attemptsMade++;
          moonshotResult = await new Promise((resolve) => {
            const req2 = https.request({
              method: 'POST',
              hostname: 'api.moonshot.ai',
              path: '/v1/chat/completions',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyForModel),
              },
              timeout: 90_000,
            }, (resp) => {
              let buf = '';
              resp.on('data', chunk => { bufChunks.push(chunk); });
              resp.on('end', () => resolve({ status: resp.statusCode, body: buf }));
            });
            req2.on('error', err => resolve({ status: 599, body: err.message }));
            req2.on('timeout', () => { req2.destroy(); resolve({ status: 598, body: 'timeout' }); });
            req2.write(bodyForModel);
            req2.end();
          });

          if (moonshotResult.status === 200) break outer;
          if (moonshotResult.status === 429 || moonshotResult.status === 401 || moonshotResult.status === 403) {
            markMoonshotKeyFail(apiKey);
            console.log(`[memory] suggest model=${model} attempt ${attempt + 1}/${MAX_RETRY_PER_MODEL} key=${apiKey.slice(0,8)}… status=${moonshotResult.status}`);
            continue;
          }
          /* 회복 불가능 (400 등) — 이 모델은 포기, 다음 모델로 */
          break;
        }
      }

      if (moonshotResult.status !== 200) {
        jsonRes(res, 502, {
          ok: false,
          error: moonshotResult.status === 429 ? 'k2.5/k2.6 모두 과부하 (잠시 후 다시)' : 'Moonshot 호출 실패',
          status: moonshotResult.status,
          model: usedModel,
          attempts: attemptsMade,
          detail: moonshotResult.body.slice(0, 300),
        });
        return;
      }

      let parsed;
      try {
        const data = JSON.parse(moonshotResult.body);
        /* k2.6은 reasoning_content + content 분리 — content 우선, 비면 reasoning에서 JSON 추출 */
        const msg = data.choices?.[0]?.message || {};
        let text = (msg.content || '').trim();
        if (!text && msg.reasoning_content) {
          /* reasoning_content에서 JSON 블록 추출 시도 */
          const m = String(msg.reasoning_content).match(/\{[\s\S]*"candidates"[\s\S]*\}/);
          if (m) text = m[0];
        }
        parsed = JSON.parse(text);
      } catch (e) {
        jsonRes(res, 502, { ok: false, error: 'JSON parse 실패', model: usedModel, detail: e.message });
        return;
      }

      const rawCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      const candidates = rawCandidates.slice(0, 5).map(c => ({
        scope: String(c.scope || 'general').slice(0, 200),
        subject: String(c.subject || '').slice(0, 200),
        body: String(c.body || '').slice(0, 2000),
        tags: Array.isArray(c.tags) ? c.tags.map(t => String(t)).slice(0, 6) : [],
        expires_at_hint: c.expires_at_hint && typeof c.expires_at_hint === 'string' ? c.expires_at_hint : null,
      })).filter(c => c.subject && c.body);

      jsonRes(res, 200, { ok: true, count: candidates.length, candidates });
    } catch (err) {
      console.error('[memory] suggest error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* POST /api/memory/forget — body: { id } 또는 { ids: [...] } */
  if (req.method === 'POST' && url.pathname === '/api/memory/forget') {
    try {
      const params = await parseBody(req);
      const userNN = resolveUserNN(req, params.userNN || url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const ids = Array.isArray(params.ids) ? params.ids : (params.id !== undefined ? [params.id] : []);
      const nums = ids.map(x => parseInt(x, 10)).filter(Number.isFinite);
      if (nums.length === 0) { jsonRes(res, 400, { ok: false, error: 'id 또는 ids 필수' }); return; }
      const db = openMemoryDb(userNN);
      const placeholders = nums.map(() => '?').join(',');
      const info = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...nums);
      jsonRes(res, 200, { ok: true, deleted: info.changes });
    } catch (err) {
      console.error('[memory] forget error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* ===== 사업 주간보고 프로젝트 관리 =====
     저장 위치: /opt/openclaw/data/userNN/business-report/
       ├─ projects.json          (매니페스트: {projects, default})
       └─ {project_id}/
           ├─ meta.json
           ├─ template.hwpx
           ├─ auth.env
           └─ history.json
     모두 resolveUserNN으로 컨테이너 격리.
  */

  const brProjectsDir = (nn) => path.join('/opt/openclaw/data', `user${nn}`, 'business-report');

  /* 컨테이너 안 node(uid 1000) 가 읽을 수 있도록 소유권 tideclaw(uid 1000)로 지정 */
  const BR_OWNER_UID = 1000;
  const BR_OWNER_GID = 1000;
  function brChown(p) {
    try { fs.chownSync(p, BR_OWNER_UID, BR_OWNER_GID); } catch (err) { console.warn('[br] chown failed:', p, err.message); }
  }
  function brChownRecursive(dir) {
    try {
      brChown(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) brChownRecursive(full);
        else brChown(full);
      }
    } catch (err) { console.warn('[br] chownR failed:', dir, err.message); }
  }

  function loadBrManifest(nn) {
    const p = path.join(brProjectsDir(nn), 'projects.json');
    if (!fs.existsSync(p)) return { projects: [], default: null };
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return { projects: [], default: null }; }
  }
  function saveBrManifest(nn, data) {
    const dir = brProjectsDir(nn);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); brChown(dir); }
    const p = path.join(dir, 'projects.json');
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    brChown(p);
  }
  function loadBrProjectMeta(nn, pid) {
    const p = path.join(brProjectsDir(nn), pid, 'meta.json');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  }
  function saveBrProjectMeta(nn, pid, meta) {
    const dir = path.join(brProjectsDir(nn), pid);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); brChown(dir); }
    const p = path.join(dir, 'meta.json');
    fs.writeFileSync(p, JSON.stringify(meta, null, 2));
    brChown(p);
  }
  function loadBrAuth(nn, pid) {
    const p = path.join(brProjectsDir(nn), pid, 'auth.env');
    if (!fs.existsSync(p)) return {};
    const env = {};
    fs.readFileSync(p, 'utf-8').split('\n').forEach(line => {
      const s = line.trim();
      if (!s || s.startsWith('#')) return;
      const i = s.indexOf('=');
      if (i > 0) env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    return env;
  }
  function saveBrAuth(nn, pid, env) {
    const dir = path.join(brProjectsDir(nn), pid);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); brChown(dir); }
    const lines = ['# SR 시스템 인증 (사업별)'];
    for (const k of ['SR_BASE_URL', 'SR_TENANT', 'SR_API_TOKEN']) {
      if (env[k]) lines.push(`${k}=${env[k]}`);
    }
    const p = path.join(dir, 'auth.env');
    fs.writeFileSync(p, lines.join('\n') + '\n', { mode: 0o600 });
    brChown(p);
  }
  function maskToken(s) {
    if (!s) return '';
    if (s.length <= 16) return '****';
    return `${s.slice(0, 8)}...${s.slice(-6)}`;
  }
  function brProjectStatus(nn, pid) {
    const auth = loadBrAuth(nn, pid);
    const meta = loadBrProjectMeta(nn, pid) || {};
    const templatePath = path.join(brProjectsDir(nn), pid, 'template.hwpx');
    return {
      auth_ok: !!(auth.SR_API_TOKEN && auth.SR_TENANT && auth.SR_BASE_URL),
      auth_masked: auth.SR_API_TOKEN ? maskToken(auth.SR_API_TOKEN) : null,
      base_url: auth.SR_BASE_URL || null,
      tenant: auth.SR_TENANT || null,
      template_exists: fs.existsSync(templatePath),
      template_size: fs.existsSync(templatePath) ? fs.statSync(templatePath).size : 0,
      template_original_filename: meta.template_original_filename || null,
      filename_rule_set: !!meta.template_original_filename,
    };
  }

  /* GET /api/business-report/projects — 사업 목록 (상태 요약 포함) */
  if (req.method === 'GET' && url.pathname === '/api/business-report/projects') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const m = loadBrManifest(userNN);
      const items = [];
      for (const pid of m.projects || []) {
        const meta = loadBrProjectMeta(userNN, pid);
        if (!meta) continue;
        items.push({ ...meta, status: brProjectStatus(userNN, pid) });
      }
      jsonRes(res, 200, { ok: true, projects: items, default: m.default });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* GET /api/business-report/projects/{id} — 상세 */
  {
    const mmatch = req.method === 'GET' && url.pathname.match(/^\/api\/business-report\/projects\/([^/]+)$/);
    if (mmatch) {
      try {
        const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
        if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
        const pid = decodeURIComponent(mmatch[1]);
        const meta = loadBrProjectMeta(userNN, pid);
        if (!meta) { jsonRes(res, 404, { ok: false, error: 'not found' }); return; }
        jsonRes(res, 200, { ok: true, project: { ...meta, status: brProjectStatus(userNN, pid) } });
      } catch (err) {
        jsonRes(res, 500, { ok: false, error: err.message });
      }
      return;
    }
  }

  /* POST /api/business-report/projects — 새 사업 등록
     body: { id, name, org, subtitle?, vendor?, week_rule?, is_default?, template_base64 } */
  if (req.method === 'POST' && url.pathname === '/api/business-report/projects') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const body = await parseBody(req);
      const pid = String(body.id || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(pid)) {
        jsonRes(res, 400, { ok: false, error: 'id는 영소문자/숫자/-, 2~64자' }); return;
      }
      const name = String(body.name || '').trim();
      const org = String(body.org || '').trim();
      if (!name || !org) { jsonRes(res, 400, { ok: false, error: 'name과 org는 필수' }); return; }

      const projDir = path.join(brProjectsDir(userNN), pid);
      if (fs.existsSync(projDir)) { jsonRes(res, 409, { ok: false, error: '이미 존재하는 사업 id' }); return; }
      fs.mkdirSync(projDir, { recursive: true, mode: 0o700 });

      const meta = {
        id: pid,
        name,
        org,
        subtitle: String(body.subtitle || '').trim(),
        vendor: String(body.vendor || '').trim(),
        template_file: 'template.hwpx',
        week_rule: body.week_rule || 'mon-fri',
        auto_run: !!body.auto_run,
        archived: false,
        created_at: new Date().toISOString(),
      };
      saveBrProjectMeta(userNN, pid, meta);

      if (body.template_base64) {
        try {
          const buf = Buffer.from(String(body.template_base64), 'base64');
          if (buf.length < 100) throw new Error('template 파일이 너무 작음');
          const tp = path.join(projDir, 'template.hwpx');
          fs.writeFileSync(tp, buf, { mode: 0o600 });
          brChown(tp);
          /* 원본 파일명 저장: 파일명 규칙 반영용 */
          if (body.template_filename) {
            meta.template_original_filename = String(body.template_filename).trim();
            saveBrProjectMeta(userNN, pid, meta);
          }
        } catch (err) {
          jsonRes(res, 400, { ok: false, error: `template 저장 실패: ${err.message}` }); return;
        }
      }

      const hp = path.join(projDir, 'history.json');
      fs.writeFileSync(hp, JSON.stringify({ runs: [] }, null, 2), { mode: 0o600 });
      brChown(hp);
      brChownRecursive(projDir);

      const m = loadBrManifest(userNN);
      if (!m.projects.includes(pid)) m.projects.push(pid);
      saveBrManifest(userNN, m);

      jsonRes(res, 200, { ok: true, project: { ...meta, status: brProjectStatus(userNN, pid) } });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* PUT /api/business-report/projects/{id} — 메타 업데이트 */
  {
    const mmatch = req.method === 'PUT' && url.pathname.match(/^\/api\/business-report\/projects\/([^/]+)$/);
    if (mmatch) {
      try {
        const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
        if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
        const pid = decodeURIComponent(mmatch[1]);
        const meta = loadBrProjectMeta(userNN, pid);
        if (!meta) { jsonRes(res, 404, { ok: false, error: 'not found' }); return; }
        const body = await parseBody(req);
        const updatable = ['name', 'org', 'subtitle', 'vendor', 'week_rule', 'auto_run', 'archived'];
        for (const k of updatable) {
          if (k in body) meta[k] = typeof meta[k] === 'boolean' ? !!body[k] : String(body[k] || '').trim();
        }
        meta.updated_at = new Date().toISOString();
        saveBrProjectMeta(userNN, pid, meta);

        // 양식 hwpx 교체 (선택)
        if (body.template_base64) {
          try {
            const buf = Buffer.from(String(body.template_base64), 'base64');
            if (buf.length < 100) throw new Error('template 파일이 너무 작음');
            const projDir = path.join(brProjectsDir(userNN), pid);
            const tp = path.join(projDir, 'template.hwpx');
            fs.writeFileSync(tp, buf, { mode: 0o600 });
            brChown(tp);
            /* 원본 파일명 갱신 */
            if (body.template_filename) {
              meta.template_original_filename = String(body.template_filename).trim();
              saveBrProjectMeta(userNN, pid, meta);
            }
          } catch (err) {
            jsonRes(res, 400, { ok: false, error: `template 저장 실패: ${err.message}` }); return;
          }
        }

        jsonRes(res, 200, { ok: true, project: { ...meta, status: brProjectStatus(userNN, pid) } });
      } catch (err) {
        jsonRes(res, 500, { ok: false, error: err.message });
      }
      return;
    }
  }

  /* DELETE /api/business-report/projects/{id} — 삭제 */
  {
    const mmatch = req.method === 'DELETE' && url.pathname.match(/^\/api\/business-report\/projects\/([^/]+)$/);
    if (mmatch) {
      try {
        const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
        if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
        const pid = decodeURIComponent(mmatch[1]);
        const projDir = path.join(brProjectsDir(userNN), pid);
        if (!fs.existsSync(projDir)) { jsonRes(res, 404, { ok: false, error: 'not found' }); return; }
        fs.rmSync(projDir, { recursive: true, force: true });

        const m = loadBrManifest(userNN);
        m.projects = (m.projects || []).filter(x => x !== pid);
        saveBrManifest(userNN, m);
        jsonRes(res, 200, { ok: true });
      } catch (err) {
        jsonRes(res, 500, { ok: false, error: err.message });
      }
      return;
    }
  }

  /* PUT /api/business-report/projects/{id}/auth — 인증 저장
     body: { SR_BASE_URL, SR_TENANT, SR_API_TOKEN } */
  {
    const mmatch = req.method === 'PUT' && url.pathname.match(/^\/api\/business-report\/projects\/([^/]+)\/auth$/);
    if (mmatch) {
      try {
        const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
        if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
        const pid = decodeURIComponent(mmatch[1]);
        if (!loadBrProjectMeta(userNN, pid)) { jsonRes(res, 404, { ok: false, error: 'project not found' }); return; }
        const body = await parseBody(req);
        const auth = {
          SR_BASE_URL: String(body.SR_BASE_URL || '').trim(),
          SR_TENANT: String(body.SR_TENANT || '').trim(),
          SR_API_TOKEN: String(body.SR_API_TOKEN || '').trim(),
        };
        if (!auth.SR_BASE_URL || !auth.SR_TENANT || !auth.SR_API_TOKEN) {
          jsonRes(res, 400, { ok: false, error: 'SR_BASE_URL, SR_TENANT, SR_API_TOKEN 모두 필수' }); return;
        }
        saveBrAuth(userNN, pid, auth);
        jsonRes(res, 200, { ok: true, status: brProjectStatus(userNN, pid) });
      } catch (err) {
        jsonRes(res, 500, { ok: false, error: err.message });
      }
      return;
    }
  }

  /* POST /api/business-report/preview-filename — 원본 파일명 → 이번주 치환 미리보기 */
  if (req.method === 'POST' && url.pathname === '/api/business-report/preview-filename') {
    try {
      const auth = getAuthSession(req);
      if (!auth) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
      const body = await parseBody(req);
      const originalFn = String(body.filename || '').trim();
      if (!originalFn) { jsonRes(res, 400, { ok: false, error: 'filename 필수' }); return; }

      /* 오늘 기준 이번 주 월요일 */
      const today = new Date();
      const dow = today.getDay(); // 0=Sun, 1=Mon, ...
      const daysToMon = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(today);
      monday.setDate(today.getDate() + daysToMon);
      const yyyy = monday.getFullYear();
      const mm = monday.getMonth() + 1;
      const dd = monday.getDate();

      /* ISO 4일 규칙: 이번 주 목요일이 속한 월의 몇 주차 */
      const thursday = new Date(monday);
      thursday.setDate(monday.getDate() + 3);
      const effYear = thursday.getFullYear();
      const effMonth = thursday.getMonth() + 1;
      const firstOfEffMonth = new Date(effYear, effMonth - 1, 1);
      const firstThuOffset = (4 - firstOfEffMonth.getDay() + 7) % 7;   // 0=Sun, 4=Thu
      const firstThu = new Date(effYear, effMonth - 1, 1 + firstThuOffset);
      const firstMonOfWk1 = new Date(firstThu); firstMonOfWk1.setDate(firstThu.getDate() - 3);
      const weekNo = Math.floor((monday - firstMonOfWk1) / (7 * 86400000)) + 1;

      const isoDate = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      const dotDate = `${yyyy}.${String(mm).padStart(2, '0')}.${String(dd).padStart(2, '0')}`;

      const patterns = [
        [/\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*주차/, `${effYear}년 ${effMonth}월 ${weekNo}주차`],
        [/\d{1,2}\s*월\s*\d{1,2}\s*주차/, `${effMonth}월 ${weekNo}주차`],
        [/\d{4}-\d{2}-\d{2}/, isoDate],
        [/\d{4}\.\d{2}\.\d{2}/, dotDate],
      ];
      for (const [pat, rep] of patterns) {
        if (pat.test(originalFn)) {
          const substituted = originalFn.replace(pat, rep);
          jsonRes(res, 200, { ok: true, detected: true, pattern: pat.source, preview: substituted, replacement: rep });
          return;
        }
      }
      jsonRes(res, 200, { ok: true, detected: false, preview: null });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* GET /api/business-report/last-week-file — 지난주 hwpx 파일 조회
     Query: project_id (선택)
     - default 프로젝트 사용 (없으면 no_default_project 반환)
     - 지난주 월요일 계산 → substitute 파일명 + 폴백 파일명 시도
     - 파일 있으면 { ok:true, filename, download_url, week_label, period, business_name }
     - 없으면 { ok:false, reason:'no_last_week_file'|'no_project', ... } */
  if (req.method === 'GET' && url.pathname === '/api/business-report/last-week-file') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const pid = url.searchParams.get('project_id') || '';
      if (!pid) { jsonRes(res, 400, { ok: false, error: 'Missing project_id' }); return; }
      const meta = loadBrProjectMeta(userNN, pid);
      if (!meta) { jsonRes(res, 200, { ok: false, reason: 'no_project' }); return; }

      /* 지난주 월요일 = 이번주 월요일 - 7일 */
      const today = new Date();
      const dow = today.getDay();
      const daysToMon = dow === 0 ? -6 : 1 - dow;
      const thisMon = new Date(today);
      thisMon.setDate(today.getDate() + daysToMon);
      const monday = new Date(thisMon);
      monday.setDate(thisMon.getDate() - 7);
      const friday = new Date(monday);
      friday.setDate(monday.getDate() + 4);

      /* ISO 4일 규칙 · 주차 라벨 */
      const thursday = new Date(monday);
      thursday.setDate(monday.getDate() + 3);
      const effYear = thursday.getFullYear();
      const effMonth = thursday.getMonth() + 1;
      const firstOfEffMonth = new Date(effYear, effMonth - 1, 1);
      const firstThuOffset = (4 - firstOfEffMonth.getDay() + 7) % 7;
      const firstThu = new Date(effYear, effMonth - 1, 1 + firstThuOffset);
      const firstMonOfWk1 = new Date(firstThu); firstMonOfWk1.setDate(firstThu.getDate() - 3);
      const weekNo = Math.floor((monday - firstMonOfWk1) / (7 * 86400000)) + 1;

      const yyyy = monday.getFullYear();
      const mm = monday.getMonth() + 1;
      const dd = monday.getDate();
      const isoDate = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      const dotDate = `${yyyy}.${String(mm).padStart(2, '0')}.${String(dd).padStart(2, '0')}`;
      const periodStr = `${yyyy}. ${String(mm).padStart(2, '0')}. ${String(dd).padStart(2, '0')} ~ ${friday.getFullYear()}. ${String(friday.getMonth() + 1).padStart(2, '0')}. ${String(friday.getDate()).padStart(2, '0')}`;
      const weekLabel = `${effYear}년 ${effMonth}월 ${weekNo}주차 (${mm}/${dd}~${friday.getMonth() + 1}/${friday.getDate()})`;
      const weekLabelShort = `${effMonth}월 ${weekNo}주차`;

      /* 후보 파일명 계산 */
      const candidates = [];
      const originalFn = meta.template_original_filename;
      if (originalFn) {
        const patterns = [
          [/\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*주차/, `${effYear}년 ${effMonth}월 ${weekNo}주차`],
          [/\d{1,2}\s*월\s*\d{1,2}\s*주차/, `${effMonth}월 ${weekNo}주차`],
          [/\d{4}-\d{2}-\d{2}/, isoDate],
          [/\d{4}\.\d{2}\.\d{2}/, dotDate],
        ];
        for (const [pat, rep] of patterns) {
          if (pat.test(originalFn)) { candidates.push(originalFn.replace(pat, rep)); break; }
        }
      }
      /* 폴백 파일명 규칙 */
      const business = meta.name || pid;
      const fnLabel = weekLabel.replace(/ /g, '_').replace(/\//g, '-');
      candidates.push(`[${business}] ${fnLabel}.hwpx`);

      const outDir = path.join('/opt/openclaw/shared', `user${userNN}`, 'business-report', 'output', pid);
      let matched = null;
      for (const cand of candidates) {
        const p = path.join(outDir, cand);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) { matched = cand; break; }
      }

      /* 후보 매칭 실패 · 파일명 문자열로 스캔 폴백 (규칙 변경된 파일 존재 케이스) */
      if (!matched && fs.existsSync(outDir)) {
        try {
          const files = fs.readdirSync(outDir).filter(f => f.endsWith('.hwpx'));
          /* 공백↔밑줄 무시하고 라벨 매칭 */
          const normalize = (s) => s.replace(/[_\s]+/g, '');
          const targets = [
            normalize(`${effMonth}월${weekNo}주차`),
            normalize(`${effYear}년${effMonth}월${weekNo}주차`),
          ];
          const found = files.find(f => {
            const n = normalize(f);
            return targets.some(t => n.includes(t));
          });
          if (found) matched = found;
        } catch {}
      }

      if (!matched) {
        jsonRes(res, 200, {
          ok: false,
          reason: 'no_last_week_file',
          week_label: weekLabel,
          period: periodStr,
          business_name: business,
          project_id: pid,
        });
        return;
      }

      const downloadUrl = `/api/file/download?path=${encodeURIComponent(`business-report/output/${pid}/${matched}`)}`;
      jsonRes(res, 200, {
        ok: true,
        filename: matched,
        download_url: downloadUrl,
        week_label: weekLabel,
        period: periodStr,
        business_name: business,
        project_id: pid,
      });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* POST /api/business-report/projects/{id}/test-connection — SR API 연결 테스트 */
  {
    const mmatch = req.method === 'POST' && url.pathname.match(/^\/api\/business-report\/projects\/([^/]+)\/test-connection$/);
    if (mmatch) {
      try {
        const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
        if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
        const pid = decodeURIComponent(mmatch[1]);
        const auth = loadBrAuth(userNN, pid);
        if (!auth.SR_API_TOKEN || !auth.SR_TENANT || !auth.SR_BASE_URL) {
          jsonRes(res, 400, { ok: false, error: '인증 정보 부족' }); return;
        }
        const testUrl = new URL(`/api/${auth.SR_TENANT}/sr?date_field=closed_at&from=2026-01-01&to=2026-01-02&limit=1`, auth.SR_BASE_URL);
        const result = await new Promise((resolve) => {
          const options = {
            hostname: testUrl.hostname,
            path: testUrl.pathname + testUrl.search,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${auth.SR_API_TOKEN}`, 'Accept': 'application/json' },
            timeout: 10_000,
          };
          const req2 = https.request(options, (resp) => {
            let buf = '';
            resp.on('data', chunk => { bufChunks.push(chunk); });
            resp.on('end', () => resolve({ status: resp.statusCode, body: buf }));
          });
          req2.on('error', err => resolve({ status: 599, body: err.message }));
          req2.on('timeout', () => { req2.destroy(); resolve({ status: 598, body: 'timeout' }); });
          req2.end();
        });
        jsonRes(res, 200, {
          ok: result.status === 200,
          http_status: result.status,
          detail: result.status === 200 ? '연결 성공' : (result.body || '').slice(0, 200),
        });
      } catch (err) {
        jsonRes(res, 500, { ok: false, error: err.message });
      }
      return;
    }
  }

  /* GET /api/brief — 오늘 컨텍스트 집계 (다음 미팅 + 미답 메일).
     컨테이너 IP 기반 resolveUserNN. 60초 캐시. 부분 실패는 silent. */
  if (req.method === 'GET' && url.pathname === '/api/brief') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }

      const cached = briefCache.get(userNN);
      if (cached && Date.now() - cached.ts < BRIEF_TTL_MS) {
        jsonRes(res, 200, cached.data); return;
      }

      let accessToken;
      try { accessToken = await getValidAccessToken(userNN); } catch { /* google 미연동 */ }

      const out = {
        ok: true,
        userNN,
        nextMeeting: null,
        unread: { today: null, week: null, query: 'in:inbox - promotions/social/updates' },
        generatedAt: Date.now(),
      };

      if (accessToken) {
        const nowIso = new Date().toISOString();
        const todayEndIso = new Date(new Date().setHours(23, 59, 59, 999)).toISOString();

        /* 노이즈 제거 query — 받은편지함 + 광고/소셜/알림 제외 */
        const baseQ = 'is:unread in:inbox -category:promotions -category:social -category:updates';
        const qToday = `${baseQ} newer_than:1d`;
        const qWeek = `${baseQ} newer_than:7d`;

        const [calRes, mailTodayRes, mailWeekRes] = await Promise.all([
          gmailApiRequest('GET',
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(nowIso)}&timeMax=${encodeURIComponent(todayEndIso)}&singleEvents=true&orderBy=startTime&maxResults=10`,
            accessToken).catch(() => ({ status: 599 })),
          gmailApiRequest('GET',
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(qToday)}&maxResults=1`,
            accessToken).catch(() => ({ status: 599 })),
          gmailApiRequest('GET',
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(qWeek)}&maxResults=1`,
            accessToken).catch(() => ({ status: 599 })),
        ]);

        if (calRes.status < 400 && calRes.data?.items) {
          const upcoming = calRes.data.items.find(e => {
            const start = e.start?.dateTime || e.start?.date;
            return start && new Date(start).getTime() > Date.now();
          });
          if (upcoming) {
            out.nextMeeting = {
              title: upcoming.summary || '(제목 없음)',
              start: upcoming.start?.dateTime || upcoming.start?.date || '',
              location: upcoming.location || '',
              allDay: !!upcoming.start?.date,
            };
          }
        }

        if (mailTodayRes.status < 400) {
          const est = mailTodayRes.data?.resultSizeEstimate;
          if (typeof est === 'number') out.unread.today = est;
        }
        if (mailWeekRes.status < 400) {
          const est = mailWeekRes.data?.resultSizeEstimate;
          if (typeof est === 'number') out.unread.week = est;
        }
      }

      briefCache.set(userNN, { ts: Date.now(), data: out });
      jsonRes(res, 200, out);
    } catch (err) {
      console.error('[brief] error:', err.message);
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/calendar/today') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
              const dataChunks = [];
              uploadRes.on('data', chunk => { dataChunks.push(chunk); });
              uploadRes.on('end', () => {
        const data = Buffer.concat(dataChunks).toString('utf8'); try { resolve(JSON.parse(data)); } catch { resolve({}); } });
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
              const dataChunks = [];
              uploadRes.on('data', chunk => { dataChunks.push(chunk); });
              uploadRes.on('end', () => {
        const data = Buffer.concat(dataChunks).toString('utf8'); try { resolve(JSON.parse(data)); } catch { resolve({}); } });
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
              const dataChunks = [];
              uploadRes.on('data', chunk => { dataChunks.push(chunk); });
              uploadRes.on('end', () => {
        const data = Buffer.concat(dataChunks).toString('utf8'); try { resolve(JSON.parse(data)); } catch { resolve({}); } });
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
          const dataChunks = [];
          uploadRes.on('data', chunk => { dataChunks.push(chunk); });
          uploadRes.on('end', () => {
        const data = Buffer.concat(dataChunks).toString('utf8'); try { resolve({ status: uploadRes.statusCode, data: JSON.parse(data) }); } catch { resolve({ status: uploadRes.statusCode, data }); } });
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
          const dataChunks = [];
          uploadRes.on('data', chunk => { dataChunks.push(chunk); });
          uploadRes.on('end', () => {
        const data = Buffer.concat(dataChunks).toString('utf8');
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
      const userNN = resolveUserNN(req, data.userNN || url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      if (data.dooray) {
        // 봇 URL 형식 검증 — 잘못 붙여넣으면 알림이 조용히 안 온다. 며칠 뒤에야 안다(실측).
        if (data.dooray.botUrl) {
          const u = String(data.dooray.botUrl).trim();
          if (!/^https:\/\/[a-z0-9.-]*dooray\.com\/services\/\d+\/\d+\/\S+$/i.test(u)) {
            jsonRes(res, 400, { ok: false, error: '봇 URL 형식이 아닙니다. 두레이에서 발급한 "서비스 후크 URL" 을 그대로 붙여넣어주세요' });
            return;
          }
          data.dooray.botUrl = u;
        }
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
      if (data.github) {
        // 화면은 토큰을 '••••1234' 로 받아 그대로 돌려보낸다. 그걸 저장하면 **진짜 토큰이 지워진다**.
        // 마스킹된 값이 오면 저장돼 있던 토큰을 그대로 둔다.
        const masked = (t) => typeof t === 'string' && t.startsWith('••••');
        // 이미 저장돼 있는 토큰을 username 으로 찾을 수 있게 모아둔다.
        // 계정 하나만 쓰던 사람이 두 번째를 추가하면 첫 계정은 최상위에 있으므로 함께 넣는다.
        const known = new Map();
        if (existing.github?.token) known.set(existing.github.username || '', existing.github.token);
        (Array.isArray(existing.github?.accounts) ? existing.github.accounts : [])
          .forEach((a) => { if (a?.token) known.set(a.username || '', a.token); });
        const resolve = (a) => (masked(a?.token) ? { ...a, token: known.get(a.username || '') || '' } : a);

        const next = resolve({ ...existing.github, ...data.github });
        if (Array.isArray(data.github.accounts)) {
          // 토큰을 되살리지 못한 계정은 조회가 불가능하므로 저장하지 않는다
          next.accounts = data.github.accounts.map(resolve).filter((a) => a.token);
          // 최상위를 첫 계정과 맞춘다. 안 맞추면 **지운 계정의 토큰이 최상위에 남는다** —
          // 수집은 accounts 를 보므로 동작엔 지장이 없지만, 쓰지 않는 자격증명이 파일에 남는다.
          const head = next.accounts[0] || {};
          next.owner = head.owner || ''; next.repo = head.repo || '';
          next.username = head.username || ''; next.token = head.token || '';
        }
        existing.github = { ...next, updatedAt: new Date().toISOString() };
      }
      if (data.figma) {
        existing.figma = { ...existing.figma, ...data.figma, updatedAt: new Date().toISOString() };
        // 토큰을 새로 넣으면 본인 식별 정보를 함께 저장한다 — 버전 이력에서 내 편집만 골라내는 데 쓴다
        if (data.figma.token) {
          try {
            const me = await figmaApi('/v1/me', data.figma.token);
            if (me?.id) {
              existing.figma.userId = me.id;
              existing.figma.handle = me.handle || '';
              console.log(`[figma] user${userNN}: ${existing.figma.handle} (${existing.figma.userId})`);
            }
          } catch (e) { console.warn('[figma] /v1/me 실패:', e.message); }
        }
      }
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
      const userNN = resolveUserNN(req, data.userNN || url.searchParams.get('userNN'));
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let data = {};
      try { data = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      const safe = {};
      if (data.dooray) safe.dooray = { token: data.dooray.token ? '••••' + data.dooray.token.slice(-4) : '', memberId: data.dooray.memberId || '', memberName: data.dooray.memberName || '', botUrl: data.dooray.botUrl || '', updatedAt: data.dooray.updatedAt || '' };
      // 계정을 2개 이상 쓰는 사람이 있다 — accounts 로 함께 내려준다.
      // username 도 내려야 한다: 커밋 조회가 author=username 으로 걸러지는데
      // 예전에는 빠져 있어서 화면에서 무슨 계정인지 알 수 없었다.
      if (data.github) {
        const maskGh = (g) => ({
          owner: g.owner || '', repo: g.repo || '', username: g.username || '',
          token: g.token ? '••••' + g.token.slice(-4) : '',
        });
        safe.github = { ...maskGh(data.github), updatedAt: data.github.updatedAt || '' };
        if (Array.isArray(data.github.accounts) && data.github.accounts.length) {
          safe.github.accounts = data.github.accounts.map(maskGh);
        }
      }
      if (data.figma) safe.figma = { token: data.figma.token ? '••••' + data.figma.token.slice(-4) : '', handle: data.figma.handle || '', expiresAt: data.figma.expiresAt || '', fileKeys: data.figma.fileKeys || [], updatedAt: data.figma.updatedAt || '' };
      jsonRes(res, 200, { ok: true, data: safe });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ============ HWP SVG VIEWER ============
  if (req.method === 'GET' && url.pathname === '/api/hwp/svg') {
    try {
      const userNN = resolveUserNN(req, url.searchParams.get('userNN') || '');
      const fileName = url.searchParams.get('file') || '';
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      if (!fileName || fileName.includes('/') || fileName.includes('..') || !fileName.endsWith('.svg')) {
        jsonRes(res, 400, { ok: false, error: 'Invalid file' }); return;
      }
      const svgPath = path.join(SVG_EXPORT_BASE, `user${userNN}`, 'workspace', 'hwp-exports', fileName);
      if (!fs.existsSync(svgPath)) { jsonRes(res, 404, { ok: false, error: 'File not found' }); return; }
      const stat = fs.statSync(svgPath);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=3600',
      });
      fs.createReadStream(svgPath).pipe(res);
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ============ FILE DOWNLOAD ============
  if (req.method === 'GET' && url.pathname === '/api/file/download') {
    try {
      /* 브라우저 다운로드: 여러 소스에서 userNN 찾아옴 (에이전트가 만든 URL param 무시).
         우선순위: 1) 세션 쿠키의 userNN  2) gateway_token 쿠키 (tc-userNN)  3) URL param  4) 컨테이너 IP */
      let userNN = null;
      const auth = getAuthSession(req);
      if (auth?.userNN) userNN = auth.userNN;
      if (!userNN) {
        const cookies = parseCookies(req);
        const gwToken = cookies.gateway_token || cookies.token || '';
        const m = gwToken.match(/user(\d+)/i);
        if (m) userNN = String(m[1]).padStart(2, '0');
      }
      if (!userNN) {
        userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      }
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
        '.hwp': 'application/x-hwp',
        '.hwpx': 'application/vnd.hancom.hwpx',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      /* Chrome이 HTTP unknown binary 다운로드를 차단하는 문제 회피:
         - 정확한 hwpx mime type 지정 (application/vnd.hancom.hwpx)
         - X-Content-Type-Options: nosniff 로 mime sniffing 방지
         - Content-Disposition의 ASCII fallback filename도 함께 제공 */
      const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': stat.size,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
      const intFile = path.join('/opt/openclaw/data', `user${userNN}`, 'integrations.json');
      let intData = {};
      try { intData = JSON.parse(fs.readFileSync(intFile, 'utf-8')); } catch {}
      const token = intData?.dooray?.token;
      if (!token) { jsonRes(res, 400, { ok: false, error: 'Dooray 토큰이 설정되지 않았습니다' }); return; }
      const memberIds = url.searchParams.get('memberIds') || '';
      const ccMemberIds = url.searchParams.get('ccMemberIds') || '';
      let apiUrl = `https://api.dooray.com/project/v1/projects/${projectId}/posts?page=${page}&size=${size}&order=-updatedAt`;
      if (status) apiUrl += `&workflowClasses=${status}`;
      if (memberIds) apiUrl += `&toMemberIds=${memberIds}`;
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
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
      const userNN = resolveUserNN(req, url.searchParams.get('userNN'));
      if (!userNN || !validateUserNN(userNN)) { jsonRes(res, 400, { ok: false, error: 'Invalid userNN' }); return; }
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
      const downloadUrl = `http://claw.tideflo.work/api/hwp/svg?userNN=${userNN}&file=${encodeURIComponent(svgName)}`;
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
  // admin DB 초기화 (catchup + watcher 시작)
  getAdminDb();
});
