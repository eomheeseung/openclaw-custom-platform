# RDBMS Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenClaw 멀티 사용자 인프라(15명, 단일 호스트)에 SQLite 기반 메타 인덱스 도입. 파일은 진실로 유지, DB는 쿼리 가능한 미러.

**Architecture:** 단일 SQLite 파일 + better-sqlite3 + chokidar watcher. 단방향 sync(파일 → DB). automap-api.js 안에 통합 (별도 프로세스 X). 시작 시 catchup + 시간당 cron 안전망.

**Tech Stack:** Node.js, better-sqlite3, chokidar, SQLite. spec: `/root/openclaw-custom-platform/docs/specs/2026-05-08-rdbms-phase1-design.md`

**Spec 위치:** `/root/openclaw-custom-platform/docs/specs/2026-05-08-rdbms-phase1-design.md`

---

## File Structure

```
/opt/openclaw/scripts/admin-db/
  migrations/
    001_initial.sql        # 5개 테이블 + 인덱스 + FK
  lib/
    db.js                  # better-sqlite3 wrapper, WAL 활성화, prepared statements
    upsert-users.js        # users.json → users 테이블
    upsert-agents.js       # openclaw.json.agents → agents 테이블
    upsert-sessions.js     # sessions.json + jsonl mtime → sessions 테이블
    upsert-usage.js        # data/usage/userNN/*.json → api_usage_daily
    upsert-fx.js           # config/usage-pricing.json fx → fx_rates
  seed.js                  # 1회 일괄 마이그레이션 (멱등)
  watcher.js               # chokidar 시작 + debounce + UPSERT 디스패치
  catchup.js               # 시작 시 + cron마다 mtime 기반 누락 보정
  verify.js                # 파일 카운트 vs DB count diff 출력
  package.json             # better-sqlite3, chokidar 의존성

/opt/openclaw/scripts/backup-admin-db.sh   # 매일 02:30 cron
automap-api.js                              # 새 /api/admin/db/* 엔드포인트 추가
custom-ui/src/components/AdminPanel.tsx    # DB API 호출로 전환
```

---

## Task 1: 디렉토리 + sysctl + 스키마 SQL

**Files:**
- Create: `/opt/openclaw/scripts/admin-db/migrations/001_initial.sql`
- Create: `/etc/sysctl.d/99-openclaw.conf`

- [ ] **Step 1: inotify 한도 상향**

```bash
sudo tee /etc/sysctl.d/99-openclaw.conf > /dev/null <<EOF
fs.inotify.max_user_watches=262144
fs.inotify.max_user_instances=512
EOF
sudo sysctl --system
```

확인: `sysctl fs.inotify.max_user_watches` → `262144`

- [ ] **Step 2: 마이그레이션 SQL 파일 작성**

`/opt/openclaw/scripts/admin-db/migrations/001_initial.sql`:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  slot         TEXT PRIMARY KEY,
  email        TEXT UNIQUE,
  name         TEXT,
  status       TEXT DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slot    TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  agent_type   TEXT NOT NULL,
  name         TEXT,
  model        TEXT,
  is_default   INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(user_slot, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_slot);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(agent_type);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key     TEXT UNIQUE NOT NULL,
  user_slot       TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  agent_db_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  agent_id        TEXT NOT NULL,
  status          TEXT DEFAULT 'active',
  is_main         INTEGER DEFAULT 0,
  message_count   INTEGER DEFAULT 0,
  total_tokens    INTEGER DEFAULT 0,
  total_cost_krw  REAL DEFAULT 0,
  file_path       TEXT,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_slot);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_db_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at DESC);

CREATE TABLE IF NOT EXISTS api_usage_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slot       TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  cache_read      INTEGER DEFAULT 0,
  cache_write     INTEGER DEFAULT 0,
  message_count   INTEGER DEFAULT 0,
  cost_usd        REAL DEFAULT 0,
  cost_krw        REAL DEFAULT 0,
  fx_rate         REAL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(user_slot, date, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_date ON api_usage_daily(date);
CREATE INDEX IF NOT EXISTS idx_usage_user_date ON api_usage_daily(user_slot, date);

CREATE TABLE IF NOT EXISTS fx_rates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  currency     TEXT NOT NULL,
  to_currency  TEXT NOT NULL DEFAULT 'KRW',
  rate         REAL NOT NULL,
  fetched_at   INTEGER NOT NULL,
  source       TEXT
);
CREATE INDEX IF NOT EXISTS idx_fx_currency_time ON fx_rates(currency, fetched_at DESC);
```

- [ ] **Step 3: 적용 검증 (스키마만 생성, 시드 X)**

```bash
mkdir -p /opt/openclaw/scripts/admin-db
# (위 파일 생성 후)
sqlite3 /tmp/_test.sqlite < /opt/openclaw/scripts/admin-db/migrations/001_initial.sql
sqlite3 /tmp/_test.sqlite ".schema users" | grep "CREATE TABLE users"
sqlite3 /tmp/_test.sqlite ".schema agents" | grep "CREATE TABLE agents"
sqlite3 /tmp/_test.sqlite "PRAGMA foreign_keys" # 1
sqlite3 /tmp/_test.sqlite "PRAGMA journal_mode" # wal
rm /tmp/_test.sqlite*
```

기대: 모든 PRAGMA + 5 테이블 + 9 인덱스 생성. 에러 0.

- [ ] **Step 4: Commit**

```bash
cd /root/openclaw-custom-platform
mkdir -p scripts/admin-db/migrations
cp /opt/openclaw/scripts/admin-db/migrations/001_initial.sql scripts/admin-db/migrations/001_initial.sql
git add scripts/admin-db/migrations/001_initial.sql
git commit -m "feat(admin-db): SQLite Phase 1 schema (users/agents/sessions/usage/fx)"
```

(`/root/openclaw-custom-platform/scripts/admin-db/`도 git에 보존, 운영 사본은 `/opt/openclaw/scripts/admin-db/`. 둘 동기화.)

---

## Task 2: better-sqlite3 + chokidar 의존성 + db.js wrapper

**Files:**
- Create: `/opt/openclaw/scripts/admin-db/package.json`
- Create: `/opt/openclaw/scripts/admin-db/lib/db.js`

- [ ] **Step 1: package.json 생성**

`/opt/openclaw/scripts/admin-db/package.json`:

```json
{
  "name": "openclaw-admin-db",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "seed": "node seed.js",
    "verify": "node verify.js",
    "catchup": "node catchup.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.5.0",
    "chokidar": "^3.6.0"
  }
}
```

- [ ] **Step 2: 의존성 설치**

```bash
cd /opt/openclaw/scripts/admin-db
npm install
```

기대: `node_modules/better-sqlite3`, `node_modules/chokidar` 생성, 0 vulnerabilities.

- [ ] **Step 3: db.js wrapper 작성**

`/opt/openclaw/scripts/admin-db/lib/db.js`:

```js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = '/opt/openclaw/data/_admin.sqlite';
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '001_initial.sql');

