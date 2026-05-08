#!/bin/bash
set -euo pipefail

DB=/opt/openclaw/data/_admin.sqlite
DEST_DIR=/opt/openclaw/data
DATE=$(date +%Y%m%d)

if [ ! -f "$DB" ]; then
  echo "[backup-admin-db] DB 없음, skip"
  exit 0
fi

# WAL 모드라 atomic 백업 위해 sqlite3 .backup 사용
sqlite3 "$DB" ".backup '$DEST_DIR/_admin.sqlite.bak.$DATE'"
echo "[backup-admin-db] saved $DEST_DIR/_admin.sqlite.bak.$DATE"

# 7일 이상 백업 삭제
find "$DEST_DIR" -name "_admin.sqlite.bak.*" -mtime +7 -delete
echo "[backup-admin-db] cleaned old (>7d)"
