# RDBMS Phase 1 — SQLite 기반 메타 인덱스 도입

**Date:** 2026-05-08
**Author:** TideClaw (develop@tideflo.com)
**Spec 위치:** `/root/openclaw-custom-platform/docs/specs/`
**관련 Task:** #26 (spec) → #27 (plan) → #28~#31 (구현)

## 배경

OpenClaw 멀티 사용자 인프라(15명, 단일 호스트)는 모든 데이터를 파일 기반(`/opt/openclaw/data/userNN/...`)으로 저장한다. 채팅 transcript(jsonl), 세션 메타(sessions.json), config(openclaw.json), 사용량(`data/usage/userNN/*.json`) 등이 디렉토리 트리에 분산.

이 구조의 한계가 운영 중 명확해졌다:
- **추적 불가**: orphan 세션, stale 파일 등이 디스크에 누적 → 사람이 수동 정리
- **검색 비효율**: "user08의 4월 이후 활동" 같은 쿼리 = 매번 grep + python script
- **변경 이력 X**: 누가 언제 무엇을 바꿨는지 알 수 없음
- **권한 모델 X**: 파일 chown 외 세션·에이전트 단위 권한 없음
- **통합 통계 X**: 어드민 사용량 추적이 매번 user01~15 디렉토리 전체 스캔

OpenClaw 코어 호환을 깨지 않으면서 이 문제를 풀기 위해 **파일은 진실(source-of-truth)로 유지하고 SQLite를 메타 인덱스로 도입**한다.

## 목표

- 어드민 페이지(사용자 / 사용량 / 향후 inventory)가 디렉토리 스캔 없이 SQL 쿼리 한 번으로 응답
- 파일 변경이 자동으로 DB에 반영 (실시간 + 누락 회복)
- OpenClaw 코어 동작 무영향
- 사용자(15명) 핵심 서비스 다운타임 0

## DB의 역할 (Phase 1)

DB는 단순 미러가 아니라 **"쿼리 가능한 미러"**:

| 작업 | 파일만 | DB |
|------|------|------|
| "user08 4월 이후 active 세션" | grep + script | `WHERE` 한 줄 (1ms) |
| 사용자별 모델별 일별 사용량 cross-tab | 매번 다 읽고 JS 집계 | `GROUP BY` 한 줄 |
| 어드민 응답 시간 | 1~3초 | 1~10ms |
| 정렬/필터/페이지네이션 | 매번 다 로드 | `ORDER BY/LIMIT` |

Phase 2부터는 DB가 파일에 없는 고유 데이터(audit_log, permissions, file_index)도 보관 — 그때부터 DB가 일부 영역에서 source-of-truth가 됨.

## 비목표 (Phase 1 범위 밖)

- 채팅 transcript 본문(jsonl) 자체를 DB로 옮기는 것 — 별도 phase
- 변경 이력 audit_log 테이블 — Phase 2
- 권한/ACL 모델 — Phase 2
- file inventory 테이블 — Phase 2
- DB → 파일 양방향 sync — 본 spec 범위 밖

## 아키텍처

```
┌────────────────────────────────────────────────────────────────────┐
│                       호스트 파일 시스템 (진실)                      │
│                                                                     │
│  /opt/openclaw/auth/users.json                                     │
│  /opt/openclaw/data/userNN/openclaw.json                           │
│  /opt/openclaw/data/userNN/agents/<id>/sessions/sessions.json      │
│  /opt/openclaw/data/usage/userNN/YYYY-MM-DD.json                   │
│  /opt/openclaw/config/usage-pricing.json                           │
└───────┬────────────────────────────────────────────────────────────┘
        │
        │ chokidar watcher (실시간) + 시작 시 catchup + 시간당 cron 안전망
        ▼
┌────────────────────────────────────────────────────────────────────┐
│             /opt/openclaw/data/_admin.sqlite (인덱스)               │
│                                                                     │
│  users / agents / sessions / api_usage_daily / fx_rates             │
└───────┬────────────────────────────────────────────────────────────┘
        │
        │ better-sqlite3 read
        ▼
┌────────────────────────────────────────────────────────────────────┐
│  automap-api.js (Node)                                             │
│  - GET /api/admin/db/users                                         │
│  - GET /api/admin/db/sessions?user=01&status=active                │
│  - GET /api/admin/db/usage?from=YYYY-MM-DD&to=YYYY-MM-DD           │
└───────┬────────────────────────────────────────────────────────────┘
        │
        ▼
   custom-ui (어드민 탭들)
```