function openDb(dbPath = DEFAULT_DB_PATH) {
  const fresh = !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  if (fresh) {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(sql);
  }
  return db;
}

function now() { return Date.now(); }

module.exports = { openDb, DEFAULT_DB_PATH, now };
```

- [ ] **Step 4: 동작 확인**

```bash
node -e "const {openDb}=require('/opt/openclaw/scripts/admin-db/lib/db'); const db=openDb('/tmp/_t.sqlite'); console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all()); db.close();"
rm /tmp/_t.sqlite*
```

기대: `users / agents / sessions / api_usage_daily / fx_rates` 5개 row 출력.

- [ ] **Step 5: Commit**

```bash
cd /root/openclaw-custom-platform
mkdir -p scripts/admin-db/lib
cp /opt/openclaw/scripts/admin-db/package.json scripts/admin-db/package.json
cp /opt/openclaw/scripts/admin-db/lib/db.js scripts/admin-db/lib/db.js
git add scripts/admin-db/package.json scripts/admin-db/lib/db.js
git commit -m "feat(admin-db): db.js wrapper with WAL + auto-migration"
```

---

## Task 3: UPSERT 함수 5개 (users / agents / sessions / usage / fx)

**Files:**
- Create: `/opt/openclaw/scripts/admin-db/lib/upsert-users.js`
- Create: `/opt/openclaw/scripts/admin-db/lib/upsert-agents.js`
- Create: `/opt/openclaw/scripts/admin-db/lib/upsert-sessions.js`
- Create: `/opt/openclaw/scripts/admin-db/lib/upsert-usage.js`
- Create: `/opt/openclaw/scripts/admin-db/lib/upsert-fx.js`

각 함수는 (db, fileContent) → 반영 row 수 반환.

- [ ] **Step 1: upsert-users.js**

```js
// /opt/openclaw/scripts/admin-db/lib/upsert-users.js
const fs = require('fs');
const { now } = require('./db');

const USERS_JSON = '/opt/openclaw/auth/users.json';
const NAME_BY_EMAIL_PATH = '/opt/openclaw/scripts/automap-api.js'; // MEMBER_MAP은 거기 있음 — 단순화: name은 일단 email 일부 또는 NULL

function upsertUsers(db) {
  if (!fs.existsSync(USERS_JSON)) return 0;
  const map = JSON.parse(fs.readFileSync(USERS_JSON, 'utf8'));
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO users (slot, email, name, status, created_at, updated_at)
    VALUES (@slot, @email, @name, 'active', @ts, @ts)
    ON CONFLICT(slot) DO UPDATE SET
      email = excluded.email,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r); });
  const rows = Object.entries(map).map(([email, slot]) => ({
    slot: String(slot).padStart(2, '0'),
    email,
    name: null,
    ts,
  }));
  tx(rows);
  // soft-delete: 매핑에서 빠진 슬롯은 inactive
  const known = new Set(rows.map(r => r.slot));
  const all = db.prepare('SELECT slot FROM users').all();
  const inact = db.prepare('UPDATE users SET status=?, updated_at=? WHERE slot=?');
  for (const r of all) {
    if (!known.has(r.slot)) inact.run('inactive', ts, r.slot);
  }
  return rows.length;
}

module.exports = { upsertUsers };
```

- [ ] **Step 2: upsert-agents.js**

```js
// /opt/openclaw/scripts/admin-db/lib/upsert-agents.js
const fs = require('fs');
const path = require('path');
const { now } = require('./db');

const DATA_ROOT = '/opt/openclaw/data';

const TYPE_BY_PREFIX = (id) => {
  if (id.endsWith('-discord')) return id.replace('-discord', '');
  return id;
};

