#!/bin/bash
# OpenClaw 로그 자동 정리
# - cron 실행 이력(jsonl): 30일 초과 삭제
# - agent 세션(jsonl): 60일 초과 삭제 (sessions.json 인덱스는 보존)
# - exec 임시 산출물(/tmp/*.json, /home/node/*.txt): 7일 초과 삭제
# 실행: 호스트 crontab (매일 새벽 3시)

set -e

LOG_FILE="/var/log/openclaw-cleanup.log"
CRON_RUNS_DAYS="${CRON_RUNS_DAYS:-30}"
SESSIONS_DAYS="${SESSIONS_DAYS:-60}"
TEMP_FILES_DAYS="${TEMP_FILES_DAYS:-7}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log "=== cleanup start ==="
TOTAL_CRON=0
TOTAL_SESSIONS=0
TOTAL_TMP=0

for u in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15; do
  container="openclaw-user$u"

  # 컨테이너 실행 중인지 확인
  if ! docker ps --format '{{.Names}}' | grep -q "^$container$"; then
    log "  $container: skipped (not running)"
    continue
  fi

  # 1. cron 실행 이력 정리
  CRON_COUNT=$(docker exec "$container" find /home/node/.openclaw/cron/runs -name '*.jsonl' -mtime +${CRON_RUNS_DAYS} 2>/dev/null | wc -l)
  if [ "$CRON_COUNT" -gt 0 ]; then
    docker exec "$container" find /home/node/.openclaw/cron/runs -name '*.jsonl' -mtime +${CRON_RUNS_DAYS} -delete 2>/dev/null || true
    TOTAL_CRON=$((TOTAL_CRON + CRON_COUNT))
  fi

  # 2. 오래된 agent 세션 정리 (.jsonl + .jsonl.reset.*)
  SESSION_COUNT=$(docker exec "$container" find /home/node/.openclaw/agents -path '*/sessions/*.jsonl*' -mtime +${SESSIONS_DAYS} 2>/dev/null | wc -l)
  if [ "$SESSION_COUNT" -gt 0 ]; then
    docker exec "$container" find /home/node/.openclaw/agents -path '*/sessions/*.jsonl*' -mtime +${SESSIONS_DAYS} -delete 2>/dev/null || true
    TOTAL_SESSIONS=$((TOTAL_SESSIONS + SESSION_COUNT))
  fi

  # 3. 에이전트 산출 임시 파일 (/tmp, /home/node 루트)
  #    성능 리포트 등 오래 된 것
  TMP_COUNT=$(docker exec "$container" bash -c "find /tmp -maxdepth 2 -type f \\( -name '*.json' -o -name '*.txt' -o -name 'measure*.js' \\) -mtime +${TEMP_FILES_DAYS} 2>/dev/null | wc -l")
  if [ "$TMP_COUNT" -gt 0 ]; then
    docker exec "$container" bash -c "find /tmp -maxdepth 2 -type f \\( -name '*.json' -o -name '*.txt' -o -name 'measure*.js' \\) -mtime +${TEMP_FILES_DAYS} -delete 2>/dev/null" || true
    TOTAL_TMP=$((TOTAL_TMP + TMP_COUNT))
  fi
done

log "  cron runs deleted: $TOTAL_CRON (>$CRON_RUNS_DAYS days)"
log "  sessions deleted: $TOTAL_SESSIONS (>$SESSIONS_DAYS days)"
log "  tmp files deleted: $TOTAL_TMP (>$TEMP_FILES_DAYS days)"
log "=== cleanup end ==="
