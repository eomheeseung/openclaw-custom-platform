# 업무보고 에이전트 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개인 주간보고를 비서에서 분리해 `업무보고` 서브에이전트로 만들고, 사업 주간보고까지 비서 경유로 통일한다.

**Architecture:** 서브에이전트는 **데이터 생성기**다 — 툴을 조회해 `draft.json`을 파일로 남기기만 한다. 비서가 그 파일을 읽어 카드를 발행하고, 사용자 수정을 받아 파일을 갱신하며, 메일 발송까지 담당한다. 사용자는 비서 화면에서만 대화한다.

**Tech Stack:** Python 3 (수집·생성 스크립트) · Node.js (automap-api) · React/TypeScript (custom-ui) · OpenClaw 에이전트 설정(JSON5) · bash (배포 스크립트)

## Global Constraints

- **대상은 user02(손재민) 컨테이너 하나뿐.** 테스트 완료 전까지 다른 컨테이너를 건드리지 않는다.

### ⚠ 격리 규칙 (위반 시 전 사용자 영향)

**1. `sync-agents.sh`는 반드시 인자와 함께 실행한다.**
```bash
/opt/openclaw/scripts/sync-agents.sh 02     # ✅ user02만
/opt/openclaw/scripts/sync-agents.sh        # ❌ user01~14 전부 동기화됨
```
인자를 빼면 `for i in $(seq -w 1 14)` 분기를 타서 **14명 전부**에게 배포된다.

**2. `watch-agents.sh`가 상시 감시 중이다.**
`openclaw-watch-agents.service`가 `inotifywait`로 모든 `data/user*/openclaw.json`을 보고 있다가,
에이전트 목록이 바뀌면 **해당 사용자만** 자동 sync한다. user02 파일만 수정하면 user02만 돈다 — 안전하다.
단 **다른 사용자 `openclaw.json`을 실수로 건드리면 즉시 그 사용자가 sync된다.**

**3. 전역 파일 2개는 "수정해도 즉시 반영되지 않는다"는 점을 이용한다.**

| 파일 | 성격 | 반영 시점 |
|---|---|---|
| `scripts/sync-agents.sh` (`keyword_map`) | 전역 | 각 사용자를 sync할 때 |
| `business-report-deploy/SOUL.template.md` | 전역 템플릿 | 사용자 workspace로 **복사할 때** |

두 파일 모두 **수정 자체는 다른 컨테이너에 영향이 없다.** 단 수정 후 다른 사용자가 에이전트를
추가/삭제하면 watcher가 그 사용자를 sync하면서 새 `keyword_map`이 딸려 들어간다.
추가되는 건 `business-report`·`work-report` 키워드 두 줄이고, `work-report`가 없는 사용자에게는
위임 규칙표에 줄이 생기지 않으므로(생성 대상이 `non_root_web` 목록 기준) 실질 피해는 없다.

**4. 작업 전후로 다른 컨테이너 설정 해시를 대조한다.** (Task 1 Step 0 · Task 11 Step 0)
- 모든 사용자 대면 문구는 **한국어**.
- **`temperature` 파라미터 금지** — Moonshot K2/K3는 HTTP 400 (only 1 allowed), Anthropic Sonnet5/Opus5는 deprecated. 추론 강도는 `agents.defaults.thinkingLevel`(effort)로만 조정한다.
- **메일 발송 주체는 비서뿐.** 업무보고 에이전트는 초안까지만 만든다.
- **SR 시스템은 개인 업무보고에서 제외.** SR 목록에 처리 담당자 컬럼이 없어(`sr_no·title·requester·status·priority·created_at·updated_at·closed_at·channel`) 같은 사업 타인의 처리 건이 섞인다. SR 기반 보고는 `business-report` 전용.
- **메일 제목은 회사 표준** `[주간보고][YYYY-MM-DD~YYYY-MM-DD]팀이름 이름 직책` — `(AI)` 표기 금지.
- **메일 본문은 기존 텍스트 양식 유지** (`■ 완료` / `■ 진행 · 차주 계획` / `■ 업무 - AI 툴 활용`). 표 형태로 바꾸지 않는다.
- **cron 타임존은 `Asia/Seoul` 고정.**
- 에이전트 ID는 `work-report`, 표시명은 **`업무보고`**, 이모지 `📝`.
- 담당 사업은 **관리자가 일괄 등록**, 사용 툴은 **개인이 선택**.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `/opt/openclaw/work-report-deploy/features.json` | 에이전트 매니페스트 (설정·경로) |
| `/opt/openclaw/work-report-deploy/enroll.sh` | 사용자별 활성화 |
| `/opt/openclaw/work-report-deploy/unenroll.sh` | 비활성화·롤백 |
| `/opt/openclaw/work-report-deploy/SOUL.template.md` | 업무보고 에이전트 시스템 프롬프트 |
| `/opt/openclaw/work-report-deploy/scripts/collect.py` | 툴별 수집 → 원시 항목 리스트 |
| `/opt/openclaw/work-report-deploy/scripts/dedupe.py` | 중복 병합 + 노이즈 압축 |
| `/opt/openclaw/work-report-deploy/scripts/build_draft.py` | 초안 조립 → `draft.json` 저장 |
| `/opt/openclaw/work-report-deploy/scripts/run_log.py` | 실행 이력 기록·조회 |
| `/opt/openclaw/data/businesses.json` | **사업 마스터** (전 사용자 공용, 관리자 등록) |
| `/opt/openclaw/data/userNN/work-report/config.json` | 개인 설정 (담당 사업·사용 툴·수신자) |
| `/opt/openclaw/data/userNN/work-report/draft.json` | 이번 회차 초안 |
| `/opt/openclaw/data/userNN/work-report/runs.json` | 실행 이력 |
| `custom-ui/src/components/WorkReportCards.tsx` | `work-draft` 카드 렌더링 |
| `custom-ui/src/components/WorkReportSettings.tsx` | 담당 업무 설정 화면 |

---

## Task 1: 배포 스캐폴딩 + 에이전트 등록

**Files:**
- Create: `/opt/openclaw/work-report-deploy/features.json`
- Create: `/opt/openclaw/work-report-deploy/enroll.sh`
- Create: `/opt/openclaw/work-report-deploy/unenroll.sh`
- Create: `/opt/openclaw/work-report-deploy/SOUL.template.md`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: user02 `openclaw.json`에 `work-report` 에이전트 등록 · `/opt/openclaw/data/user02/workspace-work-report/SOUL.md` 배치

- [ ] **Step 0: 작업 전 기준선 스냅샷 (다른 컨테이너 무영향 증명용)**

```bash
mkdir -p /tmp/wr-baseline
for nn in $(seq -w 1 16); do
  f=/opt/openclaw/data/user$nn/openclaw.json
  [ -f "$f" ] && md5sum "$f"
done > /tmp/wr-baseline/openclaw.md5
for nn in $(seq -w 1 16); do
  f=/opt/openclaw/shared/user$nn/AGENTS.md
  [ -f "$f" ] && md5sum "$f"
done > /tmp/wr-baseline/agents.md5
wc -l /tmp/wr-baseline/*.md5
```
Expected: 두 파일에 각각 15~16줄. Task 11에서 이 값과 대조한다.

- [ ] **Step 1: features.json 작성**

```bash
mkdir -p /opt/openclaw/work-report-deploy/scripts
cat > /opt/openclaw/work-report-deploy/features.json <<'EOF'
{
  "version": 1,
  "features": [
    {
      "id": "work-report",
      "name": "업무보고",
      "emoji": "📝",
      "description": "두레이·Gmail·캘린더·드라이브·GitHub·Figma 집계 → 개인 주간보고 초안",
      "soul_template": "/opt/openclaw/work-report-deploy/SOUL.template.md",
      "scripts_dir": "/opt/openclaw/work-report-deploy/scripts",
      "agent_config": {
        "id": "work-report",
        "default": false,
        "name": "업무보고",
        "identity": { "name": "업무보고", "emoji": "📝" },
        "subagents": { "allowAgents": [] },
        "tools": {},
        "workspace": "/home/node/.openclaw/workspace-work-report",
        "agentDir": "/home/node/.openclaw/agents/work-report/agent"
      },
      "data_init": {
        "path": "work-report/config.json",
        "content": {
          "tools": ["dooray", "gmail", "calendar"],
          "dooray_member_id": "",
          "github": { "owner": "", "repo": "" },
          "profile": { "team": "", "name": "", "title": "" },
          "recipients": { "to": [], "cc": [] },
          "schedule": { "enabled": false, "expr": "0 17 * * 4", "tz": "Asia/Seoul" }
        }
      },
      "current_version": "v1",
      "created_at": "2026-08-10"
    }
  ]
}
EOF
```