function upsertAgentsForSlot(db, slot) {
  const cfgPath = path.join(DATA_ROOT, `user${slot}`, 'openclaw.json');
  if (!fs.existsSync(cfgPath)) return 0;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const list = (cfg.agents && cfg.agents.list) || [];
  const defaultModel = cfg.agents?.defaults?.model?.primary || null;
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO agents (user_slot, agent_id, agent_type, name, model, is_default, status, created_at, updated_at)
    VALUES (@slot, @agent_id, @agent_type, @name, @model, @is_default, 'active', @ts, @ts)
    ON CONFLICT(user_slot, agent_id) DO UPDATE SET
      agent_type = excluded.agent_type,
      name = excluded.name,
      model = excluded.model,
      is_default = excluded.is_default,
      status = 'active',
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r); });
  const rows = list.map((agentId, idx) => ({
    slot,
    agent_id: agentId,
    agent_type: TYPE_BY_PREFIX(agentId),
    name: agentId,
    model: defaultModel,
    is_default: idx === 0 ? 1 : 0,
    ts,
  }));
  tx(rows);
  // soft-archive: 파일에 없는 agents는 archived
  const known = new Set(list);
  const exist = db.prepare('SELECT agent_id FROM agents WHERE user_slot=?').all(slot);
  const arch = db.prepare('UPDATE agents SET status=?, updated_at=? WHERE user_slot=? AND agent_id=?');
  for (const r of exist) {
    if (!known.has(r.agent_id)) arch.run('archived', ts, slot, r.agent_id);
  }
  return rows.length;
}

function upsertAllAgents(db) {
  let total = 0;
  for (let n = 1; n <= 99; n++) {
    const slot = String(n).padStart(2, '0');
    if (!fs.existsSync(path.join(DATA_ROOT, `user${slot}`))) continue;
    total += upsertAgentsForSlot(db, slot);
  }
  return total;
}

module.exports = { upsertAgentsForSlot, upsertAllAgents };
```

- [ ] **Step 3: upsert-sessions.js**

```js
// /opt/openclaw/scripts/admin-db/lib/upsert-sessions.js
const fs = require('fs');
const path = require('path');
const { now } = require('./db');

const DATA_ROOT = '/opt/openclaw/data';

