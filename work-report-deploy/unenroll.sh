#!/bin/bash
set -e
NN="$1"; FEATURE_ID="work-report"
[ -z "$NN" ] && { echo "사용법: $0 <userNN>"; exit 2; }
DATA_DIR="/opt/openclaw/data/user${NN}"
[ -f "${DATA_DIR}/openclaw.json" ] || { echo "user${NN} openclaw.json 없음"; exit 2; }
python3 - <<PYEOF
import json, os, shutil, tempfile, datetime, sys

cfg_path = "${DATA_DIR}/openclaw.json"

# 선검증: 원본이 유효한 JSON이 아니면 아무것도 하지 않고 종료
try:
    with open(cfg_path, encoding='utf-8') as f:
        cfg = json.loads(f.read())
except Exception as e:
    print(f"  오류: openclaw.json 이 유효한 JSON이 아닙니다 ({e}). 중단합니다.")
    sys.exit(1)

agents = cfg.get('agents', {}).get('list', [])
cfg.setdefault('agents', {})['list'] = [a for a in agents if a['id'] != "${FEATURE_ID}"]
sec = next((a for a in cfg['agents']['list'] if a['id'] == 'secretary'), None)
if sec:
    allow = sec.get('subagents', {}).get('allowAgents', [])
    if "${FEATURE_ID}" in allow: allow.remove("${FEATURE_ID}")

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

print(f"  백업: {backup_path}")
print("  에이전트 제거 완료 (work-report/ 데이터 디렉터리와 workspace 는 보존)")
PYEOF
echo "[$(date)] user${NN} work-report 비활성화 완료"