## 스키마

모든 timestamp는 `INTEGER` (unix epoch milliseconds) — OpenClaw 내부 표기와 일치.
soft-delete는 Phase 1에서 사용 안 함 (YAGNI). orphan/archived는 `status` 컬럼으로 표현.

```sql
CREATE TABLE users (
  slot         TEXT PRIMARY KEY,           -- '01' ~ '15'
  email        TEXT UNIQUE,                -- nullable (미할당 슬롯 가능)
  name         TEXT,
  status       TEXT DEFAULT 'active',      -- 'active' | 'inactive'
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE agents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slot    TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,              -- 'secretary', 'developer' 등 OpenClaw agent id
  agent_type   TEXT NOT NULL,              -- 'secretary' | 'developer' | 'reviewer' | 'planner' | 'marketer' | 'legal' | 'custom'
  name         TEXT,                       -- 표시명 ('비서')
  model        TEXT,                       -- 'moonshot/kimi-k2.6'
  is_default   INTEGER DEFAULT 0,          -- 0/1
  status       TEXT DEFAULT 'active',      -- 'active' | 'archived'
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(user_slot, agent_id)
);
CREATE INDEX idx_agents_user ON agents(user_slot);
CREATE INDEX idx_agents_type ON agents(agent_type);

CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key     TEXT UNIQUE NOT NULL,    -- 'agent:secretary:main', 'agent:secretary:17782245'
  user_slot       TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  agent_db_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  agent_id        TEXT NOT NULL,           -- redundant이지만 빠른 조회용
  status          TEXT DEFAULT 'active',   -- 'active' | 'ended' | 'orphan' | 'archived'
  is_main         INTEGER DEFAULT 0,       -- 0/1 (session_key가 ':main'이면 1)
  message_count   INTEGER DEFAULT 0,
  total_tokens    INTEGER DEFAULT 0,
  total_cost_krw  REAL DEFAULT 0,
  file_path       TEXT,                    -- 'data/user01/agents/secretary/sessions/<uuid>.jsonl'
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_slot);
CREATE INDEX idx_sessions_agent ON sessions(agent_db_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_last_active ON sessions(last_active_at DESC);

CREATE TABLE api_usage_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slot       TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  date            TEXT NOT NULL,           -- 'YYYY-MM-DD' (KST)
  model           TEXT NOT NULL,           -- 'moonshot/kimi-k2.6'
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  cache_read      INTEGER DEFAULT 0,
  cache_write     INTEGER DEFAULT 0,
  message_count   INTEGER DEFAULT 0,
  cost_usd        REAL DEFAULT 0,
  cost_krw        REAL DEFAULT 0,
  fx_rate         REAL,                    -- 그날 적용된 환율 (감사용 스냅샷)
  updated_at      INTEGER NOT NULL,
  UNIQUE(user_slot, date, model)
);
CREATE INDEX idx_usage_date ON api_usage_daily(date);
CREATE INDEX idx_usage_user_date ON api_usage_daily(user_slot, date);

CREATE TABLE fx_rates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  currency     TEXT NOT NULL,              -- 'USD'
  to_currency  TEXT NOT NULL DEFAULT 'KRW',
  rate         REAL NOT NULL,
  fetched_at   INTEGER NOT NULL,
  source       TEXT                        -- 'open.er-api.com'
);
CREATE INDEX idx_fx_currency_time ON fx_rates(currency, fetched_at DESC);
```

### FK 관계

```
users (slot) ─┬─< agents (user_slot)         ON DELETE CASCADE
              ├─< sessions (user_slot)        ON DELETE CASCADE
              └─< api_usage_daily (user_slot) ON DELETE CASCADE

agents (id) ──< sessions (agent_db_id)        ON DELETE SET NULL
```

