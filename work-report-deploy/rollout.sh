#!/usr/bin/env bash
# 업무보고 배포 — enroll.sh 가 못 하는 것까지 한 번에.
#
#  · enroll.sh 는 openclaw.json 을 파싱 후 재작성한다. 주석이 있는 사용자(user07·13)는
#    "유효한 JSON 아님" 으로 중단되고, 통과하더라도 temperature 금지 주석이 지워진다.
#    그래서 여기서는 **텍스트로 삽입**해 주석을 보존한다.
#  · 소속·직책·수신자·브리핑 설정은 enroll.sh 에 없다. 비어 있으면 에이전트가
#    소속을 지어내고(실측: AI팀) 발송이 막힌다.
#
# 사용법: ./rollout.sh <userNN>
set -euo pipefail
NN="${1:-}"
[ -z "$NN" ] && { echo "사용법: $0 <userNN>"; exit 2; }
DEPLOY=/opt/openclaw/work-report-deploy
DATA=/opt/openclaw/data/user${NN}
[ -f "$DATA/openclaw.json" ] || { echo "user${NN} openclaw.json 없음"; exit 2; }

cp "$DATA/openclaw.json" "$DATA/openclaw.json.wr-bak.$(date +%Y%m%d-%H%M%S)"

# ⚠ 컨테이너를 먼저 멈춘다. 실행 중에 openclaw.json 을 고치면 게이트웨이가 외부 변경으로
#   보고 last-good 으로 되돌린다 — 내 수정은 .clobbered.* 로 밀려난다(실측: user06).
docker stop "openclaw-user${NN}" >/dev/null
echo "  컨테이너 정지"

python3 - "$NN" <<'PY'
import json, os, re, sys, tempfile

nn = sys.argv[1]
data = f"/opt/openclaw/data/user{nn}"
deploy = "/opt/openclaw/work-report-deploy"
feat = next(x for x in json.load(open(f"{deploy}/features.json"))["features"]
            if x["id"] == "work-report")

# ── 1. 에이전트 등록 (주석 보존을 위해 텍스트 삽입) ───────────────────────────
p = f"{data}/openclaw.json"
s = open(p, encoding="utf-8").read()
if '"id": "work-report"' in s:
    print("  에이전트 이미 등록됨 — 건너뜀")
else:
    block = "\n".join("      " + l for l in
                      json.dumps(feat["agent_config"], ensure_ascii=False, indent=2).splitlines())
    # agents.list 의 닫는 대괄호를 **괄호를 세어** 찾는다.
    # 정규식으로 "]" 를 잡으면 secretary 의 allowAgents 안에 들어간다(실측: user06).
    am = re.search(r'"agents"\s*:\s*\{', s)
    lm = re.search(r'"list"\s*:\s*\[', s[am.end():]) if am else None
    if not lm:
        raise SystemExit("  agents.list 를 찾지 못했습니다 — 수동 확인 필요")
    depth, i = 1, am.end() + lm.end()
    while i < len(s) and depth:
        if s[i] == '[': depth += 1
        elif s[i] == ']': depth -= 1
        i += 1
    close = i - 1
    head = s[:close].rstrip()
    s = head + ",\n" + block + "\n" + s[close:]
    sm = re.search(r'"allowAgents"\s*:\s*\[([^\]]*)\]', s)      # 비서의 위임 허용
    if sm and "work-report" not in sm.group(1):
        sep = ", " if sm.group(1).strip() else ""
        s = s[:sm.end(1)] + f'{sep}"work-report"' + s[sm.end(1):]
    st = os.stat(p)
    fd, tmp = tempfile.mkstemp(dir=data, prefix=".openclaw.json.tmp.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(s); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp, st.st_mode); os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, p)
    json.loads(re.sub(r"^\s*//.*$", "", open(p, encoding="utf-8").read(), flags=re.M))  # 검증
    print("  에이전트 등록 완료")

# ── 2. config.json — 기본값 + 소속·직책 + 수신자 + 브리핑 ────────────────────
cfg_dir = f"{data}/work-report"
cfg_path = f"{cfg_dir}/config.json"
os.makedirs(cfg_dir, exist_ok=True)
cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else json.loads(
    json.dumps(feat["data_init"]["content"]))
prof = json.load(open(f"{deploy}/profiles.json"))["profiles"].get(nn)
if not prof:
    raise SystemExit(f"  profiles.json 에 user{nn} 이 없습니다")
cfg["profile"] = prof
cfg.setdefault("recipients", {})
cfg["recipients"]["to"] = ["blueyooe@tideflo.com"]        # 전원 공통
cfg["recipients"].setdefault("cc", [])
cfg["tools"] = feat["data_init"]["content"]["tools"]      # 6종 — 미연동은 조용히 건너뛴다
cfg["brief"] = {"enabled": True, "time": "10:00"}
json.dump(cfg, open(cfg_path, "w"), ensure_ascii=False, indent=2)
os.chmod(cfg_dir, 0o700); os.chmod(cfg_path, 0o600)
os.chown(cfg_dir, 1000, 1000); os.chown(cfg_path, 1000, 1000)
print(f"  설정 완료 — {prof['team']} {prof['name']} {prof['title']}")
PY

SCRIPTS="/opt/openclaw/shared/user${NN}/work-report/scripts"
mkdir -p "$SCRIPTS"
cp "$DEPLOY/scripts/"*.py "$SCRIPTS/"
chmod +x "$SCRIPTS/"*.py
chown -R tideclaw:tideclaw "/opt/openclaw/shared/user${NN}/work-report"

W="$DATA/workspace-work-report"
mkdir -p "$W"; chmod 777 "$W"
cp "$DEPLOY/SOUL.template.md" "$W/SOUL.md"; chmod 666 "$W/SOUL.md"
chown -R tideclaw:tideclaw "$W"
echo "  스크립트·SOUL 배포"

docker start "openclaw-user${NN}" >/dev/null
echo "  컨테이너 기동 — 대기"
for _ in $(seq 1 20); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:180${NN}/" || true)
  [ "$code" = "200" ] && break
done
echo "user${NN} 배포 완료 (HTTP ${code:-?})"

BOT=$(python3 -c "import json;print((json.load(open('$DATA/integrations.json')).get('dooray') or {}).get('botUrl','') and 'O' or 'X')" 2>/dev/null || echo X)
[ "$BOT" = "X" ] && echo "  ⚠ 두레이 봇 URL 미등록 — 아침 브리핑·알림·두레이 지시가 동작하지 않습니다 (본인이 외부 연동에서 등록)"