function upsertSessionsForAgent(db, slot, agentId) {
  const sessionsJson = path.join(DATA_ROOT, `user${slot}`, 'agents', agentId, 'sessions', 'sessions.json');
  if (!fs.existsSync(sessionsJson)) return 0;
  let data;
  try { data = JSON.parse(fs.readFileSync(sessionsJson, 'utf8')); } catch { return 0; }
  const sessionsDir = path.dirname(sessionsJson);
  const ts = now();

  const agentRow = db.prepare('SELECT id FROM agents WHERE user_slot=? AND agent_id=?').get(slot, agentId);
  const agent_db_id = agentRow ? agentRow.id : null;

  const stmt = db.prepare(`
    INSERT INTO sessions (session_key, user_slot, agent_db_id, agent_id, status, is_main, message_count, total_tokens, total_cost_krw, file_path, created_at, last_active_at, updated_at)
    VALUES (@session_key, @user_slot, @agent_db_id, @agent_id, @status, @is_main, @message_count, @total_tokens, @total_cost_krw, @file_path, @created_at, @last_active_at, @ts)
    ON CONFLICT(session_key) DO UPDATE SET
      agent_db_id = excluded.agent_db_id,
      status = excluded.status,
      message_count = excluded.message_count,
      total_tokens = excluded.total_tokens,
      total_cost_krw = excluded.total_cost_krw,
      file_path = excluded.file_path,
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r); });

  const rows = Object.entries(data).map(([sessionKey, meta]) => {
    const tail = sessionKey.split(':').pop() || '';
    const sessionFile = (meta && meta.sessionFile) || `${sessionsDir}/${tail}.jsonl`;
    let mtime = ts;
    try { if (fs.existsSync(sessionFile)) mtime = Math.floor(fs.statSync(sessionFile).mtimeMs); } catch { /* ignore */ }
    return {
      session_key: sessionKey,
      user_slot: slot,
      agent_db_id,
      agent_id: agentId,
      status: meta?.status || 'active',
      is_main: tail === 'main' ? 1 : 0,
      message_count: meta?.messageCount || 0,
      total_tokens: meta?.totalTokens || 0,
      total_cost_krw: 0,
      file_path: sessionFile,
      created_at: meta?.createdAt || mtime,
      last_active_at: meta?.updatedAt || mtime,
      ts,
    };
  });
  tx(rows);
  return rows.length;
}

function upsertAllSessions(db) {
  let total = 0;
  for (let n = 1; n <= 99; n++) {
    const slot = String(n).padStart(2, '0');
    const userDir = path.join(DATA_ROOT, `user${slot}`, 'agents');
    if (!fs.existsSync(userDir)) continue;
    for (const ag of fs.readdirSync(userDir)) {
      total += upsertSessionsForAgent(db, slot, ag);
    }
  }
  return total;
}

module.exports = { upsertSessionsForAgent, upsertAllSessions };
```

- [ ] **Step 4: upsert-usage.js**

```js
// /opt/openclaw/scripts/admin-db/lib/upsert-usage.js
const fs = require('fs');
const path = require('path');
const { now } = require('./db');

const USAGE_ROOT = '/opt/openclaw/data/usage';

function upsertUsageFile(db, slot, dateStr) {
  const f = path.join(USAGE_ROOT, `user${slot}`, `${dateStr}.json`);
  if (!fs.existsSync(f)) return 0;
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return 0; }
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO api_usage_daily (user_slot, date, model, input_tokens, output_tokens, cache_read, cache_write, message_count, cost_usd, cost_krw, fx_rate, updated_at)
    VALUES (@user_slot, @date, @model, @input_tokens, @output_tokens, @cache_read, @cache_write, @message_count, @cost_usd, @cost_krw, @fx_rate, @ts)
    ON CONFLICT(user_slot, date, model) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      message_count = excluded.message_count,
      cost_usd = excluded.cost_usd,
      cost_krw = excluded.cost_krw,
      fx_rate = excluded.fx_rate,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r); });
  const byModel = data.byModel || {};
  const fx = data.fx || null;
  const rows = Object.entries(byModel).map(([model, m]) => ({
    user_slot: slot, date: dateStr, model,
    input_tokens: m.input || 0,
    output_tokens: m.output || 0,
    cache_read: m.cacheRead || 0,
    cache_write: m.cacheWrite || 0,
    message_count: m.messages || 0,
    cost_usd: m.costUsd || 0,
    cost_krw: m.costKrw || 0,
    fx_rate: fx,
    ts,
  }));
  tx(rows);
  return rows.length;
}

function upsertAllUsage(db) {
  if (!fs.existsSync(USAGE_ROOT)) return 0;
  let total = 0;
  for (const userDir of fs.readdirSync(USAGE_ROOT)) {
    const m = userDir.match(/^user(\d{2})$/);
    if (!m) continue;
    const slot = m[1];
    const dir = path.join(USAGE_ROOT, userDir);
    for (const file of fs.readdirSync(dir)) {
      const dm = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!dm) continue;
      total += upsertUsageFile(db, slot, dm[1]);
    }
  }
  return total;
}

module.exports = { upsertUsageFile, upsertAllUsage };
```

- [ ] **Step 5: upsert-fx.js**

```js
// /opt/openclaw/scripts/admin-db/lib/upsert-fx.js
const fs = require('fs');
const { now } = require('./db');

const PRICING = '/opt/openclaw/config/usage-pricing.json';

function upsertFxFromConfig(db) {
  if (!fs.existsSync(PRICING)) return 0;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(PRICING, 'utf8')); } catch { return 0; }
  const fx = cfg.fx;
  if (!fx || !fx.usdToKrw) return 0;
  const fetchedAt = fx.updatedAt ? Date.parse(fx.updatedAt) : now();
  // 같은 currency + fetched_at이 이미 있으면 skip (스냅샷 누적)
  const exist = db.prepare('SELECT id FROM fx_rates WHERE currency=? AND fetched_at=?').get('USD', fetchedAt);
  if (exist) return 0;
  db.prepare(`
    INSERT INTO fx_rates (currency, to_currency, rate, fetched_at, source)
    VALUES ('USD', 'KRW', ?, ?, ?)
  `).run(fx.usdToKrw, fetchedAt, 'config:usage-pricing.json');
  return 1;
}

module.exports = { upsertFxFromConfig };
```

- [ ] **Step 6: 일괄 동작 확인 (임시 DB로)**

```bash
node -e "
const {openDb} = require('/opt/openclaw/scripts/admin-db/lib/db');
const {upsertUsers} = require('/opt/openclaw/scripts/admin-db/lib/upsert-users');
const {upsertAllAgents} = require('/opt/openclaw/scripts/admin-db/lib/upsert-agents');
const {upsertAllSessions} = require('/opt/openclaw/scripts/admin-db/lib/upsert-sessions');
const {upsertAllUsage} = require('/opt/openclaw/scripts/admin-db/lib/upsert-usage');
const {upsertFxFromConfig} = require('/opt/openclaw/scripts/admin-db/lib/upsert-fx');
const db = openDb('/tmp/_seed_test.sqlite');
console.log('users:', upsertUsers(db));
console.log('agents:', upsertAllAgents(db));
console.log('sessions:', upsertAllSessions(db));
console.log('usage:', upsertAllUsage(db));
console.log('fx:', upsertFxFromConfig(db));
console.log('counts:', {
  users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  agents: db.prepare('SELECT COUNT(*) c FROM agents').get().c,
  sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
  usage: db.prepare('SELECT COUNT(*) c FROM api_usage_daily').get().c,
  fx: db.prepare('SELECT COUNT(*) c FROM fx_rates').get().c,
});
db.close();
"
rm /tmp/_seed_test.sqlite*
```

기대: `users: 15`, `agents: ~100`, `sessions: 수백`, `usage: ?`, `fx: 0 또는 1`. 모두 양수.

- [ ] **Step 7: Commit**

```bash
cd /root/openclaw-custom-platform
mkdir -p scripts/admin-db/lib
cp /opt/openclaw/scripts/admin-db/lib/upsert-*.js scripts/admin-db/lib/
git add scripts/admin-db/lib/upsert-*.js
git commit -m "feat(admin-db): UPSERT 함수 5개 (users/agents/sessions/usage/fx)"
```

---

## Task 4: seed.js (실 DB 시드)

**Files:**
- Create: `/opt/openclaw/scripts/admin-db/seed.js`

- [ ] **Step 1: seed.js 작성**

```js
// /opt/openclaw/scripts/admin-db/seed.js
const { openDb } = require('./lib/db');
const { upsertUsers } = require('./lib/upsert-users');
const { upsertAllAgents } = require('./lib/upsert-agents');
const { upsertAllSessions } = require('./lib/upsert-sessions');
const { upsertAllUsage } = require('./lib/upsert-usage');
const { upsertFxFromConfig } = require('./lib/upsert-fx');

(function main() {
  const db = openDb();
  const t0 = Date.now();
  const stats = {
    users: upsertUsers(db),
    agents: upsertAllAgents(db),
    sessions: upsertAllSessions(db),
    usage: upsertAllUsage(db),
    fx: upsertFxFromConfig(db),
  };
  const elapsed = Date.now() - t0;
  console.log(`[seed] done in ${elapsed}ms`, stats);
  console.log('[seed] table counts:', {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    agents: db.prepare('SELECT COUNT(*) c FROM agents').get().c,
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    usage: db.prepare('SELECT COUNT(*) c FROM api_usage_daily').get().c,
    fx: db.prepare('SELECT COUNT(*) c FROM fx_rates').get().c,
  });
  db.close();
})();
```

- [ ] **Step 2: 실 DB 시드 실행**

```bash
cd /opt/openclaw/scripts/admin-db && node seed.js
```

기대 출력:
- `[seed] done in <NNN>ms { users: 15, agents: ~100, sessions: 수백, usage: ?, fx: 0~1 }`
- `[seed] table counts: ...` (위 stats와 일치)
- 에러 없음
- DB 파일 생성 확인: `ls -lh /opt/openclaw/data/_admin.sqlite`

- [ ] **Step 3: 멱등성 검증 — 한 번 더 실행**

```bash
cd /opt/openclaw/scripts/admin-db && node seed.js
sqlite3 /opt/openclaw/data/_admin.sqlite "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM agents; SELECT COUNT(*) FROM sessions;"
```

기대: 두 번 실행해도 row count 동일 (UPSERT 멱등).

- [ ] **Step 4: Commit**

```bash
cd /root/openclaw-custom-platform
cp /opt/openclaw/scripts/admin-db/seed.js scripts/admin-db/seed.js
git add scripts/admin-db/seed.js
git commit -m "feat(admin-db): seed.js 일괄 마이그레이션 (멱등)"
```

---

## Task 5: verify.js (파일 vs DB count diff)

**Files:**
- Create: `/opt/openclaw/scripts/admin-db/verify.js`

- [ ] **Step 1: verify.js 작성**

```js
// /opt/openclaw/scripts/admin-db/verify.js
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
  for (let n = 1; n <= 99; n++) {
    const slot = String(n).padStart(2, '0');
    const cfg = path.join(DATA_ROOT, `user${slot}`, 'openclaw.json');
    if (fs.existsSync(cfg)) {
      const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      agents += (c.agents?.list || []).length;
    }
    const agDir = path.join(DATA_ROOT, `user${slot}`, 'agents');
    if (fs.existsSync(agDir)) {
      for (const a of fs.readdirSync(agDir)) {
        const sj = path.join(agDir, a, 'sessions', 'sessions.json');
        if (fs.existsSync(sj)) {
          try { sessions += Object.keys(JSON.parse(fs.readFileSync(sj, 'utf8'))).length; } catch { /* ignore */ }
        }
      }
    }
    const uDir = path.join(USAGE_ROOT, `user${slot}`);
    if (fs.existsSync(uDir)) {
      for (const f of fs.readdirSync(uDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(uDir, f), 'utf8'));
          usage += Object.keys(d.byModel || {}).length;
        } catch { /* ignore */ }
      }
    }
  }
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
```

- [ ] **Step 2: 실행**

```bash
cd /opt/openclaw/scripts/admin-db && node verify.js
echo "exit: $?"
```

기대: 모든 row `OK`, exit 0.

- [ ] **Step 3: Commit**

```bash
cd /root/openclaw-custom-platform
cp /opt/openclaw/scripts/admin-db/verify.js scripts/admin-db/verify.js
git add scripts/admin-db/verify.js
git commit -m "feat(admin-db): verify.js 파일 vs DB count diff 검증"
```

---

## Task 6: catchup.js (재시작/시간당 reconciliation)

**Files:**
- Create: `/opt/openclaw/scripts/admin-db/catchup.js`

- [ ] **Step 1: catchup.js 작성 (mtime 기반 부분 갱신)**

```js
// /opt/openclaw/scripts/admin-db/catchup.js
// Phase 1 단순 구현: 모든 매핑 파일에 대해 무조건 UPSERT 호출. 멱등.
// (mtime 비교 최적화는 Phase 2 — 지금 규모(수백 row)에선 단순 일괄이 빠르고 안전)
const { openDb } = require('./lib/db');
const { upsertUsers } = require('./lib/upsert-users');
const { upsertAllAgents } = require('./lib/upsert-agents');
const { upsertAllSessions } = require('./lib/upsert-sessions');
const { upsertAllUsage } = require('./lib/upsert-usage');
const { upsertFxFromConfig } = require('./lib/upsert-fx');

function catchup(dbOpt) {
  const ownDb = !dbOpt;
  const db = dbOpt || openDb();
  const t0 = Date.now();
  const stats = {
    users: upsertUsers(db),
    agents: upsertAllAgents(db),
    sessions: upsertAllSessions(db),
    usage: upsertAllUsage(db),
    fx: upsertFxFromConfig(db),
  };
  console.log(`[catchup] ${Date.now() - t0}ms`, stats);
  if (ownDb) db.close();
  return stats;
}

if (require.main === module) catchup();

module.exports = { catchup };
```

- [ ] **Step 2: 실행 + 멱등 확인**

```bash
cd /opt/openclaw/scripts/admin-db && node catchup.js
node verify.js
echo "exit: $?"
```

기대: catchup 로그 출력 + verify OK + exit 0.

- [ ] **Step 3: Commit**

```bash
cd /root/openclaw-custom-platform
cp /opt/openclaw/scripts/admin-db/catchup.js scripts/admin-db/catchup.js
git add scripts/admin-db/catchup.js
git commit -m "feat(admin-db): catchup.js 일괄 reconciliation"
```

---

## Task 7: watcher.js (chokidar 실시간 sync)

**Files:**
- Create: `/opt/openclaw/scripts/admin-db/watcher.js`

- [ ] **Step 1: watcher.js 작성**

```js
// /opt/openclaw/scripts/admin-db/watcher.js
const path = require('path');
const chokidar = require('chokidar');
const { openDb } = require('./lib/db');
const { upsertUsers } = require('./lib/upsert-users');
const { upsertAgentsForSlot } = require('./lib/upsert-agents');
const { upsertSessionsForAgent } = require('./lib/upsert-sessions');
const { upsertUsageFile } = require('./lib/upsert-usage');
const { upsertFxFromConfig } = require('./lib/upsert-fx');

const PATHS = {
  users: '/opt/openclaw/auth/users.json',
  fx: '/opt/openclaw/config/usage-pricing.json',
  dataRoot: '/opt/openclaw/data',
  usageRoot: '/opt/openclaw/data/usage',
};

const debounceMap = new Map();
function debounce(key, fn, ms = 300) {
  if (debounceMap.has(key)) clearTimeout(debounceMap.get(key));
  debounceMap.set(key, setTimeout(() => { debounceMap.delete(key); try { fn(); } catch (e) { console.error('[watcher]', key, e.message); } }, ms));
}

function startWatcher() {
  const db = openDb();
  console.log('[watcher] DB ready, starting chokidar...');

  const onUsersJson = () => debounce('users', () => { console.log('[watcher] users.json changed → UPSERT'); upsertUsers(db); });
  const onFxConfig  = () => debounce('fx',    () => { console.log('[watcher] pricing.json changed → fx UPSERT'); upsertFxFromConfig(db); });

  // 파일 path → slot/agent 추출
  const onDataChange = (filePath) => {
    const rel = path.relative(PATHS.dataRoot, filePath);
    // rel 예: 'user01/openclaw.json', 'user01/agents/secretary/sessions/sessions.json', 'user01/agents/secretary/sessions/<uuid>.jsonl'
    const m = rel.match(/^user(\d{2})\/(.+)$/);
    if (!m) return;
    const slot = m[1];
    const sub = m[2];
    if (sub === 'openclaw.json') {
      debounce(`agents:${slot}`, () => { console.log(`[watcher] user${slot} openclaw.json → agents UPSERT`); upsertAgentsForSlot(db, slot); });
      return;
    }
    const sm = sub.match(/^agents\/([^/]+)\/sessions\/(sessions\.json|.+\.jsonl)$/);
    if (sm) {
      const agentId = sm[1];
      debounce(`sessions:${slot}:${agentId}`, () => { console.log(`[watcher] user${slot}/${agentId} sessions changed → UPSERT`); upsertSessionsForAgent(db, slot, agentId); });
    }
  };

  const onUsageChange = (filePath) => {
    const rel = path.relative(PATHS.usageRoot, filePath);
    const m = rel.match(/^user(\d{2})\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) return;
    const [, slot, dateStr] = m;
    debounce(`usage:${slot}:${dateStr}`, () => { console.log(`[watcher] user${slot} usage ${dateStr} → UPSERT`); upsertUsageFile(db, slot, dateStr); });
  };

  chokidar.watch(PATHS.users,         { ignoreInitial: true }).on('all', onUsersJson);
  chokidar.watch(PATHS.fx,            { ignoreInitial: true }).on('all', onFxConfig);
  chokidar.watch(PATHS.dataRoot + '/user*/openclaw.json', { ignoreInitial: true }).on('all', (_, p) => onDataChange(p));
  chokidar.watch(PATHS.dataRoot + '/user*/agents/*/sessions/sessions.json', { ignoreInitial: true }).on('all', (_, p) => onDataChange(p));
  chokidar.watch(PATHS.dataRoot + '/user*/agents/*/sessions/*.jsonl', { ignoreInitial: true }).on('all', (_, p) => onDataChange(p));
  chokidar.watch(PATHS.usageRoot + '/user*/*.json', { ignoreInitial: true }).on('all', (_, p) => onUsageChange(p));

  console.log('[watcher] watching');
  return db;
}

if (require.main === module) startWatcher();

module.exports = { startWatcher };
```

- [ ] **Step 2: 백그라운드 실행 + 변경 감지 테스트**

```bash
cd /opt/openclaw/scripts/admin-db && node watcher.js > /tmp/watcher.log 2>&1 &
WPID=$!
sleep 2
# users.json touch (변경 없이 mtime만 갱신)
touch /opt/openclaw/auth/users.json
sleep 1
grep "users.json changed" /tmp/watcher.log && echo "DETECTED" || echo "MISSED"
kill $WPID 2>/dev/null
```

기대: `DETECTED`.

- [ ] **Step 3: Commit**

```bash
cd /root/openclaw-custom-platform
cp /opt/openclaw/scripts/admin-db/watcher.js scripts/admin-db/watcher.js
git add scripts/admin-db/watcher.js
git commit -m "feat(admin-db): chokidar watcher 실시간 sync + debounce"
```

---

## Task 8: automap-api.js에 DB 통합

**Files:**
- Modify: `/opt/openclaw/scripts/automap-api.js` (DB API 엔드포인트 + watcher 시작)

- [ ] **Step 1: 의존성 통합 (automap-api 폴더에 better-sqlite3 + chokidar 설치)**

```bash
# automap-api는 별도 package.json을 가지므로 거기에 의존성 추가
cd /opt/openclaw/scripts
# 이미 있는 package.json 확인
cat package.json
# 없으면 admin-db로 모듈 require하여 path 우회
```

라이브러리는 `/opt/openclaw/scripts/admin-db/node_modules/`에서 require로 호출 (별도 install 불필요).

- [ ] **Step 2: automap-api.js 상단 import + watcher 시작**

`/opt/openclaw/scripts/automap-api.js` 파일 상단(다른 require 아래)에 추가:

```js
const { openDb } = require('./admin-db/lib/db');
const { startWatcher } = require('./admin-db/watcher');
const { catchup } = require('./admin-db/catchup');

// DB 초기화 + 시작 시 catchup + watcher
let _adminDb;
function getAdminDb() {
  if (!_adminDb) {
    _adminDb = openDb();
    try { catchup(_adminDb); } catch (e) { console.error('[admin-db] catchup error:', e.message); }
    try { startWatcher(); } catch (e) { console.error('[admin-db] watcher error:', e.message); }
  }
  return _adminDb;
}
getAdminDb();
```

- [ ] **Step 3: DB API 엔드포인트 추가**

automap-api.js의 라우트 핸들러 부분 (다른 `/api/admin/...` 핸들러 옆)에 추가:

```js
// GET /api/admin/db/users
if (req.method === 'GET' && url.pathname === '/api/admin/db/users') {
  const rows = getAdminDb().prepare(`
    SELECT u.slot, u.email, u.name, u.status, u.updated_at,
           (SELECT COUNT(*) FROM agents a WHERE a.user_slot = u.slot AND a.status = 'active') AS agent_count,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_slot = u.slot AND s.status = 'active') AS session_count
    FROM users u
    ORDER BY u.slot
  `).all();
  return jsonRes(res, 200, { ok: true, users: rows });
}

// GET /api/admin/db/sessions?user=01&status=active
if (req.method === 'GET' && url.pathname === '/api/admin/db/sessions') {
  const u = url.searchParams.get('user') || null;
  const st = url.searchParams.get('status') || null;
  let q = 'SELECT id, session_key, user_slot, agent_id, status, is_main, message_count, total_tokens, last_active_at FROM sessions WHERE 1=1';
  const params = [];
  if (u) { q += ' AND user_slot = ?'; params.push(u); }
  if (st) { q += ' AND status = ?'; params.push(st); }
  q += ' ORDER BY last_active_at DESC LIMIT 500';
  const rows = getAdminDb().prepare(q).all(...params);
  return jsonRes(res, 200, { ok: true, sessions: rows });
}

// GET /api/admin/db/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&user=NN
if (req.method === 'GET' && url.pathname === '/api/admin/db/usage') {
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
  const rows = getAdminDb().prepare(q).all(...params);
  return jsonRes(res, 200, { ok: true, usage: rows });
}

// GET /api/admin/db/fx (latest USD→KRW)
if (req.method === 'GET' && url.pathname === '/api/admin/db/fx') {
  const row = getAdminDb().prepare(`
    SELECT currency, to_currency, rate, fetched_at, source
    FROM fx_rates
    WHERE currency = 'USD'
    ORDER BY fetched_at DESC LIMIT 1
  `).get();
  return jsonRes(res, 200, { ok: true, fx: row || null });
}
```

- [ ] **Step 4: automap-api 재시작 + 엔드포인트 동작 확인**

```bash
# automap-api는 보통 systemd 또는 docker-compose service로 동작
# (이전 메모리에 따라) 직접 재시작:
pkill -f "node /opt/openclaw/scripts/automap-api.js" || true
sleep 1
nohup node /opt/openclaw/scripts/automap-api.js > /tmp/automap.log 2>&1 &
sleep 3

# 테스트
curl -s http://localhost:18799/api/admin/db/users | head -c 500
echo ""
curl -s "http://localhost:18799/api/admin/db/sessions?user=01&status=active" | head -c 300
echo ""
curl -s "http://localhost:18799/api/admin/db/usage?from=2026-05-01&to=2026-05-08" | head -c 300
echo ""
curl -s "http://localhost:18799/api/admin/db/fx" | head -c 200
```

기대: 4개 엔드포인트 모두 `{"ok":true,...}` 응답.

- [ ] **Step 5: Commit**

```bash
cd /root/openclaw-custom-platform
mkdir -p scripts
cp /opt/openclaw/scripts/automap-api.js scripts/automap-api.js
git add scripts/automap-api.js
git commit -m "feat(automap-api): DB API 4개 엔드포인트 + watcher 시작 통합"
```

---

## Task 9: 어드민 UI 사용자/사용량 탭을 DB API로 전환

**Files:**
- Modify: `/root/openclaw-custom-platform/custom-ui/src/components/AdminPanel.tsx`

- [ ] **Step 1: 기존 fetch 호출을 DB API로 교체 (fallback 유지)**

기존 `fetchUsers` / `fetchUsage` 등의 fetch URL을 `/api/admin/users` → `/api/admin/db/users`로 교체. 응답 형태는 유사하므로 파싱 로직 minimal 변경. 실패 시 옛 경로로 fallback.

```ts
// 현재 fetchUsers 패턴 (의사코드):
const res = await fetch('/api/admin/users');

// 변경:
let res = await fetch('/api/admin/db/users');
if (!res.ok) res = await fetch('/api/admin/users');  // legacy fallback
```

`fetchUsage`, `fetchSessions` (있다면) 동일 패턴.

- [ ] **Step 2: 빌드 + 배포**

```bash
cd /root/openclaw-custom-platform/custom-ui && npm run build
cp -r dist/* /opt/openclaw/custom-ui/
docker exec openclaw-nginx nginx -s reload
docker exec openclaw-nginx grep -o 'index-[A-Za-z0-9_-]*\.js' /usr/share/nginx/custom-ui/index.html
```

- [ ] **Step 3: 어드민 페이지 테스트 (브라우저)**

`/admin/users`, `/admin/usage` 페이지가 정상 표시되는지 확인. 응답 시간이 이전(디렉토리 스캔)보다 빠른지 (1~10ms vs 1~3초) 체크.

- [ ] **Step 4: Commit**

```bash
cd /root/openclaw-custom-platform
git add custom-ui/src/components/AdminPanel.tsx
git commit -m "feat(admin-ui): users/usage 탭 DB API로 전환 (legacy fallback 유지)"
```

---

## Task 10: 백업 스크립트 + cron

**Files:**
- Create: `/opt/openclaw/scripts/backup-admin-db.sh`
- Modify: 호스트 crontab

- [ ] **Step 1: 백업 스크립트 작성**

`/opt/openclaw/scripts/backup-admin-db.sh`:

```bash
#!/bin/bash
set -euo pipefail
DB=/opt/openclaw/data/_admin.sqlite
DEST_DIR=/opt/openclaw/data
DATE=$(date +%Y%m%d)
if [ ! -f "$DB" ]; then
  echo "[backup-admin-db] DB 없음, skip"
  exit 0
fi
# WAL이 있으므로 sqlite3 .backup 권장 (atomic)
sqlite3 "$DB" ".backup '$DEST_DIR/_admin.sqlite.bak.$DATE'"
echo "[backup-admin-db] saved $DEST_DIR/_admin.sqlite.bak.$DATE"
# 7일 이상 백업 삭제
find "$DEST_DIR" -name "_admin.sqlite.bak.*" -mtime +7 -delete
echo "[backup-admin-db] cleaned old (>7d)"
```

권한:
```bash
chmod +x /opt/openclaw/scripts/backup-admin-db.sh
```

- [ ] **Step 2: 동작 테스트**

```bash
/opt/openclaw/scripts/backup-admin-db.sh
ls -lh /opt/openclaw/data/_admin.sqlite.bak.*
```

기대: 오늘자 백업 파일 생성.

- [ ] **Step 3: cron 등록 (host root crontab)**

```bash
# 기존 crontab 보존
crontab -l 2>/dev/null > /tmp/cron.bak
# 매일 02:30 + 매시간 catchup 추가
(crontab -l 2>/dev/null; echo "30 2 * * * /opt/openclaw/scripts/backup-admin-db.sh >> /var/log/openclaw-backup.log 2>&1") | crontab -
(crontab -l 2>/dev/null; echo "0 * * * * cd /opt/openclaw/scripts/admin-db && /usr/bin/node catchup.js >> /var/log/openclaw-catchup.log 2>&1") | crontab -
crontab -l | grep openclaw
```

기대: 두 줄 등장.

- [ ] **Step 4: Commit**

```bash
cd /root/openclaw-custom-platform
mkdir -p scripts
cp /opt/openclaw/scripts/backup-admin-db.sh scripts/backup-admin-db.sh
git add scripts/backup-admin-db.sh
git commit -m "feat(admin-db): 매일 백업 + 시간당 catchup cron"
```

---

## Task 11: 통합 검증

- [ ] **Step 1: end-to-end 검증 시나리오**

```bash
# 1. 임의 user의 sessions.json에 hand-edit (status 변경 등)
F=/opt/openclaw/data/user01/agents/secretary/sessions/sessions.json
cp $F $F.bak

# 2. 변경 → watcher가 자동 sync
node -e "const fs=require('fs');const o=JSON.parse(fs.readFileSync('$F','utf8'));const k=Object.keys(o)[0];o[k].messageCount=(o[k].messageCount||0)+1;fs.writeFileSync('$F',JSON.stringify(o,null,2));"
sleep 2

# 3. DB 확인
sqlite3 /opt/openclaw/data/_admin.sqlite "SELECT session_key,message_count FROM sessions WHERE user_slot='01' AND agent_id='secretary' LIMIT 3;"

# 4. 원복
mv $F.bak $F
sleep 2
sqlite3 /opt/openclaw/data/_admin.sqlite "SELECT session_key,message_count FROM sessions WHERE user_slot='01' AND agent_id='secretary' LIMIT 3;"
```

기대: 변경 후 message_count 증가, 원복 후 원래 값 복귀.

- [ ] **Step 2: 다운타임 확인**

```bash
# OpenClaw 컨테이너 healthy 유지
docker ps --filter "name=openclaw-user" --format '{{.Names}} {{.Status}}' | grep -v healthy && echo "ALERT" || echo "OK"

# 진행 중 사용자 채팅 영향 없는지 자체 점검 (브라우저에서 확인)
```

기대: 모든 user 컨테이너 healthy, 사용자 채팅 영향 0.

- [ ] **Step 3: 통합 push**

```bash
cd /root/openclaw-custom-platform && bash .git-push.sh master
```

---

## Self-Review

- 모든 task가 spec의 5개 테이블 + 단방향 sync + chokidar+catchup + 백업 정책을 cover. ✅
- placeholder/TBD 없음. ✅
- 함수 시그니처 일관성: `upsertUsers(db)`, `upsertAgentsForSlot(db, slot)`, `upsertAllAgents(db)` 등 모든 task에서 동일하게 사용. ✅
- 컨테이너 라이프사이클(soft delete) — `upsertUsers`의 inactive 로직, `upsertAgentsForSlot`의 archived 로직에서 구현. ✅

## 진행 방법

이 plan은 약 11개 task, 각 5분~30분 단위. 총 예상 작업 시간 4~6시간.

가장 빠른 방법: **Inline Execution** (Task 1부터 순차로, 각 task 끝에서 commit).