- [ ] **Step 2: SOUL.template.md 작성 — 데이터 생성기 역할만**

```bash
cat > /opt/openclaw/work-report-deploy/SOUL.template.md <<'EOF'
# 핵심 규칙 (절대 위반 금지)
- 반드시 한국어로 답변해.
- 너는 **데이터 생성기**다. 사용자와 직접 대화하지 않는다.
- 카드(fenced code block)를 뱉지 마. 화면 표시는 비서가 한다.
- 메일을 보내지 마. 발송은 비서만 한다.
- 결과는 **draft.json 파일 경로와 요약**만 반환해.

# 역할
개인 주간보고 초안을 만든다. 비서가 sessions_spawn 으로 호출하면 아래를 수행한다.

## 실행 순서
1. 설정 읽기: `exec({"command": "cat /home/node/.openclaw/work-report/config.json"})`
2. 초안 생성:
   `exec({"command": "python3 /home/node/documents/work-report/scripts/build_draft.py <from> <to>"})`
3. 반환: 생성된 draft.json 경로 + 항목 수 요약 한 줄

## 절대 금지
- SR 시스템 조회 — 처리 담당자 구분이 안 되므로 개인 보고에서 제외한다 (사업 주간보고 전용)
- 설정에 없는 툴 조회
- 항목 내용을 지어내기 — 수집 결과에 없으면 넣지 않는다
EOF
```

- [ ] **Step 3: enroll.sh 작성**

```bash
cat > /opt/openclaw/work-report-deploy/enroll.sh <<'SH'
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
SH
chmod +x /opt/openclaw/work-report-deploy/enroll.sh
```

- [ ] **Step 4: unenroll.sh 작성 (롤백용)**

```bash
cat > /opt/openclaw/work-report-deploy/unenroll.sh <<'SH'
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
SH
chmod +x /opt/openclaw/work-report-deploy/unenroll.sh
```

- [ ] **Step 5: user02에 적용하고 등록 확인**

Run:
```bash
/opt/openclaw/work-report-deploy/enroll.sh 02
python3 -c "
import json
cfg=json.load(open('/opt/openclaw/data/user02/openclaw.json'))
ids=[a['id'] for a in cfg['agents']['list']]
sec=next(a for a in cfg['agents']['list'] if a['id']=='secretary')
print('에이전트:', ids)
print('secretary allowAgents:', sec['subagents']['allowAgents'])
"
```
Expected:
```
에이전트: ['secretary', 'reporter', 'bid-reviewer', 'business-report', 'work-report']
secretary allowAgents: ['reporter', 'bid-reviewer', 'business-report', 'work-report']
```

- [ ] **Step 6: 커밋**

```bash
cd /root/openclaw-custom-platform
git add docs/plans/2026-08-10-work-report-agent.md
git commit -m "docs: 업무보고 에이전트 구현 플랜"
```

---

## Task 2: 사업 마스터 + 개인 설정 데이터

**Files:**
- Create: `/opt/openclaw/data/businesses.json`
- Modify: `/opt/openclaw/scripts/automap-api.js` (엔드포인트 4개 추가)

**Interfaces:**
- Consumes: Task 1의 `work-report/config.json` 구조
- Produces:
  - `GET  /api/work-report/businesses` → `{ok, businesses:[{id,name,org,figma_file_keys,dooray_project_id}]}`
  - `POST /api/work-report/businesses` → 마스터 등록 (관리자)
  - `GET  /api/work-report/config?userNN=NN` → 개인 설정
  - `PUT  /api/work-report/config?userNN=NN` → 개인 설정 저장

- [ ] **Step 1: 사업 마스터 초기 파일 생성**

기존 사업 등록분을 마스터로 승격한다. `dooray_project_id`는 각 사용자 `business-report/*/meta.json`에 이미 있다.

```bash
cat > /opt/openclaw/data/businesses.json <<'EOF'
{
  "version": 1,
  "businesses": [
    {
      "id": "biz-sports",
      "name": "대한체육회 e진로지원센터",
      "org": "대한체육회",
      "dooray_project_id": "4332881555667186223",
      "figma_file_keys": [],
      "members": ["02", "13"]
    },
    {
      "id": "biz-smoking",
      "name": "금연서비스 통합정보시스템",
      "org": "한국건강증진개발원",
      "dooray_project_id": "",
      "figma_file_keys": [],
      "members": ["13"]
    }
  ]
}
EOF
chown tideclaw:tideclaw /opt/openclaw/data/businesses.json
chmod 644 /opt/openclaw/data/businesses.json
```

- [ ] **Step 2: 조회 엔드포인트 추가**

`/opt/openclaw/scripts/automap-api.js`에서 `/api/admin/keys` 핸들러 **바로 앞**에 삽입한다.

```javascript
  /* GET /api/work-report/businesses — 사업 마스터 (전 사용자 공용) */
  if (req.method === 'GET' && url.pathname === '/api/work-report/businesses') {
    try {
      const d = JSON.parse(fs.readFileSync('/opt/openclaw/data/businesses.json', 'utf8'));
      jsonRes(res, 200, { ok: true, businesses: d.businesses || [] });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* GET /api/work-report/config — 개인 설정 (담당 사업·사용 툴·수신자) */
  if (req.method === 'GET' && url.pathname === '/api/work-report/config') {
    const nn = resolveUserNN(req, url);
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const p = `/opt/openclaw/data/user${nn}/work-report/config.json`;
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      /* 담당 사업은 마스터에서 역참조 — 관리자가 businesses.json 에만 등록하면 반영됨 */
      const master = JSON.parse(fs.readFileSync('/opt/openclaw/data/businesses.json', 'utf8'));
      const mine = (master.businesses || []).filter(b => (b.members || []).includes(nn));
      jsonRes(res, 200, { ok: true, config: cfg, businesses: mine });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* PUT /api/work-report/config — 사용 툴·수신자·스케줄만 저장 (담당 사업은 관리자 전용) */
  if (req.method === 'PUT' && url.pathname === '/api/work-report/config') {
    const nn = resolveUserNN(req, url);
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    readBody(req).then(body => {
      const p = `/opt/openclaw/data/user${nn}/work-report/config.json`;
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(body.tools)) cur.tools = body.tools;
      if (body.recipients) cur.recipients = body.recipients;
      if (body.schedule) cur.schedule = body.schedule;
      fs.writeFileSync(p, JSON.stringify(cur, null, 2));
      jsonRes(res, 200, { ok: true, config: cur });
    }).catch(e => jsonRes(res, 500, { ok: false, error: e.message }));
    return;
  }
```

- [ ] **Step 3: `readBody` 헬퍼 존재 확인**

Run: `grep -n "function readBody\|const readBody" /opt/openclaw/scripts/automap-api.js | head -2`
Expected: 정의가 1개 이상 출력됨. 없으면 아래를 파일 상단 헬퍼 영역에 추가한다.

```javascript
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
```

- [ ] **Step 4: 문법 검사 + 재시작**

Run:
```bash
node --check /opt/openclaw/scripts/automap-api.js && systemctl restart openclaw-automap-api && sleep 3 && systemctl is-active openclaw-automap-api
```
Expected: `active`

- [ ] **Step 5: 엔드포인트 동작 확인**

Run:
```bash
curl -s http://localhost:18799/api/work-report/businesses | python3 -m json.tool | head -20
```
Expected: `"ok": true` 와 `biz-sports`, `biz-smoking` 두 건

- [ ] **Step 6: 커밋**

```bash
cd /root/openclaw-custom-platform
git add -A && git commit -m "feat(work-report): 사업 마스터 + 개인 설정 API"
```

---

## Task 3: 툴별 수집 스크립트

**Files:**
- Create: `/opt/openclaw/work-report-deploy/scripts/collect.py`

