#!/bin/bash
set -e
NN="$1"; FEATURE_ID="work-report"
[ -z "$NN" ] && { echo "사용법: $0 <userNN>"; exit 2; }
DATA_DIR="/opt/openclaw/data/user${NN}"
python3 - <<PYEOF
import json
p = "${DATA_DIR}/openclaw.json"
cfg = json.load(open(p))
agents = cfg.get('agents', {}).get('list', [])
cfg['agents']['list'] = [a for a in agents if a['id'] != "${FEATURE_ID}"]
sec = next((a for a in cfg['agents']['list'] if a['id'] == 'secretary'), None)
if sec:
    allow = sec.get('subagents', {}).get('allowAgents', [])
    if "${FEATURE_ID}" in allow: allow.remove("${FEATURE_ID}")
json.dump(cfg, open(p,'w'), ensure_ascii=False, indent=2)
print("  에이전트 제거 완료 (config.json 데이터는 보존)")
PYEOF
echo "[$(date)] user${NN} work-report 비활성화 완료"
