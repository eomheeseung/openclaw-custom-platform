#!/bin/bash
set -e
DEPLOY_DIR="/opt/openclaw/work-report-deploy"
FEATURE_ID="work-report"
NN="$1"
[ -z "$NN" ] && { echo "사용법: $0 <userNN>"; exit 2; }
DATA_DIR="/opt/openclaw/data/user${NN}"
[ -f "${DATA_DIR}/openclaw.json" ] || { echo "user${NN} openclaw.json 없음"; exit 2; }

python3 - <<PYEOF
import json
cfg_path = "${DATA_DIR}/openclaw.json"
with open(cfg_path) as f: cfg = json.load(f)
with open("${DEPLOY_DIR}/features.json") as f: manifest = json.load(f)
feature = next(x for x in manifest['features'] if x['id'] == "${FEATURE_ID}")
agents = cfg.setdefault('agents', {}).setdefault('list', [])
existing = next((a for a in agents if a['id'] == "${FEATURE_ID}"), None)
if existing: existing.update(feature['agent_config'])
else: agents.append(feature['agent_config'])
sec = next((a for a in agents if a['id'] == 'secretary'), None)
if sec:
    allow = sec.setdefault('subagents', {}).setdefault('allowAgents', [])
    if "${FEATURE_ID}" not in allow: allow.append("${FEATURE_ID}")
with open(cfg_path, 'w') as f: json.dump(cfg, f, ensure_ascii=False, indent=2)
print("  에이전트 등록 완료")
PYEOF

WR_DIR="${DATA_DIR}/work-report"
if [ ! -f "${WR_DIR}/config.json" ]; then
  mkdir -p "$WR_DIR"
  python3 -c "
import json
m=json.load(open('${DEPLOY_DIR}/features.json'))
f=next(x for x in m['features'] if x['id']=='${FEATURE_ID}')
json.dump(f['data_init']['content'], open('${WR_DIR}/config.json','w'), ensure_ascii=False, indent=2)
"
  chmod 700 "$WR_DIR"; chmod 600 "${WR_DIR}/config.json"
  chown -R tideclaw:tideclaw "$WR_DIR"
fi

WORKSPACE="${DATA_DIR}/workspace-${FEATURE_ID}"
mkdir -p "$WORKSPACE"; chmod 777 "$WORKSPACE"
cp "${DEPLOY_DIR}/SOUL.template.md" "${WORKSPACE}/SOUL.md"; chmod 666 "${WORKSPACE}/SOUL.md"
chown -R tideclaw:tideclaw "$WORKSPACE"
echo "[$(date)] user${NN} work-report 활성화 완료"
