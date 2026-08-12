#!/bin/bash
# openclaw.json 파일 변경 감지 → 에이전트 목록 변경 시 자동 sync
# systemd 서비스로 등록하여 상시 실행

OPENCLAW_DIR="/opt/openclaw"
STATE_DIR="/opt/openclaw/scripts/.agent-state"
SYNC_SCRIPT="/opt/openclaw/scripts/sync-agents.sh"

mkdir -p "$STATE_DIR"

# 초기 상태 저장
for i in $(seq -w 1 14); do
  config="$OPENCLAW_DIR/data/user${i}/openclaw.json"
  state_file="$STATE_DIR/user${i}.agents"
  [ ! -f "$config" ] && continue
  python3 -c "
import json
with open('$config') as f:
    c = json.load(f)
ids = sorted([a['id'] for a in c.get('agents',{}).get('list',[])])
print(','.join(ids))
" > "$state_file" 2>/dev/null
done

echo "[$(date)] watch-agents 시작"

# openclaw.json 변경 감지
inotifywait -m -e modify -e moved_to -r --include 'openclaw\.json$' "$OPENCLAW_DIR/data/" 2>/dev/null | while read dir event file; do
  # userNN 추출
  nn=$(echo "$dir" | grep -oP 'user\K[0-9]{2}')
  [ -z "$nn" ] && continue

  config="$OPENCLAW_DIR/data/user${nn}/openclaw.json"
  state_file="$STATE_DIR/user${nn}.agents"

  # 현재 에이전트 목록
  current=$(python3 -c "
import json
with open('$config') as f:
    c = json.load(f)
ids = sorted([a['id'] for a in c.get('agents',{}).get('list',[])])
print(','.join(ids))
" 2>/dev/null)

  previous=""
  [ -f "$state_file" ] && previous=$(cat "$state_file")

  if [ "$current" != "$previous" ]; then
    echo "[$(date)] user${nn}: 에이전트 변경 감지 (${previous} → ${current})"
    "$SYNC_SCRIPT" "$nn"
    echo "$current" > "$state_file"
    echo "[$(date)] user${nn}: 동기화 완료"
  fi
done
