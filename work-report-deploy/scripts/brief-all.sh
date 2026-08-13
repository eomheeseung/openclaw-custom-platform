#!/usr/bin/env bash
# 아침 브리핑 — 켜둔 사용자에게만 보낸다.
# 타이머가 30분마다 깨우고, 실제 발송 여부(설정 시각·오늘 중복)는 brief.py 가 판단한다.
# 사람마다 출근 시간이 달라 타이머 하나로 시각을 못 정한다.
set -u
for d in /opt/openclaw/data/user*/work-report/config.json; do
  nn=$(echo "$d" | sed -n 's#.*/user\([0-9]\+\)/.*#\1#p')
  c="openclaw-user${nn}"
  docker ps --format '{{.Names}}' | grep -qx "$c" || continue
  out=$(docker exec -u node "$c" python3 /home/node/documents/work-report/scripts/brief.py --send 2>&1)
  echo "user${nn}: ${out}"
done