ON DELETE 정책:
- **users 삭제** → 그 슬롯의 agents/sessions/usage 모두 CASCADE 삭제
- **agents 삭제** → sessions의 agent_db_id가 NULL로 변경 (세션 데이터는 보존, FK 끊김)

## 데이터 흐름

### 파일 → DB 매핑

| 파일 | 테이블 | 처리 함수 |
|------|--------|-----------|
| `auth/users.json` | `users` | UPSERT (email + slot) |
| `data/userNN/openclaw.json` (`agents.list`) | `agents` | UPSERT (user_slot + agent_id) |
| `data/userNN/agents/<id>/sessions/sessions.json` | `sessions` | UPSERT (session_key) per session entry |
| `data/userNN/agents/<id>/sessions/<uuid>.jsonl` | `sessions` | mtime/file_path 갱신 |
| `data/usage/userNN/YYYY-MM-DD.json` | `api_usage_daily` | UPSERT (user + date + model) |
| `config/usage-pricing.json` (`fx.usdToKrw`) | `fx_rates` | INSERT (스냅샷) |

### chokidar + catchup 결합

automap-api 프로세스 lifecycle:

```
1. 시작 시:
   ├─ DB 파일 없으면: migrations/001_initial.sql 적용
   ├─ Background catchup: 모든 매핑 파일 스캔, mtime > DB.updated_at인 항목만 UPSERT
   └─ chokidar watch 시작 (paths: 위 테이블의 파일들)

2. 운영 중:
   ├─ chokidar 'add' / 'change' / 'unlink' → 해당 파일 처리 함수 호출
   ├─ 같은 파일 100ms 내 중복 이벤트는 debounce
   └─ 한 번에 많은 변경 (e.g. 컨테이너 재생성) 발생 시 BEGIN TRANSACTION 일괄 처리

3. 매시간 (cron):
   └─ 안전망 catchup 스캔 (chokidar 누락 또는 inotify overflow 대비)
```

### inotify 한도

`/etc/sysctl.d/99-openclaw.conf`에 추가:

```
fs.inotify.max_user_watches=262144
fs.inotify.max_user_instances=512
```

## 어드민 UI 영향

기존 동작은 유지 (fallback). 새 DB API를 우선 호출, 실패 시 옛 디렉토리 스캔.

| 탭 | 변경 |
|----|------|
| 사용자 (Users) | `GET /api/admin/db/users` (users + agents JOIN) |
| 사용량 (Usage) | `GET /api/admin/db/usage?from=&to=&user=` (api_usage_daily 쿼리) |
| 세션 통계 (신규, 가벼움) | `GET /api/admin/db/sessions?user=&status=` (Phase 2 inventory의 mini 버전) |

## 컨테이너 라이프사이클

### 슬롯 추가 (예: user16 신규)

```
1. docker-compose.yml에 user16 서비스 추가 + 기동
2. /opt/openclaw/data/user16 디렉토리 자동 생성 (compose mount 시)
3. /opt/openclaw/auth/users.json에 매핑 추가:
   { "newuser@tideflo.com": "16" }
4. chokidar가 users.json 변경 감지 → users INSERT
5. OpenClaw 컨테이너 시작 시 default openclaw.json + 6개 default agents 자동 생성
6. chokidar가 그 파일들 감지 → agents/sessions INSERT
```

**DB에 default row 미리 안 넣음.** OpenClaw 본가 코드가 default 책임지고 DB는 그 결과 미러링.

### 슬롯 삭제 — soft delete 정책

`users.json`에서 슬롯 매핑 제거 시:
- `users.status = 'inactive'` 마킹 (행 삭제 X)
- `agents` / `sessions` / `api_usage_daily` 모두 그대로 보존 (감사·통계용)
- 어드민 페이지에선 inactive 사용자는 별도 섹션으로 표시
- 진입은 차단 (gateway_token 발급 안 됨)

ON DELETE CASCADE는 `users` 행이 hard delete될 때만 발동. 운영 정책상 hard delete 안 함.

