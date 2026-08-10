-- per-user memories DB schema
-- 각 사용자 컨테이너에 mount되는 단일 DB 파일.
-- /opt/openclaw/data/userNN/memories.db ↔ /home/node/.openclaw/memories.db

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 메모리 본체. 하나의 사실/약속/결정/관찰.
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT NOT NULL DEFAULT 'general',  -- person:김부장 / project:bidforge / general 등
  subject       TEXT NOT NULL,                    -- 짧은 제목
  body          TEXT NOT NULL,                    -- 본문 (자세한 내용)
  tags          TEXT,                             -- JSON array (예: '["미팅","약속"]')
  source        TEXT,                             -- chat / cron / extension 등
  source_ref    TEXT,                             -- 세션ID 또는 cron job id 등
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_used_at  INTEGER,                          -- recall 시 갱신 (LRU stale 감지용)
  use_count     INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER                           -- TTL (NULL이면 영구)
);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_last_used ON memories(last_used_at DESC);

-- FTS5 인덱스 — subject + body + tags 통합 full-text 검색.
-- 외부 컨텐츠 모드 (memories와 동기화).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  subject, body, tags,
  content='memories',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- 트리거: memories 변경 시 FTS 자동 동기화
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, subject, body, tags) VALUES (new.id, new.subject, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, body, tags) VALUES('delete', old.id, old.subject, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, body, tags) VALUES('delete', old.id, old.subject, old.body, old.tags);
  INSERT INTO memories_fts(rowid, subject, body, tags) VALUES (new.id, new.subject, new.body, new.tags);
END;

-- 메타 (스키마 버전 등)
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO _meta(key, value) VALUES ('schema_version', '1');
INSERT OR REPLACE INTO _meta(key, value) VALUES ('created_at', strftime('%s','now') * 1000);
