#!/bin/bash
set -e
DEPLOY_DIR="/opt/openclaw/work-report-deploy"
FEATURE_ID="work-report"
NN="$1"
[ -z "$NN" ] && { echo "사용법: $0 <userNN>"; exit 2; }
DATA_DIR="/opt/openclaw/data/user${NN}"
[ -f "${DATA_DIR}/openclaw.json" ] || { echo "user${NN} openclaw.json 없음"; exit 2; }

python3 - <<PYEOF
import json, os, shutil, tempfile, datetime, sys

cfg_path = "${DATA_DIR}/openclaw.json"

# 선검증: 원본이 유효한 JSON이 아니면 아무것도 하지 않고 종료
try:
    with open(cfg_path, encoding='utf-8') as f:
        raw = f.read()
    cfg = json.loads(raw)
except Exception as e:
    print(f"  오류: openclaw.json 이 유효한 JSON이 아닙니다 ({e}). 중단합니다.")
    sys.exit(1)

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

# 쓰기 전 백업
backup_path = cfg_path + ".bak." + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
shutil.copy2(cfg_path, backup_path)

# 원자적 치환: 같은 디렉터리에 임시 파일로 쓴 뒤 os.replace 로 바꿔치기
st = os.stat(cfg_path)
cfg_dir = os.path.dirname(cfg_path) or "."
fd, tmp_path = tempfile.mkstemp(dir=cfg_dir, prefix=".openclaw.json.tmp.")
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp_path, st.st_mode)
    os.chown(tmp_path, st.st_uid, st.st_gid)
    os.replace(tmp_path, cfg_path)
except Exception:
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    raise

print(f"  에이전트 등록 완료 (백업: {os.path.basename(backup_path)})")
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

# 수집·초안 스크립트 배포 (컨테이너에서 /home/node/documents/work-report/scripts 로 보임)
SHARED_SCRIPTS="/opt/openclaw/shared/user${NN}/work-report/scripts"
mkdir -p "$SHARED_SCRIPTS"
cp "${DEPLOY_DIR}/scripts/"*.py "$SHARED_SCRIPTS/"
chmod +x "$SHARED_SCRIPTS/"*.py
chown -R tideclaw:tideclaw "/opt/openclaw/shared/user${NN}/work-report"
echo "  스크립트 배포"

WORKSPACE="${DATA_DIR}/workspace-${FEATURE_ID}"
mkdir -p "$WORKSPACE"; chmod 777 "$WORKSPACE"
cp "${DEPLOY_DIR}/SOUL.template.md" "${WORKSPACE}/SOUL.md"; chmod 666 "${WORKSPACE}/SOUL.md"
chown -R tideclaw:tideclaw "$WORKSPACE"
echo "[$(date)] user${NN} work-report 활성화 완료"