**Interfaces:**
- Consumes: Task 2의 `config.json` (`tools`, 담당 사업의 `dooray_project_id`·`figma_file_keys`)
- Produces: `collect(tools, businesses, date_from, date_to) -> list[dict]`
  각 항목 = `{"text": str, "source": str, "url": str|None, "biz_id": str|None, "at": str, "status": "done"|"wip"}`

- [ ] **Step 1: 실패 테스트 작성**

```bash
mkdir -p /opt/openclaw/work-report-deploy/tests
cat > /opt/openclaw/work-report-deploy/tests/test_collect.py <<'EOF'
import sys, json, subprocess
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from collect import normalize_item, tool_enabled

def test_normalize_item_keeps_required_keys():
    raw = {"subject": "확인서 오류 수정", "id": "142", "updatedAt": "2026-08-05T10:00:00+09:00"}
    it = normalize_item(raw, source="dooray", biz_id="biz-sports",
                        url="https://dooray.com/task/1/142", status="done")
    assert it["text"] == "확인서 오류 수정"
    assert it["source"] == "dooray"
    assert it["url"].endswith("/142")
    assert it["biz_id"] == "biz-sports"
    assert it["status"] == "done"

def test_tool_enabled_respects_config():
    assert tool_enabled(["dooray", "gmail"], "dooray") is True
    assert tool_enabled(["dooray", "gmail"], "figma") is False

def test_sr_is_never_enabled():
    """SR 은 개인 업무보고에서 영구 제외 — 설정에 있어도 무시"""
    assert tool_enabled(["dooray", "sr"], "sr") is False
EOF
```

- [ ] **Step 2: 실패 확인**

Run: `cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_collect.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'collect'`

- [ ] **Step 3: collect.py 구현**

```python
cat > /opt/openclaw/work-report-deploy/scripts/collect.py <<'EOF'
#!/usr/bin/env python3
"""툴별 수집 → 정규화된 항목 리스트.

⚠ SR 시스템은 영구 제외한다. SR 목록에 처리 담당자 컬럼이 없어
  (sr_no·title·requester·status·priority·created_at·updated_at·closed_at·channel)
  같은 사업 타인의 처리 건까지 섞인다. SR 기반 보고는 business-report 전용.
"""
import json
import subprocess

BLOCKED_TOOLS = {"sr"}          # 설정에 있어도 무시
KNOWN_TOOLS = ["dooray", "gmail", "calendar", "drive", "github", "figma"]


def tool_enabled(tools, name):
    if name in BLOCKED_TOOLS:
        return False
    return name in (tools or [])


def normalize_item(raw, source, biz_id=None, url=None, status="done"):
    """툴별 응답을 공통 항목 형태로. text 는 필수, 나머지는 없으면 None."""
    text = (raw.get("subject") or raw.get("title") or raw.get("name")
            or raw.get("summary") or "").strip()
    at = (raw.get("updatedAt") or raw.get("date") or raw.get("modified")
          or raw.get("start") or "")
    return {"text": text, "source": source, "url": url,
            "biz_id": biz_id, "at": at, "status": status}


def _run(cmd):
    """gog/dooray CLI 실행 → dict. 실패하면 None (조용한 실패 방지용으로 호출부에서 기록)."""
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True,
                             text=True, timeout=60).stdout
        d = json.loads(out)
        return d if isinstance(d, dict) and d.get("ok") is not False else None
    except Exception:
        return None


def collect_dooray(biz, member_id):
    """담당자(member_id) 기준 필터 — dooray tasks 는 memberIds 파라미터를 지원한다."""
    pid = biz.get("dooray_project_id")
    if not pid or not member_id:
        return []
    items = []
    for status, mapped in (("done", "done"), ("working", "wip")):
        d = _run(f"dooray tasks {pid} 50 {status} {member_id}")
        for t in (d or {}).get("tasks", []):
            url = f"https://tideflo.dooray.com/task/{pid}/{t.get('id')}"
            items.append(normalize_item(t, "dooray", biz["id"], url, mapped))
    return items


def collect_gmail(date_from, date_to):
    d = _run(f'gog mail search "after:{date_from} before:{date_to}" --max 50')
    items = []
    for m in (d or {}).get("messages", []):
        url = f"https://mail.google.com/mail/u/0/#all/{m.get('id')}"
        items.append(normalize_item(m, "gmail", None, url, "done"))
    return items


def collect_calendar(days=7):
    d = _run(f"gog calendar list {days}")
    items = []
    for e in (d or {}).get("events", []):
        items.append(normalize_item(e, "calendar", None, e.get("htmlLink"), "done"))
    return items


def collect_drive(days=7):
    d = _run(f"gog drive recent {days}")
    items = []
    for f in (d or {}).get("files", []):
        url = f"https://drive.google.com/file/d/{f.get('id')}/view"
        items.append(normalize_item(f, "drive", None, url, "done"))
    return items


def collect_github(owner, repo, date_from, date_to):
    """본인 커밋만. gh CLI 는 연동 토큰으로 인증된 상태여야 한다."""
    if not owner or not repo:
        return []
    cmd = (f'gh api "/repos/{owner}/{repo}/commits'
           f'?author=@me&since={date_from}T00:00:00Z&until={date_to}T23:59:59Z" 2>/dev/null')
    try:
        import subprocess as sp
        out = sp.run(cmd, shell=True, capture_output=True, text=True, timeout=60).stdout
        rows = json.loads(out)
        if not isinstance(rows, list):
            return []
    except Exception:
        return []
    items = []
    for c in rows:
        msg = (c.get("commit") or {}).get("message", "").split("\n")[0]
        items.append(normalize_item({"title": msg, "date": (c.get("commit") or {})
                                     .get("author", {}).get("date")},
                                    "github", None, c.get("html_url"), "done"))
    return items


def collect_figma(file_keys, member_name):
    """등록된 파일의 버전 이력에서 본인 것만.
    Figma API 는 팀 활동 피드를 주지 않아 파일 key 를 미리 등록해야 한다."""
    items = []
    for key in file_keys or []:
        d = _run(f'figma versions {key}')
        for v in (d or {}).get("versions", []):
            who = ((v.get("user") or {}).get("handle") or "")
            if member_name and member_name not in who:
                continue
            items.append(normalize_item(
                {"title": v.get("label") or "디자인 작업", "date": v.get("created_at")},
                "figma", None, f"https://www.figma.com/file/{key}", "done"))
    return items


def collect(tools, businesses, date_from, date_to, member_id=None,
            github=None, figma_name=None):
    """활성화된 툴만 조회. 각 툴 결과 건수를 함께 반환해 실패를 드러낸다."""
    items, stats = [], {}
    if tool_enabled(tools, "dooray"):
        got = []
        for b in businesses:
            got += collect_dooray(b, member_id)
        items += got
        stats["dooray"] = len(got)
    if tool_enabled(tools, "gmail"):
        got = collect_gmail(date_from, date_to)
        items += got
        stats["gmail"] = len(got)
    if tool_enabled(tools, "calendar"):
        got = collect_calendar()
        items += got
        stats["calendar"] = len(got)
    if tool_enabled(tools, "drive"):
        got = collect_drive()
        items += got
        stats["drive"] = len(got)
    if tool_enabled(tools, "github"):
        g = github or {}
        got = collect_github(g.get("owner"), g.get("repo"), date_from, date_to)
        items += got
        stats["github"] = len(got)
    if tool_enabled(tools, "figma"):
        keys = []
        for b in businesses:
            keys += b.get("figma_file_keys") or []
        got = collect_figma(keys, figma_name)
        items += got
        stats["figma"] = len(got)
    return items, stats
EOF
chmod +x /opt/openclaw/work-report-deploy/scripts/collect.py
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_collect.py -v`
Expected: `3 passed`

- [ ] **Step 5: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat(work-report): 툴별 수집 스크립트 (SR 제외)"
```

---

## Task 4: 중복 제거 + 노이즈 압축

**Files:**
- Create: `/opt/openclaw/work-report-deploy/scripts/dedupe.py`

**Interfaces:**
- Consumes: Task 3의 `collect()` 결과 (`list[dict]`)
- Produces:
  - `merge_duplicates(items) -> list[dict]` — 병합 항목은 `sources: list[{source,url}]` 를 갖는다
  - `compress_minor(items, threshold=3) -> list[dict]` — 사소 항목 묶음은 `{"text": "문구·오탈자 수정 등 N건", "merged_count": N}`

- [ ] **Step 1: 실패 테스트 작성**

```bash
cat > /opt/openclaw/work-report-deploy/tests/test_dedupe.py <<'EOF'
import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from dedupe import merge_duplicates, compress_minor, similarity

