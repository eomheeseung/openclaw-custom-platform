const fs = require('fs');
const path = require('path');
const { openDb } = require('./lib/db');

const DATA_ROOT = '/opt/openclaw/data';
const USAGE_ROOT = '/opt/openclaw/data/usage';
const USERS_JSON = '/opt/openclaw/auth/users.json';

function fileCounts() {
  const users = fs.existsSync(USERS_JSON)
    ? Object.keys(JSON.parse(fs.readFileSync(USERS_JSON, 'utf8'))).length : 0;
  let agents = 0, sessions = 0, usage = 0;
  const sessionKeysSeen = new Set();
  for (let n = 1; n <= 99; n++) {
    const slot = String(n).padStart(2, '0');
    const cfg = path.join(DATA_ROOT, `user${slot}`, 'openclaw.json');
    if (fs.existsSync(cfg)) {
      try {
        const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
        const list = (c.agents?.list || []).map(a => (typeof a === 'string' ? a : a.id)).filter(Boolean);
        agents += list.length;
      } catch { /* ignore */ }
    }
    const agDir = path.join(DATA_ROOT, `user${slot}`, 'agents');
    if (fs.existsSync(agDir)) {
      for (const a of fs.readdirSync(agDir)) {
        const sj = path.join(agDir, a, 'sessions', 'sessions.json');
        if (fs.existsSync(sj)) {
          try {
            const keys = Object.keys(JSON.parse(fs.readFileSync(sj, 'utf8')));
            for (const k of keys) sessionKeysSeen.add(k);
          } catch { /* ignore */ }
        }
      }
    }
    const uDir = path.join(USAGE_ROOT, `user${slot}`);
    if (fs.existsSync(uDir)) {
      for (const file of fs.readdirSync(uDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(uDir, file), 'utf8'));
          usage += Object.keys(d.models || d.byModel || {}).length;
        } catch { /* ignore */ }
      }
    }
  }
  sessions = sessionKeysSeen.size;
  return { users, agents, sessions, usage };
}

function dbCounts(db) {
  return {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    agents: db.prepare('SELECT COUNT(*) c FROM agents').get().c,
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    usage: db.prepare('SELECT COUNT(*) c FROM api_usage_daily').get().c,
  };
}

(function main() {
  const db = openDb();
  const f = fileCounts();
  const d = dbCounts(db);
  let ok = true;
  for (const k of Object.keys(f)) {
    const status = f[k] === d[k] ? 'OK' : 'DIFF';
    if (status === 'DIFF') ok = false;
    console.log(`${k.padEnd(10)} file=${f[k].toString().padStart(6)}  db=${d[k].toString().padStart(6)}  ${status}`);
  }
  db.close();
  process.exit(ok ? 0 : 1);
})();