향후 hard delete 필요 시: 어드민 페이지에 "사용자 데이터 영구 삭제" 명시적 버튼 추가 (Phase 2).

## 마이그레이션 전략

1. `migrations/001_initial.sql` 적용 → 빈 DB 생성
2. `seed.js` 실행 — 모든 user01~15 디렉토리 + auth/users.json + config/usage-pricing.json + data/usage/* 스캔, 위 매핑대로 INSERT
3. chokidar 시작 → 이후 파일 변경은 자동 반영
4. 검증: 파일 카운트 vs DB row 카운트 일치 확인 (verify-admin-db.js)

마이그레이션 멱등성: `seed.js` 두 번 실행해도 같은 결과 (UPSERT 기반).

## 백업 + 복구

`/opt/openclaw/scripts/backup-admin-db.sh`:

```bash
#!/bin/bash
DB=/opt/openclaw/data/_admin.sqlite
DATE=$(date +%Y%m%d)
cp -p "$DB" "$DB.bak.$DATE"
# 7일 이상된 백업 삭제
find /opt/openclaw/data -name "_admin.sqlite.bak.*" -mtime +7 -delete
```

cron: 매일 02:30 KST 실행.

복구: `cp _admin.sqlite.bak.YYYYMMDD _admin.sqlite` 후 catchup 한 번 (백업 시점 이후 변경분 흡수).

DB 손상 시: 파일이 진실이라 언제든 `rm _admin.sqlite && seed.js`로 재생성 가능.

## 에러 처리

| 시나리오 | 처리 |
|----------|------|
| DB 파일 corruption | 자동 백업으로 복구 + seed.js로 재생성 가능 |
| chokidar watch 실패 (inotify overflow) | 시간당 cron catchup이 안전망 |
| 같은 파일 동시 변경 race | UPSERT (`INSERT ... ON CONFLICT DO UPDATE`) — idempotent |
| automap-api 다운 | 재시작 시 catchup이 다운 동안 변경분 흡수 |
| seed.js 실행 중 파일 변경 | UPSERT라 마지막 값 적용, 다음 chokidar 이벤트로 정정 |

## 테스트

- 마이그레이션 멱등성: `seed.js` 두 번 실행 시 결과 동일
- 어드민 API 호환성: DB API 응답 vs 옛 디렉토리 스캔 결과 동일
- catchup 정확성: chokidar 끄고 파일 변경 → 재시작 시 정확히 반영
- FK CASCADE: users 한 슬롯 삭제 시 그 슬롯 agents/sessions/usage 모두 사라짐
- ON DELETE SET NULL: agent 삭제 시 sessions.agent_db_id NULL이지만 row 보존

## 다운타임 영향

| 컴포넌트 | 영향 | 시간 |
|----------|------|------|
| OpenClaw 컨테이너 (user01~15) | 안 건드림 | 0 |
| 진행 중 채팅 / ws 연결 | 안 건드림 | 0 |
| automap-api 재시작 | 어드민 페이지 보조 API만 | 1~3초 |
| nginx | 안 건드림 | 0 |

## 향후 확장 (Phase 2 이후)

- `audit_log` 테이블 — 변경 이력
- `file_index` 테이블 — orphan/inventory 추적
- `permissions` 테이블 — 슬롯·세션 단위 권한
- `cron_jobs` / `cron_runs` 테이블 — 예약 작업 메타
- DB 마스터 모드 검토 (사용자 수 100명+ 도달 시)
- PostgreSQL 마이그레이션 가능성 (현재 스키마는 표준 SQL이라 호환됨)

## 관련 파일

- 마이그레이션: `/opt/openclaw/scripts/admin-db/migrations/001_initial.sql` (구현 시 생성)
- seed: `/opt/openclaw/scripts/admin-db/seed.js`
- watcher: `/opt/openclaw/scripts/admin-db/watcher.js`
- API: `automap-api.js` 내부 새 엔드포인트
- 백업: `/opt/openclaw/scripts/backup-admin-db.sh`
- 검증: `/opt/openclaw/scripts/admin-db/verify.js`