def _it(text, source, url=None, at="2026-08-05T10:00:00+09:00"):
    return {"text": text, "source": source, "url": url, "biz_id": "b1",
            "at": at, "status": "done"}

def test_similar_titles_merge_into_one():
    items = [
        _it("교육훈련비 확인서 오류 수정", "dooray", "u1"),
        _it("교육훈련비 확인서 오류 관련 회신", "gmail", "u2"),
    ]
    out = merge_duplicates(items)
    assert len(out) == 1
    assert len(out[0]["sources"]) == 2
    assert {s["source"] for s in out[0]["sources"]} == {"dooray", "gmail"}

def test_unrelated_items_stay_separate():
    items = [_it("확인서 오류 수정", "dooray"), _it("서버 이전 작업", "dooray")]
    assert len(merge_duplicates(items)) == 2

def test_far_apart_in_time_not_merged():
    items = [
        _it("확인서 오류 수정", "dooray", at="2026-08-01T10:00:00+09:00"),
        _it("확인서 오류 수정", "gmail",  at="2026-08-07T10:00:00+09:00"),
    ]
    assert len(merge_duplicates(items)) == 2

def test_minor_items_compressed():
    items = [_it(f"문구 수정 {i}", "dooray") for i in range(4)] + [_it("서버 이전 작업", "dooray")]
    out = compress_minor(items, threshold=3)
    merged = [x for x in out if x.get("merged_count")]
    assert len(merged) == 1
    assert merged[0]["merged_count"] == 4
    assert "4건" in merged[0]["text"]

def test_minor_below_threshold_kept_as_is():
    items = [_it("문구 수정 1", "dooray"), _it("문구 수정 2", "dooray")]
    out = compress_minor(items, threshold=3)
    assert all(not x.get("merged_count") for x in out)

def test_similarity_bounds():
    assert similarity("확인서 오류 수정", "확인서 오류 수정") == 1.0
    assert similarity("확인서 오류 수정", "완전히 다른 내용") < 0.5
EOF
```

- [ ] **Step 2: 실패 확인**

Run: `cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_dedupe.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'dedupe'`

- [ ] **Step 3: dedupe.py 구현**

```python
cat > /opt/openclaw/work-report-deploy/scripts/dedupe.py <<'EOF'
#!/usr/bin/env python3
"""중복 병합 + 노이즈 압축.

한 작업이 두레이·Gmail·드라이브에 동시에 남는다. 병합하지 않으면 한 일이
3줄로 나와서, 읽는 사람은 업무가 3배로 늘어난 줄 안다.
"""
from datetime import datetime, timedelta
from difflib import SequenceMatcher
import re

SIM_THRESHOLD = 0.6          # 제목 유사도
TIME_WINDOW_DAYS = 3         # 시각 근접도
MINOR_PATTERNS = [r"문구", r"오탈자", r"오타", r"텍스트 수정", r"이미지 교체", r"링크 수정"]


def _norm(s):
    return re.sub(r"[\s\-_·,.()\[\]]+", "", (s or "")).lower()


def similarity(a, b):
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _parse(at):
    try:
        return datetime.fromisoformat((at or "").replace("Z", "+00:00"))
    except Exception:
        return None


def _close_in_time(a, b):
    da, db = _parse(a.get("at")), _parse(b.get("at"))
    if not da or not db:
        return True                       # 시각을 모르면 시간 조건은 통과시킨다
    return abs(da - db) <= timedelta(days=TIME_WINDOW_DAYS)


def merge_duplicates(items):
    """제목이 비슷하고 시각이 가까우면 한 항목으로 묶고 출처를 모은다."""
    out = []
    for it in items:
        target = None
        for cand in out:
            if similarity(it["text"], cand["text"]) >= SIM_THRESHOLD and _close_in_time(it, cand):
                target = cand
                break
        if target:
            target["sources"].append({"source": it["source"], "url": it.get("url")})
            # 진행중이 하나라도 있으면 진행중으로 (완료로 단정하지 않는다)
            if it.get("status") == "wip":
                target["status"] = "wip"
        else:
            new = dict(it)
            new["sources"] = [{"source": it["source"], "url": it.get("url")}]
            out.append(new)
    return out


def _is_minor(text):
    return any(re.search(p, text or "") for p in MINOR_PATTERNS)


def compress_minor(items, threshold=3):
    """사소한 항목이 threshold 건 이상이면 한 줄로 묶는다."""
    minor = [x for x in items if _is_minor(x.get("text"))]
    if len(minor) < threshold:
        return items
    rest = [x for x in items if not _is_minor(x.get("text"))]
    srcs = []
    for m in minor:
        srcs += m.get("sources") or [{"source": m.get("source"), "url": m.get("url")}]
    rest.append({
        "text": f"문구·오탈자 수정 등 {len(minor)}건",
        "source": minor[0].get("source"),
        "url": None,
        "biz_id": minor[0].get("biz_id"),
        "at": minor[0].get("at"),
        "status": "done",
        "sources": srcs,
        "merged_count": len(minor),
    })
    return rest
EOF
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_dedupe.py -v`
Expected: `6 passed`

- [ ] **Step 5: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat(work-report): 중복 병합 + 노이즈 압축"
```

---

## Task 5: 초안 조립 + 실행 이력

**Files:**
- Create: `/opt/openclaw/work-report-deploy/scripts/build_draft.py`
- Create: `/opt/openclaw/work-report-deploy/scripts/run_log.py`

**Interfaces:**
- Consumes: Task 3 `collect()`, Task 4 `merge_duplicates()`·`compress_minor()`
- Produces:
  - `draft.json` = `{period, generated_at, businesses:[{id,name,items:[...]}], common:[...], stats:{}, warnings:[...]}`
  - `run_log.record(nn, ok, stats, error) -> None` / `run_log.recent(nn, n=10) -> list`

- [ ] **Step 1: 실패 테스트 작성**

```bash
cat > /opt/openclaw/work-report-deploy/tests/test_build_draft.py <<'EOF'
import sys, json, os, tempfile
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from build_draft import group_by_business, find_unsourced

def _it(text, biz_id, sources=None):
    return {"text": text, "biz_id": biz_id, "status": "done",
            "sources": sources if sources is not None else [{"source": "dooray", "url": "u"}]}

def test_group_by_business_keeps_empty_businesses():
    """활동 없는 사업도 남긴다 — 빼면 빠뜨린 건지 없는 건지 구분이 안 된다"""
    businesses = [{"id": "b1", "name": "사업1"}, {"id": "b2", "name": "사업2"}]
    items = [_it("작업A", "b1")]
    out = group_by_business(items, businesses)
    assert len(out) == 2
    assert out[1]["id"] == "b2" and out[1]["items"] == []

def test_items_without_biz_go_to_common():
    from build_draft import split_common
    businesses = [{"id": "b1", "name": "사업1"}]
    items = [_it("작업A", "b1"), _it("전사 회의", None)]
    grouped, common = split_common(items, businesses)
    assert len(grouped) == 1 and grouped[0]["text"] == "작업A"
    assert len(common) == 1 and common[0]["text"] == "전사 회의"

def test_find_unsourced_flags_items_with_no_source():
    items = [_it("정상", "b1"), _it("근거없음", "b1", sources=[])]
    warns = find_unsourced(items)
    assert len(warns) == 1 and warns[0]["text"] == "근거없음"
EOF
```

- [ ] **Step 2: 실패 확인**

Run: `cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_build_draft.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'build_draft'`

- [ ] **Step 3: run_log.py 구현**

