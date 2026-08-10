/* per-user memories DB helper.
   각 사용자의 DB는 /opt/openclaw/data/userNN/memories.db (호스트 기준).
   컨테이너 bind mount 통해 동일 파일로 노출됨. */

const path = require('path');
const fs = require('fs');

/* better-sqlite3는 admin-db 모듈의 node_modules에서 공유 사용 — 중복 설치 피함 */
const Database = require(path.join(__dirname, '..', '..', 'admin-db', 'node_modules', 'better-sqlite3'));

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '001_initial.sql');
const DATA_ROOT = '/opt/openclaw/data';

/* per-user connection 캐시 — 같은 process에서 같은 user db는 재사용 */
const _connCache = new Map(); // userNN -> Database instance

function dbPathFor(userNN) {
  return path.join(DATA_ROOT, `user${userNN}`, 'memories.db');
}

/* 해당 user의 메모리 DB 열기. 없으면 schema 적용해서 생성. */
function openMemoryDb(userNN) {
  if (_connCache.has(userNN)) return _connCache.get(userNN);

  const dbPath = dbPathFor(userNN);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fresh = !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  if (fresh) {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(sql);
  } else {
    /* 기존 DB에 새 migration 적용 (idempotent — CREATE IF NOT EXISTS) */
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    try { db.exec(sql); } catch { /* CREATE TRIGGER 같은 건 IF NOT EXISTS 무시 안 함 — 첫 init 후엔 catch만 */ }
  }

  _connCache.set(userNN, db);
  return db;
}

function closeAll() {
  for (const [, db] of _connCache) {
    try { db.close(); } catch { /* ignore */ }
  }
  _connCache.clear();
}

module.exports = { openMemoryDb, dbPathFor, closeAll };