```python
cat > /opt/openclaw/work-report-deploy/scripts/run_log.py <<'EOF'
#!/usr/bin/env python3
"""실행 이력. cron 이 조용히 실패하면 금요일 아침까지 아무도 모른다."""
import json
import os
from datetime import datetime

MAX_KEEP = 30


def _path(nn):
    return f"/opt/openclaw/data/user{nn}/work-report/runs.json"


def record(nn, ok, stats=None, error=None):
    p = _path(nn)
    try:
        runs = json.load(open(p)).get("runs", [])
    except Exception:
        runs = []
    runs.insert(0, {
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "ok": bool(ok),
        "stats": stats or {},
        "error": error,
    })
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump({"runs": runs[:MAX_KEEP]}, open(p, "w"), ensure_ascii=False, indent=2)


def recent(nn, n=10):
    try:
        return json.load(open(_path(nn))).get("runs", [])[:n]
    except Exception:
        return []
EOF
```

- [ ] **Step 4: build_draft.py 구현**

```python
cat > /opt/openclaw/work-report-deploy/scripts/build_draft.py <<'EOF'
#!/usr/bin/env python3
"""초안 조립 → draft.json 저장.

세션이 아니라 파일에 저장한다. OpenClaw 는 모델 응답이 성공해야 세션에 기록하므로,
API 장애 때 대화가 통째로 사라진다 (2026-08-03~04 실제 발생).
"""
import json
import sys
from datetime import datetime

sys.path.insert(0, "/opt/openclaw/work-report-deploy/scripts")
from collect import collect          # noqa: E402
from dedupe import merge_duplicates, compress_minor   # noqa: E402
import run_log                        # noqa: E402


def split_common(items, businesses):
    """담당 사업에 속한 것과 공통(사업 무관)을 분리."""
    ids = {b["id"] for b in businesses}
    grouped = [x for x in items if x.get("biz_id") in ids]
    common = [x for x in items if x.get("biz_id") not in ids]
    return grouped, common


def group_by_business(items, businesses):
    """활동 없는 사업도 빈 배열로 남긴다."""
    out = []
    for b in businesses:
        out.append({
            "id": b["id"],
            "name": b["name"],
            "items": [x for x in items if x.get("biz_id") == b["id"]],
        })
    return out


def find_unsourced(items):
    """출처가 하나도 없는 항목 — 지어냈을 가능성이 있어 경고로 띄운다."""
    return [x for x in items if not x.get("sources")]


def build(nn, date_from, date_to):
    cfg = json.load(open(f"/opt/openclaw/data/user{nn}/work-report/config.json"))
    master = json.load(open("/opt/openclaw/data/businesses.json"))
    businesses = [b for b in master["businesses"] if nn in (b.get("members") or [])]

    items, stats = collect(cfg.get("tools", []), businesses, date_from, date_to,
                           member_id=cfg.get("dooray_member_id"),
                           github=cfg.get("github"),
                           figma_name=(cfg.get("profile") or {}).get("name"))
    items = merge_duplicates(items)
    items = compress_minor(items)

    grouped_items, common = split_common(items, businesses)
    draft = {
        "period": f"{date_from}~{date_to}",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "businesses": group_by_business(grouped_items, businesses),
        "common": common,
        "stats": stats,
        "warnings": find_unsourced(items),
    }
    out = f"/opt/openclaw/data/user{nn}/work-report/draft.json"
    json.dump(draft, open(out, "w"), ensure_ascii=False, indent=2)
    run_log.record(nn, ok=True, stats=stats)
    return out, draft


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("사용법: build_draft.py <userNN> <from:YYYY-MM-DD> <to:YYYY-MM-DD>")
        sys.exit(2)
    nn, f, t = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        path, d = build(nn, f, t)
        total = sum(len(g["items"]) for g in d["businesses"]) + len(d["common"])
        print(json.dumps({"ok": True, "path": path, "total": total,
                          "stats": d["stats"], "warnings": len(d["warnings"])},
                         ensure_ascii=False))
    except Exception as e:
        run_log.record(nn, ok=False, error=str(e))
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
EOF
chmod +x /opt/openclaw/work-report-deploy/scripts/build_draft.py
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_build_draft.py -v`
Expected: `3 passed`

- [ ] **Step 6: user02 실제 실행**

Run:
```bash
python3 /opt/openclaw/work-report-deploy/scripts/build_draft.py 02 2026-08-03 2026-08-07
cat /opt/openclaw/data/user02/work-report/runs.json | head -20
```
Expected: `{"ok": true, "path": "...", "total": N, "stats": {...}, "warnings": 0}` · `runs.json`에 성공 기록 1건

- [ ] **Step 7: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat(work-report): 초안 조립 + 실행 이력"
```

---

## Task 6: 초안 카드 UI

**Files:**
- Create: `custom-ui/src/components/WorkReportCards.tsx`
- Modify: `custom-ui/src/components/MessageList.tsx` (fence 라우팅 1줄)
- Modify: `custom-ui/src/utils/messageFilter.ts` (`CARD_FENCE_MARKERS`에 추가)

**Interfaces:**
- Consumes: Task 5의 `draft.json` 스키마
- Produces: ` ```work-draft ` fence를 받아 카드로 렌더링. 버튼은 `onSelect(text)` 로 비서에 메시지 전송

- [ ] **Step 1: 카드 컴포넌트 작성**

```tsx
cat > /root/openclaw-custom-platform/custom-ui/src/components/WorkReportCards.tsx <<'EOF'
import { memo } from 'react';
import { FileText, AlertTriangle, RotateCcw, CheckCircle2 } from 'lucide-react';

interface Src { source: string; url?: string | null }
interface Item { text: string; status?: string; sources?: Src[]; merged_count?: number }
interface BizGroup { id: string; name: string; items: Item[] }
export interface WorkDraft {
  period: string;
  businesses: BizGroup[];
  common: Item[];
  warnings?: Item[];
}

const MARK: Record<string, { s: string; c: string }> = {
  done: { s: '✓', c: 'text-emerald-600' },
  wip:  { s: '◐', c: 'text-amber-500' },
  next: { s: '○', c: 'text-gray-400' },
};

function Row({ it }: { it: Item }) {
  const m = MARK[it.status || 'done'] || MARK.done;
  const unsourced = !it.sources || it.sources.length === 0;
  return (
    <div className={`flex items-baseline gap-2 px-3 py-1.5 text-xs border-t border-black/[0.03]
      ${unsourced ? 'bg-amber-500/[0.07]' : ''}`}>
      <span className={`w-4 text-center font-bold ${unsourced ? 'text-amber-500' : m.c}`}>
        {unsourced ? '⚠' : m.s}
      </span>
      <span className="flex-1 leading-snug">
        {it.text}
        {it.merged_count ? <span className="ml-1 text-[9px] text-text-secondary">묶음</span> : null}
        {unsourced ? <span className="ml-1.5 text-[9px] font-bold text-amber-700">출처 없음 — 확인 필요</span> : null}
      </span>
      <span className="text-[9.5px] whitespace-nowrap">
        {(it.sources || []).map((s, i) => (
          s.url
            ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
                 className="text-accent hover:underline ml-1">{s.source} ↗</a>
            : <span key={i} className="text-text-secondary ml-1">{s.source}</span>
        ))}
        {unsourced ? <span className="text-text-secondary">—</span> : null}
      </span>
    </div>
  );
}

export const WorkDraftCard = memo(function WorkDraftCard({
  raw, onSelect,
}: { raw: string; onSelect?: (t: string) => void }) {
  let d: WorkDraft | null = null;
  try { d = JSON.parse(raw); } catch { /* partial stream */ }
  if (!d || !Array.isArray(d.businesses)) {
    return <div className="my-2 p-3 rounded-lg border border-border-color text-xs text-text-secondary italic">
      업무보고 초안 로딩 중...
    </div>;
  }
  const warnCount = (d.warnings || []).length;
  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white p-4 max-w-2xl">
      <div className="flex items-center gap-1.5 text-sm font-bold text-accent mb-1">
        <FileText className="w-4 h-4" /> 업무보고 초안 · {d.period}
      </div>
      <div className="flex gap-3 text-[10px] text-text-secondary mb-3">
        <span><b className="text-emerald-600">✓</b> 완료</span>
        <span><b className="text-amber-500">◐</b> 진행중</span>
        <span><b className="text-gray-400">○</b> 차주 예정</span>
        {warnCount > 0 && <span className="text-amber-700 font-bold">⚠ 출처 없음 {warnCount}건</span>}
      </div>

      {d.businesses.map(b => (
        <div key={b.id} className="rounded-xl border border-border-color mb-2 overflow-hidden">
          <div className="px-3 py-2 flex justify-between items-center border-b border-border-color/60">
            <span className="text-xs font-bold">{b.name}</span>
            <span className="text-[9.5px] text-text-secondary">
              {b.items.length === 0 ? '이번 주 활동 없음' : `${b.items.length}건`}
            </span>
          </div>
          {b.items.map((it, i) => <Row key={i} it={it} />)}
        </div>
      ))}

      {d.common.length > 0 && (
        <div className="rounded-xl border border-border-color mb-2 overflow-hidden">
          <div className="px-3 py-2 border-b border-border-color/60">
            <span className="text-xs font-bold text-purple-600">공통 · 기타</span>
          </div>
          {d.common.map((it, i) => <Row key={i} it={it} />)}
        </div>
      )}

      <div className="flex justify-between items-center mt-3">
        <button onClick={() => onSelect?.('업무보고 초안 처음 상태로 되돌려줘')}
          className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-secondary flex items-center gap-1">
          <RotateCcw className="w-3 h-3" /> 초기화
        </button>
        <div className="flex gap-1.5">
          <button onClick={() => onSelect?.('업무보고 메일 본문 형태로 보여줘')}
            className="px-3 py-1.5 text-xs border border-border-color rounded-lg">📄 메일 형태로 보기</button>
          <button onClick={() => onSelect?.('업무보고 초안 확정. 메일 발송 준비해줘')}
            className="px-4 py-1.5 text-xs bg-accent text-white font-semibold rounded-lg flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" /> 확정
          </button>
        </div>
      </div>

      {warnCount > 0 && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>출처가 없는 항목이 있습니다. 실제로 한 일이 맞는지 확인하세요.</span>
        </div>
      )}
    </div>
  );
});
EOF
```

- [ ] **Step 2: MessageList에 fence 라우팅 추가**

`custom-ui/src/components/MessageList.tsx`에서 `language-draft-card` 분기 **바로 아래**에 추가한다.

```tsx
if (cls.includes('language-work-draft')) return <WorkDraftCard raw={raw} onSelect={onSendMessage} />;
```

같은 파일 상단 import에 추가:

```tsx
import { WorkDraftCard } from './WorkReportCards';
```

- [ ] **Step 3: 카드 fence를 raw 덤프 필터에서 제외**

`custom-ui/src/utils/messageFilter.ts`의 `CARD_FENCE_MARKERS` 배열에 추가한다.

```ts
  '```work-draft',
```

- [ ] **Step 4: 타입 검사 + 빌드**

Run:
```bash
cd /root/openclaw-custom-platform/custom-ui
npx tsc --noEmit 2>&1 | grep -E "WorkReportCards|MessageList|messageFilter" ; echo "--- 위 파일 에러 없으면 통과 ---"
npm run build 2>&1 | tail -3
```
Expected: 대상 파일 에러 0건 · `✓ built`

- [ ] **Step 5: 배포**

Run:
```bash
rsync -a --delete /root/openclaw-custom-platform/custom-ui/dist/ /opt/openclaw/custom-ui/
docker exec openclaw-nginx nginx -s reload
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/
```
Expected: `200`

- [ ] **Step 6: 빠른 실행 칩 추가**

비서 화면에서 바로 실행할 수 있어야 한다. 자연어 해석에 기대지 않는 확실한 경로다.

`custom-ui/src/components/QuickActions.tsx`의 `DEFAULT_CHIPS` 배열 맨 앞에 추가한다.

```tsx
  { label: '이번 주 업무보고', icon: FileText, prompt: '이번 주 업무보고 초안 만들어줘.', send: true, tone: 'accent', hint: '월~금 집계 → 초안' },
```

같은 파일 상단 lucide import에 `FileText`가 없으면 추가한다.

```tsx
import { Sparkles, Calendar, Mail, ListTodo, FileText, CalendarDays, History, Plus, AtSign } from 'lucide-react';
```

- [ ] **Step 7: 툴 조정 카드 추가**

기본은 뜨지 않는다. 사용자가 "조회할 곳 바꿔줘"라고 할 때만 비서가 띄운다.

`custom-ui/src/components/WorkReportCards.tsx` 맨 끝에 추가한다.

```tsx
export interface ToolPickData {
  tools: Array<{ id: string; name: string; desc: string; on: boolean; connected: boolean }>;
}

export const ToolPickCard = memo(function ToolPickCard({
  raw, onSelect,
}: { raw: string; onSelect?: (t: string) => void }) {
  let d: ToolPickData | null = null;
  try { d = JSON.parse(raw); } catch { /* partial */ }
  if (!d || !Array.isArray(d.tools)) return null;
  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white p-4 max-w-md">
      <div className="text-sm font-bold text-accent mb-1">🔧 조회할 곳</div>
      <div className="text-[10.5px] text-text-secondary mb-2">이번 회차에만 적용됩니다</div>
      {d.tools.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2 border rounded-lg px-3 py-2 mb-1.5 text-xs
            ${!t.connected ? 'opacity-50' : t.on ? 'border-accent/40 bg-accent/[0.05]' : 'border-border-color'}`}>
          <span className={`w-3.5 h-3.5 rounded border text-[9px] text-center leading-3
            ${t.on ? 'bg-accent text-white border-accent' : 'border-gray-300'}`}>{t.on ? '✓' : ''}</span>
          <span className="flex-1 font-semibold">{t.name}
            <span className="ml-1 font-normal text-text-secondary">{t.desc}</span></span>
          {!t.connected && <span className="text-[9px] text-amber-700 font-bold">연동 필요</span>}
        </div>
      ))}
      <button onClick={() => onSelect?.('이 구성으로 업무보고 다시 집계해줘')}
        className="w-full mt-1 px-4 py-1.5 text-xs bg-accent text-white font-semibold rounded-lg">
        이대로 집계
      </button>
    </div>
  );
});
```

`MessageList.tsx`에 fence 라우팅을 추가한다.

```tsx
if (cls.includes('language-tool-pick')) return <ToolPickCard raw={raw} onSelect={onSendMessage} />;
```

import와 `messageFilter.ts`의 `CARD_FENCE_MARKERS`에도 추가한다.

```tsx
import { WorkDraftCard, ToolPickCard } from './WorkReportCards';
```
```ts
  '```tool-pick',
```

- [ ] **Step 8: 타입 검사 + 빌드 + 배포**

Run:
```bash
cd /root/openclaw-custom-platform/custom-ui
npx tsc --noEmit 2>&1 | grep -E "WorkReportCards|MessageList|messageFilter|QuickActions"; echo "--- 에러 없으면 통과 ---"
npm run build 2>&1 | tail -3
rsync -a --delete dist/ /opt/openclaw/custom-ui/
docker exec openclaw-nginx nginx -s reload
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/
```
Expected: 대상 파일 에러 0건 · `✓ built` · `200`

- [ ] **Step 9: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat(work-report): 초안 카드 + 툴 선택 카드 + 빠른 실행 칩"
```

---

## Task 7: 비서 위임 규칙 + 카드 재발행

**Files:**
- Modify: `/opt/openclaw/scripts/sync-agents.sh` (`keyword_map` 확장)
- Modify: `/opt/openclaw/data/user02/BOOTSTRAP.md` (주간보고 양식 이관 + 재발행 규칙)

**Interfaces:**
- Consumes: Task 5 `draft.json` 경로, Task 6 ` ```work-draft ` fence
- Produces: 비서가 `work-report` 를 호출하고 결과 파일을 카드로 재발행

- [ ] **Step 1: keyword_map에 발화 기준 키워드 추가**

`/opt/openclaw/scripts/sync-agents.sh`의 `keyword_map` 딕셔너리에 두 줄을 추가한다.

```python
    'business-report': '사업 주간보고, 사업보고, 사업 보고서, SR, HWPX, 한글 보고서',
    'work-report': '업무보고, 내 업무, 이번 주 한 일, 주간 업무, 메일 주간보고',
```

- [ ] **Step 2: BOOTSTRAP.md에서 주간보고 양식 제거하고 위임 규칙으로 교체**

`/opt/openclaw/data/user02/BOOTSTRAP.md` 103~127행(`### 주간보고 양식` 섹션 전체)을 아래로 **치환**한다.

```markdown
### 업무보고 (개인 주간보고) — 반드시 위임

"업무보고", "이번 주 한 일", "주간 업무" 요청이 오면 **직접 작성하지 마.**
`sessions_spawn({ agentId: "work-report", task: "<기간> 업무보고 초안 생성" })` 로 위임해.

**서브에이전트가 draft.json 경로를 반환하면:**
1. `exec({"command": "cat <경로>"})` 로 읽어
2. 그 JSON 을 그대로 ```work-draft 코드블록으로 감싸서 뱉어 (카드로 렌더링됨)
3. 카드 위에 리드 한 줄만: "초안 나왔어요 👇"

**사용자가 수정을 요청하면** draft.json 을 갱신하고 다시 ```work-draft 로 뱉어.

**"조회할 곳 바꿔줘" 류의 요청이 오면** config.json 의 tools 와 연동 상태를 읽어
```tool-pick 코드블록으로 뱉어. 형식: `{"tools":[{"id","name","desc","on","connected"}]}`
- 기본 상태에서는 이 카드를 띄우지 마. **묻지 말고 바로 초안까지 가라.**

**"확정" 이라고 하면** 아래 메일 양식으로 조립해서 발송 확인을 받아.

**제목:** `[주간보고][YYYY-MM-DD~YYYY-MM-DD]팀이름 이름 직책`
- `(AI)` 같은 표기를 붙이지 마. 회사 표준 제목 그대로다.

**본문:**
```
기간(YYYY-MM-DD~YYYY-MM-DD) 팀이름 / 이름 / 직책

■ 완료
- [사업명] 항목
  ↳ 증적: URL

■ 진행 · 차주 계획
- [사업명] 항목

■ 업무 - AI 툴 활용
- 항목
```
- 사업 무관 항목은 `[사업명]` 접두어 없이 넣어
- 표(table) 형태로 만들지 마. 위 텍스트 양식 그대로다
- 본문은 여기서 끝. 인사말·마무리 문구 금지
```

- [ ] **Step 3: sync 실행 후 AGENTS.md 확인**

Run:
```bash
/opt/openclaw/scripts/sync-agents.sh 02 2>&1 | tail -3
sed -n '/## 위임 규칙/,$p' /opt/openclaw/shared/user02/AGENTS.md
```
Expected: 위임 규칙표에 `업무보고, 내 업무, 이번 주 한 일…` 과 `사업 주간보고, 사업보고, SR…` 이 키워드로 표시됨

- [ ] **Step 4: 주간보고 양식이 BOOTSTRAP에서 사라졌는지 확인**

Run: `grep -c "제목을 반드시 포함해" /opt/openclaw/data/user02/BOOTSTRAP.md`
Expected: `0`

- [ ] **Step 5: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat(work-report): 비서 위임 규칙 + 카드 재발행"
```

---

## Task 8: 메일 발송 연결

**Files:**
- Modify: `/opt/openclaw/data/user02/work-report/config.json` (수신자 기본값)
- Modify: `/opt/openclaw/data/user02/BOOTSTRAP.md` (발송 확인 절차)

**Interfaces:**
- Consumes: Task 7의 메일 양식, Task 2의 `config.recipients`
- Produces: 비서가 발송 전 확인 카드를 띄우고 승인 후 1회만 발송

- [ ] **Step 1: 수신자 기본값 설정**

```bash
python3 - <<'EOF'
import json
p = "/opt/openclaw/data/user02/work-report/config.json"
c = json.load(open(p))
c["recipients"] = {"to": ["blueyooe@tideflo.com"], "cc": []}
c["profile"] = {"team": "기술구현그룹", "name": "손재민", "title": "매니저"}
json.dump(c, open(p, "w"), ensure_ascii=False, indent=2)
print(json.dumps(c, ensure_ascii=False, indent=2))
EOF
```

- [ ] **Step 2: BOOTSTRAP에 발송 절차 추가**

Task 7에서 만든 `### 업무보고` 섹션 맨 끝에 이어 붙인다.

```markdown
**발송 절차 (절대 위반 금지):**
1. 수신자는 `work-report/config.json` 의 `recipients` 를 기본값으로 써
2. 제목·수신자·참조를 사용자에게 보여주고 **명시적 승인을 받아**
3. 승인 후에만 `exec({"command": "gcurl POST /api/mail/send-confirm '{...}'"})` 로 발송
4. **한 주에 한 번만 발송해.** 이미 보냈으면 다시 보내기 전에 반드시 물어봐
```

- [ ] **Step 3: 중복 발송 방지 확인**

Run:
```bash
docker exec openclaw-user02 sh -c 'gog mail search "in:sent 주간보고 newer_than:7d" --max 5' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('이번 주 발송 건수:', len(d.get('messages',[])))
for m in d.get('messages',[]): print(' ', m['date'], m['subject'][:50])
"
```
Expected: 0건 또는 1건. 2건 이상이면 중복 발송 이력이 있는 것이므로 기록해 둔다.

- [ ] **Step 4: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat(work-report): 메일 발송 연결 + 중복 방지"
```

---

## Task 9: cron 등록

**Files:**
- Modify: `/opt/openclaw/data/user02/cron/jobs.json`

**Interfaces:**
- Consumes: Task 7의 위임 규칙 (cron이 비서를 부르면 비서가 work-report에 위임)
- Produces: 목요일 17시 초안 자동 생성 (발송은 하지 않음)

- [ ] **Step 1: cron 등록**

```bash
python3 - <<'EOF'
import json, uuid, os
p = "/opt/openclaw/data/user02/cron/jobs.json"
d = json.load(open(p)) if os.path.exists(p) else {"version": 1, "jobs": []}
d["jobs"] = [j for j in d["jobs"] if j.get("name") != "업무보고 초안 (목 17시)"]
d["jobs"].append({
    "id": str(uuid.uuid4()),
    "agentId": "secretary",
    "name": "업무보고 초안 (목 17시)",
    "description": "이번 주 업무보고 초안 생성. 발송은 하지 않음.",
    "enabled": True,
    "schedule": {"kind": "cron", "expr": "0 17 * * 4", "tz": "Asia/Seoul"},
    "sessionTarget": "main",
    "wakeMode": "now",
    "payload": {
        "kind": "systemEvent",
        "text": "[cron: 업무보고 초안] 이번 주(월~금) 업무보고 초안을 생성하라. 발송하지 마라. 초안 카드만 보여주고 사용자 확인을 기다려라."
    },
})
json.dump(d, open(p, "w"), ensure_ascii=False, indent=2)
print("등록:", [j["name"] for j in d["jobs"]])
EOF
```

**지시문이 한 줄인 점이 핵심이다.** 기존 user13 cron은 1,400자에 `gog calendar list 3`·`gog mail search` 같은 도구 호출과 사용자 이름·이메일까지 하드코딩돼 있었다. 툴은 `config.json`에서 읽으므로 cron을 고칠 일이 없다.

- [ ] **Step 2: 타임존 확인**

Run: `python3 -c "
import json
d=json.load(open('/opt/openclaw/data/user02/cron/jobs.json'))
for j in d['jobs']: print(j['name'], '|', j['schedule'])
"`
Expected: 모든 job의 `tz`가 `Asia/Seoul`

- [ ] **Step 3: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat(work-report): cron 등록 (목 17시 · Asia/Seoul)"
```

---

## Task 10: 사업 주간보고 비서 경유 전환

**Files:**
- Modify: `/opt/openclaw/business-report-deploy/SOUL.template.md`
- Modify: `/opt/openclaw/data/user02/BOOTSTRAP.md`

**Interfaces:**
- Consumes: Task 7의 카드 재발행 패턴
- Produces: 사용자가 비서 화면에서 사업 주간보고까지 진행

- [ ] **Step 1: business-report SOUL에 호출 경로 안내 추가**

`/opt/openclaw/business-report-deploy/SOUL.template.md` 맨 앞 `# 핵심 규칙` 블록 바로 아래에 삽입한다.

```markdown
## 서브에이전트로 호출된 경우 (비서 경유)

`[Subagent Context]` 가 붙어 들어오면 **사용자가 아니라 비서가 부른 것**이다.
- 카드를 뱉어도 사용자 화면에는 안 보인다. **결과 JSON 과 파일 경로만 반환**해라.
- 반환 형식: `{"kind":"biz-picker"|"sr-table"|"draft-card"|"download-card", "data":{...}}`
- 비서가 이 JSON 을 카드로 재발행한다.

`[Subagent Context]` 가 없으면 기존대로 카드를 직접 뱉는다 (에이전트 화면 직접 진입).
```

- [ ] **Step 2: BOOTSTRAP에 사업 주간보고 위임 규칙 추가**

Task 7의 `### 업무보고` 섹션 **뒤에** 추가한다.

```markdown
### 사업 주간보고 — 반드시 위임

"사업 주간보고", "사업보고", "SR", "한글 보고서" 요청이 오면
`sessions_spawn({ agentId: "business-report", task: "<요청 내용>" })` 로 위임해.

**서브에이전트가 `{"kind":"...","data":{...}}` 를 반환하면:**
- `kind` 값을 그대로 코드블록 언어로 써서 재발행해
  (예: `kind: "draft-card"` → ```draft-card 코드블록에 `data` 를 넣어 뱉기)
- 카드 위에 리드 한 줄만

**개인 업무보고와 헷갈리지 마:**
| 사용자 발화 | 호출할 팀원 |
|---|---|
| 업무보고 · 내 업무 · 이번 주 한 일 | `work-report` |
| 사업 주간보고 · 사업보고 · SR · 한글 보고서 | `business-report` |
| 그냥 "주간보고" (구분 안 됨) | **되물어봐** — "개인 업무보고인가요, 사업 주간보고인가요?" |
```

- [ ] **Step 3: 전체 사용자 SOUL 재배포 대신 user02만 갱신**

Run:
```bash
cp /opt/openclaw/business-report-deploy/SOUL.template.md \
   /opt/openclaw/data/user02/workspace-business-report/SOUL.md
chmod 666 /opt/openclaw/data/user02/workspace-business-report/SOUL.md
chown tideclaw:tideclaw /opt/openclaw/data/user02/workspace-business-report/SOUL.md
grep -c "Subagent Context" /opt/openclaw/data/user02/workspace-business-report/SOUL.md
```
Expected: `1` 이상 · **다른 사용자 workspace는 건드리지 않는다**

- [ ] **Step 4: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat: 사업 주간보고 비서 경유 전환 (user02)"
```

---

## Task 11: 옛 에이전트 정리 + 통합 테스트

**Files:**
- Modify: `/opt/openclaw/data/user02/openclaw.json` (`reporter` 제거)

**Interfaces:**
- Consumes: Task 1~10 전부
- Produces: user02에서 이름 충돌 없이 두 보고가 각각 동작

- [ ] **Step 0: 다른 컨테이너 무영향 검증**

Task 1 Step 0에서 뜬 기준선과 대조한다. **user02 외에 바뀐 파일이 있으면 즉시 중단하고 원인을 찾는다.**

```bash
for nn in $(seq -w 1 16); do
  f=/opt/openclaw/data/user$nn/openclaw.json
  [ -f "$f" ] && md5sum "$f"
done > /tmp/wr-after-openclaw.md5
for nn in $(seq -w 1 16); do
  f=/opt/openclaw/shared/user$nn/AGENTS.md
  [ -f "$f" ] && md5sum "$f"
done > /tmp/wr-after-agents.md5

echo "--- openclaw.json 변경된 사용자 ---"
diff /tmp/wr-baseline/openclaw.md5 /tmp/wr-after-openclaw.md5 | grep -oP 'user\d{2}' | sort -u
echo "--- AGENTS.md 변경된 사용자 ---"
diff /tmp/wr-baseline/agents.md5 /tmp/wr-after-agents.md5 | grep -oP 'user\d{2}' | sort -u
```
Expected: **두 목록 모두 `user02`만** 출력. 다른 사용자가 나오면 격리 규칙이 깨진 것이다.

- [ ] **Step 1: `reporter` 제거**

user02의 `reporter`는 표시명이 "주간보고 작성 📊"이라 `business-report`("사업 주간보고 🏢")와 정면 충돌한다. 새 `업무보고`까지 더해지면 셋이 경쟁한다.

```bash
cp /opt/openclaw/data/user02/openclaw.json /opt/openclaw/data/user02/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)
python3 - <<'EOF'
import json
p = "/opt/openclaw/data/user02/openclaw.json"
cfg = json.load(open(p))
cfg['agents']['list'] = [a for a in cfg['agents']['list'] if a['id'] != 'reporter']
sec = next(a for a in cfg['agents']['list'] if a['id'] == 'secretary')
allow = sec.get('subagents', {}).get('allowAgents', [])
if 'reporter' in allow: allow.remove('reporter')
json.dump(cfg, open(p, 'w'), ensure_ascii=False, indent=2)
print('에이전트:', [a['id'] for a in cfg['agents']['list']])
print('allowAgents:', allow)
EOF
```
Expected: `['secretary', 'bid-reviewer', 'business-report', 'work-report']`

- [ ] **Step 2: 컨테이너 반영**

Run:
```bash
/opt/openclaw/scripts/sync-agents.sh 02 2>&1 | tail -3
sleep 3
docker exec openclaw-user02 sh -c 'curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://localhost:18789/healthz'
```
Expected: `200`

- [ ] **Step 3: 위임 분기 테스트 — 개인**

user02 비서 화면에서 입력: `이번 주 업무보고 초안 만들어줘`

Expected:
- `work-report` 로 위임됨 (business-report 아님)
- ```work-draft 카드가 뜸
- 사업별 블록 · ✓◐○ 기호 · 출처 링크 표시

- [ ] **Step 4: 위임 분기 테스트 — 사업**

user02 비서 화면에서 입력: `사업 주간보고 만들어줘`

Expected:
- `business-report` 로 위임됨
- 비서 화면에 biz-picker 카드가 뜸 (에이전트 화면으로 이동하지 않음)

- [ ] **Step 5: 모호한 발화 테스트**

user02 비서 화면에서 입력: `주간보고 작성해줘`

Expected: 비서가 **되물음** — "개인 업무보고인가요, 사업 주간보고인가요?"

- [ ] **Step 6: 실패 이력 확인**

Run:
```bash
python3 -c "
import sys; sys.path.insert(0,'/opt/openclaw/work-report-deploy/scripts')
import run_log, json
print(json.dumps(run_log.recent('02', 5), ensure_ascii=False, indent=1))
"
```
Expected: 실행 이력이 시각·성공여부·수집건수와 함께 기록돼 있음

- [ ] **Step 7: 롤백 절차 확인 (실행하지 말 것 — 절차만 검증)**

문제가 생기면 아래로 되돌린다.

```bash
/opt/openclaw/work-report-deploy/unenroll.sh 02
cp /opt/openclaw/data/user02/openclaw.json.bak.<timestamp> /opt/openclaw/data/user02/openclaw.json
/opt/openclaw/scripts/sync-agents.sh 02
```

- [ ] **Step 8: 커밋**

```bash
cd /root/openclaw-custom-platform && git add -A && git commit -m "feat: user02 업무보고 통합 · reporter 제거"
```

---

## 전체 배포 (테스트 완료 후)

user02 테스트가 끝난 뒤에만 진행한다.

```bash
# 1. 나머지 사용자 활성화
for nn in 03 05 06 07 12 13 14 16; do /opt/openclaw/work-report-deploy/enroll.sh $nn; done

# 2. 옛 에이전트 제거 (user03 reporter · user07 weekly-report-agent · user15 weekly-report · user04 eekly)
#    — 각 사용자 openclaw.json 백업 후 Task 11 Step 1 과 동일한 방식으로 제거

# 3. business-report SOUL 전체 재배포
for nn in 02 03 05 06 07 12 13 14 16; do
  cp /opt/openclaw/business-report-deploy/SOUL.template.md \
     /opt/openclaw/data/user$nn/workspace-business-report/SOUL.md
done

# 4. 전체 sync
for nn in $(seq -w 1 16); do /opt/openclaw/scripts/sync-agents.sh $nn; done
```

**주의:** `BOOTSTRAP.md`는 배포 스크립트가 없고 수동 관리다. 15개 컨테이너에 동일 파일을 복사해야 하며 **user16에는 파일 자체가 없다** — 신규 생성이 필요하다.
