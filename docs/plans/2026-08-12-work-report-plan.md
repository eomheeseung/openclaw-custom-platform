# 업무보고 체계 구현 플랜 (v2 · 통합 스펙 기준)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개인 주간보고를 `work-report` 서브에이전트로 분리하고 비서를 유일한 접점으로 세운다. Phase 2에서 두레이 메신저를 같은 비서의 두 번째 문으로 연결한다.

**Architecture:** 서브에이전트는 데이터 생성기다 — 툴을 조회해 주차별 `draft-YYYY-Www.json` 파일만 남긴다. 비서가 파일을 읽어 카드로 재발행하고, 수정을 반영하고, 발송한다. 두레이는 webhooks 확장의 `sessionKey`로 웹과 동일한 비서 세션에 연결된다.

**Tech Stack:** Python 3 (수집·초안) · Node.js (automap-api) · React/TypeScript (custom-ui) · OpenClaw 에이전트 설정 · bash

**스펙:** `docs/specs/2026-08-12-work-report-design.md` — 이 플랜과 충돌 시 스펙 우선.

## Global Constraints

- **Phase 1 대상은 user02 컨테이너 하나뿐.** 라이브 운영 서버(16명 실사용).
- `sync-agents.sh` 는 **반드시 인자와 함께** 실행 (인자 없으면 user01~14 전체 동기화).
- `openclaw.json` 쓰기는 **원자적**(백업+mkstemp+os.replace) — Task 1(완료)의 enroll.sh 패턴 준수.
- **`temperature` 금지** — Moonshot 400 · Anthropic deprecated. effort(`thinkingLevel`)만.
- **SR 은 개인 업무보고에서 영구 제외** (목록에 처리 담당자 컬럼 없음).
- 메일 제목 `[주간보고][YYYY-MM-DD~YYYY-MM-DD]팀이름 이름 직책` — **`(AI)` 표기 금지**. 본문은 기존 텍스트 양식(표 금지).
- 발송 주체는 비서만 · 주 1회 · cron 은 초안까지.
- cron tz **`Asia/Seoul` 고정**.
- 사용자 문구 전부 한국어.
- 커밋 방식: 라이브(`/opt/openclaw`)에서 작업 → `rsync` 로 저장소 복사 → 커밋.
  ```bash
  cd /root/openclaw-custom-platform
  rsync -a --exclude='__pycache__' /opt/openclaw/work-report-deploy/ work-report-deploy/
  cp /opt/openclaw/scripts/automap-api.js scripts/automap-api.js      # 수정 시
  cp /opt/openclaw/scripts/sync-agents.sh scripts/sync-agents.sh      # 수정 시
  git add -A && git commit -m "<메시지>"
  ```
- **완료 재사용 (재작업 금지):** 2026-08-10 플랜 Task 1 산출물 —
  `/opt/openclaw/work-report-deploy/`(features.json·enroll.sh·unenroll.sh·SOUL.template.md),
  user02 `work-report` 에이전트 등록, 원자적 쓰기. 커밋 `01da09c`·`10b353e`.

---

## 파일 구조

| 파일 | 책임 | 태스크 |
|---|---|---|
| `/opt/openclaw/data/businesses.json` | 사업 마스터 (공용·관리자 관리·alias 포함) | 2 |
| `/opt/openclaw/scripts/automap-api.js` | `GET businesses` · `GET/PUT config` 엔드포인트 | 2 |
| `work-report-deploy/scripts/collect.py` | 툴별 수집 (SR 차단 · 실패 추적) | 3 |
| `work-report-deploy/scripts/dedupe.py` | 중복 병합 + 노이즈 압축 | 4 |
| `work-report-deploy/scripts/week_util.py` | ISO 주차 라벨·직전 주차 계산 | 5 |
| `work-report-deploy/scripts/build_draft.py` | 초안 조립 + **이월 대조** + 주차별 저장 | 5 |
| `work-report-deploy/scripts/run_log.py` | 실행 이력 | 5 |
| `custom-ui/src/components/WorkReportCards.tsx` | `work-draft`(보고서 미리보기형) · `tool-pick` 카드 | 6 |
| `custom-ui/src/components/QuickActions.tsx` | 비서 화면 업무 칩 2개 | 6 |
| `custom-ui/src/components/MessageList.tsx` · `utils/messageFilter.ts` | fence 라우팅·필터 예외 | 6 |
| `/opt/openclaw/scripts/sync-agents.sh` | `keyword_map` 발화 키워드 확장 (기존 에이전트 포함) | 7 |
| `/opt/openclaw/data/user02/BOOTSTRAP.md` | 위임 규칙·재발행·되묻기·발송 절차 | 7·8 |
| `/opt/openclaw/data/user02/cron/jobs.json` | 목 17시 초안 cron (휴무 분기 포함) | 9 |
| `business-report-deploy/SOUL.template.md` · features.json | `[Subagent Context]` 분기 · 표시명 (기관 제출용) | 10 |
| `/opt/openclaw/data/user02/work-report/dooray.json` | Phase 2 — 두레이 연동 설정 (매핑·훅 URL) | 12~14 |

---

# Phase 1 — work-report 코어 (user02 단독)

## Task 2: 사업 마스터 + 개인 설정 API

**Files:**
- Create: `/opt/openclaw/data/businesses.json`
- Modify: `/opt/openclaw/scripts/automap-api.js` (`/api/admin/keys` 핸들러 바로 앞에 3개 엔드포인트)

**Interfaces:**
- Produces:
  - `GET /api/work-report/businesses` → `{ok, businesses:[{id,name,alias,org,dooray_project_id,figma_file_keys,members[]}]}`
  - `GET /api/work-report/config?userNN=` → `{ok, config, businesses(내 담당만)}`
  - `PUT /api/work-report/config?userNN=` → tools·recipients·schedule·profile 만 저장 (담당 사업은 관리자 전용 = 파일 직접 편집)
- Consumes: Task 1 의 `data/user02/work-report/config.json`

- [ ] **Step 1: 사업 마스터 생성** (`alias` = 보고서 `[태그]`용 약칭)

```bash
cat > /opt/openclaw/data/businesses.json <<'EOF'
{
  "version": 1,
  "businesses": [
    {
      "id": "biz-sports",
      "name": "대한체육회 e진로지원센터",
      "alias": "e진로",
      "org": "대한체육회",
      "dooray_project_id": "4332881555667186223",
      "figma_file_keys": [],
      "members": ["02", "13"]
    },
    {
      "id": "biz-smoking",
      "name": "금연서비스 통합정보시스템",
      "alias": "금연서비스",
      "org": "한국건강증진개발원",
      "dooray_project_id": "",
      "figma_file_keys": [],
      "members": ["13"]
    }
  ]
}
EOF
chown tideclaw:tideclaw /opt/openclaw/data/businesses.json && chmod 644 /opt/openclaw/data/businesses.json
```

- [ ] **Step 2: 엔드포인트 3개 추가** — `automap-api.js` 의 `// GET /api/admin/keys` 주석 바로 앞에 삽입

```javascript
  /* GET /api/work-report/businesses — 사업 마스터 (공용 · 관리자가 파일로 관리) */
  if (req.method === 'GET' && url.pathname === '/api/work-report/businesses') {
    try {
      const d = JSON.parse(fs.readFileSync('/opt/openclaw/data/businesses.json', 'utf8'));
      jsonRes(res, 200, { ok: true, businesses: d.businesses || [] });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* GET /api/work-report/config — 개인 설정 + 내 담당 사업(마스터 역참조) */
  if (req.method === 'GET' && url.pathname === '/api/work-report/config') {
    const nn = resolveUserNN(req, url);
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    try {
      const cfg = JSON.parse(fs.readFileSync(`/opt/openclaw/data/user${nn}/work-report/config.json`, 'utf8'));
      const master = JSON.parse(fs.readFileSync('/opt/openclaw/data/businesses.json', 'utf8'));
      const mine = (master.businesses || []).filter(b => (b.members || []).includes(nn));
      jsonRes(res, 200, { ok: true, config: cfg, businesses: mine });
    } catch (e) { jsonRes(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* PUT /api/work-report/config — tools·recipients·schedule·profile 만 (담당 사업은 관리자 전용) */
  if (req.method === 'PUT' && url.pathname === '/api/work-report/config') {
    const nn = resolveUserNN(req, url);
    if (!nn) { jsonRes(res, 403, { ok: false, error: 'Forbidden' }); return; }
    readBody(req).then(body => {
      const p = `/opt/openclaw/data/user${nn}/work-report/config.json`;
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(body.tools)) cur.tools = body.tools.filter(t => t !== 'sr');  /* SR 영구 차단 */
      if (body.recipients) cur.recipients = body.recipients;
      if (body.schedule) cur.schedule = body.schedule;
      if (body.profile) cur.profile = body.profile;
      fs.writeFileSync(p, JSON.stringify(cur, null, 2));
      jsonRes(res, 200, { ok: true, config: cur });
    }).catch(e => jsonRes(res, 500, { ok: false, error: e.message }));
    return;
  }
```

- [ ] **Step 3: `readBody` 헬퍼 확인** — `grep -n "function readBody" /opt/openclaw/scripts/automap-api.js`. 없으면 상단 헬퍼 영역에 추가:

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

- [ ] **Step 4: 검증**

```bash
node --check /opt/openclaw/scripts/automap-api.js && systemctl restart openclaw-automap-api && sleep 3
systemctl is-active openclaw-automap-api
curl -s http://localhost:18799/api/work-report/businesses | python3 -m json.tool | head -12
```
Expected: `active` · `"ok": true` · `biz-sports`(alias `e진로`) 포함 2건

- [ ] **Step 5: 커밋** — Global Constraints 의 rsync 커밋 절차. 메시지 `feat(work-report): 사업 마스터 + 개인 설정 API`

## Task 3: 수집 스크립트 (SR 차단 · 실패 추적)

**Files:**
- Create: `/opt/openclaw/work-report-deploy/scripts/collect.py`
- Test: `/opt/openclaw/work-report-deploy/tests/test_collect.py`

**Interfaces:**
- Produces: `collect(tools, businesses, date_from, date_to, member_id=None, github=None, figma_name=None) -> (items, stats, failures)`
  - item = `{"text","source","url","biz_id","at","status"}` (status: `done|wip`)
  - stats = `{"dooray": 12, ...}` (툴별 건수) · failures = `["gmail", ...]` (호출 실패 툴)
- Consumes: Task 2 businesses(`dooray_project_id`·`figma_file_keys`), config(`tools`·`dooray_member_id`·`github`·`profile.name`)

- [ ] **Step 1: 실패 테스트**

```bash
mkdir -p /opt/openclaw/work-report-deploy/tests
cat > /opt/openclaw/work-report-deploy/tests/test_collect.py <<'EOF'
import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from collect import normalize_item, tool_enabled

def test_normalize_item_keeps_required_keys():
    raw = {"subject": "확인서 오류 수정", "updatedAt": "2026-08-05T10:00:00+09:00"}
    it = normalize_item(raw, source="dooray", biz_id="biz-sports",
                        url="https://x/142", status="done")
    assert (it["text"], it["source"], it["biz_id"], it["status"]) == \
           ("확인서 오류 수정", "dooray", "biz-sports", "done")
    assert it["url"] == "https://x/142" and it["at"].startswith("2026-08-05")

def test_tool_enabled_respects_config():
    assert tool_enabled(["dooray", "gmail"], "dooray") is True
    assert tool_enabled(["dooray", "gmail"], "figma") is False

def test_sr_is_never_enabled():
    """SR 은 설정에 있어도 무시 — 처리 담당자 구분 불가로 영구 제외"""
    assert tool_enabled(["dooray", "sr"], "sr") is False
EOF
cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_collect.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'collect'`

- [ ] **Step 2: 구현**

```bash
cat > /opt/openclaw/work-report-deploy/scripts/collect.py <<'EOF'
#!/usr/bin/env python3
"""툴별 수집 → 정규화 항목 + 건수 + 실패 목록.

⚠ SR 영구 제외: 목록 컬럼(sr_no·title·requester·status·…)에 처리 담당자가 없어
  같은 사업 타인의 처리 건이 섞인다. SR 은 사업 주간보고(기관 제출용) 전용.
⚠ 실패를 드러낸다: 미연동/실패 시 CLI 가 에러 대신 사용법 안내문을 뱉어
  '조용한 누락'이 되므로, 호출 실패는 failures 로 반환해 카드 배지로 띄운다.
"""
import json
import subprocess

BLOCKED_TOOLS = {"sr"}
KNOWN_TOOLS = ["dooray", "gmail", "calendar", "drive", "github", "figma"]


def tool_enabled(tools, name):
    if name in BLOCKED_TOOLS:
        return False
    return name in (tools or [])


def normalize_item(raw, source, biz_id=None, url=None, status="done"):
    text = (raw.get("subject") or raw.get("title") or raw.get("name")
            or raw.get("summary") or "").strip()
    at = (raw.get("updatedAt") or raw.get("date") or raw.get("modified")
          or raw.get("start") or "")
    return {"text": text, "source": source, "url": url,
            "biz_id": biz_id, "at": at, "status": status}


def _run(cmd):
    """CLI 실행 → (ok, dict). JSON 아니거나 ok:false 면 실패."""
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True,
                             text=True, timeout=60).stdout
        d = json.loads(out)
        if isinstance(d, dict) and d.get("ok") is not False:
            return True, d
        return False, {}
    except Exception:
        return False, {}


def collect_dooray(biz, member_id):
    pid = biz.get("dooray_project_id")
    if not pid or not member_id:
        return [], True
    items, ok_all = [], True
    for status, mapped in (("done", "done"), ("working", "wip")):
        ok, d = _run(f"dooray tasks {pid} 50 {status} {member_id}")
        ok_all = ok_all and ok
        for t in d.get("tasks", []):
            url = f"https://tideflo.dooray.com/task/{pid}/{t.get('id')}"
            items.append(normalize_item(t, "dooray", biz["id"], url, mapped))
    return items, ok_all


def collect_gmail(date_from, date_to):
    ok, d = _run(f'gog mail search "after:{date_from} before:{date_to}" --max 50')
    items = []
    for m in d.get("messages", []):
        url = f"https://mail.google.com/mail/u/0/#all/{m.get('id')}"
        items.append(normalize_item(m, "gmail", None, url, "done"))
    return items, ok


def collect_calendar(days=7):
    ok, d = _run(f"gog calendar list {days}")
    items = []
    for e in d.get("events", []):
        items.append(normalize_item(e, "calendar", None, e.get("htmlLink"), "done"))
    return items, ok


def collect_drive(days=7):
    ok, d = _run(f"gog drive recent {days}")
    items = []
    for f in d.get("files", []):
        url = f"https://drive.google.com/file/d/{f.get('id')}/view"
        items.append(normalize_item(f, "drive", None, url, "done"))
    return items, ok


def collect_github(owner, repo, date_from, date_to):
    if not owner or not repo:
        return [], True
    cmd = (f'gh api "/repos/{owner}/{repo}/commits'
           f'?author=@me&since={date_from}T00:00:00Z&until={date_to}T23:59:59Z" 2>/dev/null')
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60).stdout
        rows = json.loads(out)
        if not isinstance(rows, list):
            return [], False
    except Exception:
        return [], False
    items = []
    for c in rows:
        msg = (c.get("commit") or {}).get("message", "").split("\n")[0]
        items.append(normalize_item(
            {"title": msg, "date": (c.get("commit") or {}).get("author", {}).get("date")},
            "github", None, c.get("html_url"), "done"))
    return items, True


def collect_figma(file_keys, member_name):
    """등록 파일의 버전 이력에서 본인 것만 (Figma 는 팀 활동 피드가 없다)."""
    items, ok_all = [], True
    for key in file_keys or []:
        ok, d = _run(f"figma versions {key}")
        ok_all = ok_all and ok
        for v in d.get("versions", []):
            who = ((v.get("user") or {}).get("handle") or "")
            if member_name and member_name not in who:
                continue
            items.append(normalize_item(
                {"title": v.get("label") or "디자인 작업", "date": v.get("created_at")},
                "figma", None, f"https://www.figma.com/file/{key}", "done"))
    return items, ok_all


def collect(tools, businesses, date_from, date_to, member_id=None,
            github=None, figma_name=None):
    items, stats, failures = [], {}, []

    def take(name, got, ok):
        items.extend(got)
        stats[name] = len(got)
        if not ok:
            failures.append(name)

    if tool_enabled(tools, "dooray"):
        got, ok = [], True
        for b in businesses:
            g, o = collect_dooray(b, member_id)
            got += g
            ok = ok and o
        take("dooray", got, ok)
    if tool_enabled(tools, "gmail"):
        take("gmail", *collect_gmail(date_from, date_to))
    if tool_enabled(tools, "calendar"):
        take("calendar", *collect_calendar())
    if tool_enabled(tools, "drive"):
        take("drive", *collect_drive())
    if tool_enabled(tools, "github"):
        g = github or {}
        take("github", *collect_github(g.get("owner"), g.get("repo"), date_from, date_to))
    if tool_enabled(tools, "figma"):
        keys = []
        for b in businesses:
            keys += b.get("figma_file_keys") or []
        take("figma", *collect_figma(keys, figma_name))
    return items, stats, failures
EOF
chmod +x /opt/openclaw/work-report-deploy/scripts/collect.py
```

- [ ] **Step 3: 검증** — `cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_collect.py -v`
Expected: `3 passed`

- [ ] **Step 4: 커밋** — `feat(work-report): 수집 스크립트 (SR 차단 · 실패 추적)`

## Task 4: 중복 병합 + 노이즈 압축

**Files:**
- Create: `/opt/openclaw/work-report-deploy/scripts/dedupe.py`
- Test: `/opt/openclaw/work-report-deploy/tests/test_dedupe.py`

**Interfaces:**
- Produces:
  - `similarity(a, b) -> float`
  - `merge_duplicates(items) -> list` — 병합 항목은 `sources:[{source,url}]`, wip 우선
  - `compress_minor(items, threshold=3) -> list` — 묶음은 `{"text":"문구·오탈자 수정 등 N건","merged_count":N}`
- Consumes: Task 3 item 형식

- [ ] **Step 1: 실패 테스트**

```bash
cat > /opt/openclaw/work-report-deploy/tests/test_dedupe.py <<'EOF'
import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from dedupe import merge_duplicates, compress_minor, similarity

def _it(text, source, url=None, at="2026-08-05T10:00:00+09:00", status="done"):
    return {"text": text, "source": source, "url": url, "biz_id": "b1",
            "at": at, "status": status}

def test_similar_titles_merge_into_one():
    out = merge_duplicates([
        _it("교육훈련비 확인서 오류 수정", "dooray", "u1"),
        _it("교육훈련비 확인서 오류 관련 회신", "gmail", "u2"),
    ])
    assert len(out) == 1
    assert {s["source"] for s in out[0]["sources"]} == {"dooray", "gmail"}

def test_unrelated_items_stay_separate():
    assert len(merge_duplicates([_it("확인서 오류 수정", "dooray"),
                                 _it("서버 이전 작업", "dooray")])) == 2

def test_far_apart_in_time_not_merged():
    out = merge_duplicates([
        _it("확인서 오류 수정", "dooray", at="2026-08-01T10:00:00+09:00"),
        _it("확인서 오류 수정", "gmail",  at="2026-08-07T10:00:00+09:00"),
    ])
    assert len(out) == 2

def test_wip_wins_over_done_on_merge():
    out = merge_duplicates([
        _it("통계 화면 개선", "dooray", status="wip"),
        _it("통계 화면 개선 회신", "gmail", status="done"),
    ])
    assert out[0]["status"] == "wip"

def test_minor_items_compressed():
    items = [_it(f"문구 수정 {i}", "dooray") for i in range(4)] + [_it("서버 이전", "dooray")]
    out = compress_minor(items, threshold=3)
    merged = [x for x in out if x.get("merged_count")]
    assert len(merged) == 1 and merged[0]["merged_count"] == 4 and "4건" in merged[0]["text"]

def test_minor_below_threshold_kept():
    out = compress_minor([_it("문구 수정 1", "dooray"), _it("문구 수정 2", "dooray")], threshold=3)
    assert all(not x.get("merged_count") for x in out)

def test_similarity_bounds():
    assert similarity("확인서 오류 수정", "확인서 오류 수정") == 1.0
    assert similarity("확인서 오류 수정", "완전히 다른 내용") < 0.5
EOF
cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_dedupe.py -v
```
Expected: FAIL — `No module named 'dedupe'`

- [ ] **Step 2: 구현**

```bash
cat > /opt/openclaw/work-report-deploy/scripts/dedupe.py <<'EOF'
#!/usr/bin/env python3
"""중복 병합 + 노이즈 압축.

한 작업이 두레이·Gmail·드라이브에 동시에 남는다. 병합하지 않으면 한 일이
3줄로 부풀어, 읽는 사람은 업무가 3배로 늘어난 줄 안다.
"""
from datetime import datetime, timedelta
from difflib import SequenceMatcher
import re

SIM_THRESHOLD = 0.6
TIME_WINDOW_DAYS = 3
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
        return True
    return abs(da - db) <= timedelta(days=TIME_WINDOW_DAYS)


def merge_duplicates(items):
    out = []
    for it in items:
        target = None
        for cand in out:
            if similarity(it["text"], cand["text"]) >= SIM_THRESHOLD and _close_in_time(it, cand):
                target = cand
                break
        if target:
            target["sources"].append({"source": it["source"], "url": it.get("url")})
            if it.get("status") == "wip":          # 진행중이 하나라도 있으면 완료로 단정하지 않는다
                target["status"] = "wip"
        else:
            new = dict(it)
            new["sources"] = [{"source": it["source"], "url": it.get("url")}]
            out.append(new)
    return out


def _is_minor(text):
    return any(re.search(p, text or "") for p in MINOR_PATTERNS)


def compress_minor(items, threshold=3):
    minor = [x for x in items if _is_minor(x.get("text"))]
    if len(minor) < threshold:
        return items
    rest = [x for x in items if not _is_minor(x.get("text"))]
    srcs = []
    for m in minor:
        srcs += m.get("sources") or [{"source": m.get("source"), "url": m.get("url")}]
    rest.append({
        "text": f"문구·오탈자 수정 등 {len(minor)}건",
        "source": minor[0].get("source"), "url": None,
        "biz_id": minor[0].get("biz_id"), "at": minor[0].get("at"),
        "status": "done", "sources": srcs, "merged_count": len(minor),
    })
    return rest
EOF
```

- [ ] **Step 3: 검증** — `python3 -m pytest tests/test_dedupe.py -v` → `7 passed`
- [ ] **Step 4: 커밋** — `feat(work-report): 중복 병합 + 노이즈 압축`

## Task 5: 초안 조립 — 주차별 저장 + 이월 대조 + 실행 이력

**Files:**
- Create: `week_util.py` · `build_draft.py` · `run_log.py` (모두 `work-report-deploy/scripts/`)
- Test: `tests/test_build_draft.py`

**Interfaces:**
- Produces:
  - `week_util.week_label(date_iso) -> "2026-W33"` · `week_util.prev_week_label(date_iso)`
  - `build_draft.build(nn, date_from, date_to) -> (path, draft)` —
    저장 경로 `data/userNN/work-report/drafts/draft-{week}.json`
  - draft = `{period, week, generated_at, businesses:[{id,name,alias,items[]}], common[], stats{}, failures[], warnings[]}`
    - item 에 `carry: true`(지난주 예정→계속) 가능
  - `run_log.record(nn, ok, stats=None, failures=None, error=None)` · `run_log.recent(nn, n=10)`
- Consumes: Task 3 `collect`, Task 4 `merge_duplicates`·`compress_minor`·`similarity`

- [ ] **Step 1: 실패 테스트**

```bash
cat > /opt/openclaw/work-report-deploy/tests/test_build_draft.py <<'EOF'
import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from week_util import week_label, prev_week_label
from build_draft import split_common, group_by_business, find_unsourced, apply_carryover

def _it(text, biz_id, status="done", sources=None):
    return {"text": text, "biz_id": biz_id, "status": status,
            "sources": sources if sources is not None else [{"source": "dooray", "url": "u"}]}

def test_week_label_iso():
    assert week_label("2026-08-10") == "2026-W33"
    assert prev_week_label("2026-08-10") == "2026-W32"

def test_group_keeps_empty_businesses():
    """활동 없는 사업도 남긴다 — 빠뜨림/없음 구분"""
    bs = [{"id": "b1", "name": "사업1", "alias": "일"}, {"id": "b2", "name": "사업2", "alias": "이"}]
    out = group_by_business([_it("작업A", "b1")], bs)
    assert len(out) == 2 and out[1]["items"] == [] and out[0]["alias"] == "일"

def test_split_common():
    bs = [{"id": "b1", "name": "사업1"}]
    grouped, common = split_common([_it("작업A", "b1"), _it("전사 회의", None)], bs)
    assert [x["text"] for x in grouped] == ["작업A"]
    assert [x["text"] for x in common] == ["전사 회의"]

def test_find_unsourced():
    warns = find_unsourced([_it("정상", "b1"), _it("근거없음", "b1", sources=[])])
    assert [w["text"] for w in warns] == ["근거없음"]

def test_carryover_marks_continuing_item():
    """지난주 '차주'에 있던 제목이 이번 주 진행중이면 carry 표시"""
    prev_next = [{"text": "통계 화면 개선", "status": "next"}]
    cur = [_it("통계 화면 개선", "b1", status="wip")]
    out = apply_carryover(cur, prev_next)
    assert out[0].get("carry") is True

def test_carryover_appends_untouched_item():
    """지난주 '차주'였는데 이번 주에 아예 안 잡히면 carry 로 이월 추가"""
    prev_next = [{"text": "점검 일정 협의", "status": "next", "biz_id": "b1"}]
    out = apply_carryover([_it("다른 작업", "b1")], prev_next)
    carried = [x for x in out if x.get("carry")]
    assert len(carried) == 1 and carried[0]["text"] == "점검 일정 협의"
    assert carried[0]["status"] == "next" and carried[0]["sources"] == []

def test_carryover_done_absorbs():
    """지난주 차주가 이번 주 완료로 잡혔으면 carry 없이 완료로 흡수"""
    prev_next = [{"text": "로그인 오류 조치", "status": "next"}]
    out = apply_carryover([_it("로그인 오류 조치", "b1", status="done")], prev_next)
    assert len(out) == 1 and not out[0].get("carry")
EOF
cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/test_build_draft.py -v
```
Expected: FAIL — `No module named 'week_util'`

- [ ] **Step 2: week_util.py**

```bash
cat > /opt/openclaw/work-report-deploy/scripts/week_util.py <<'EOF'
#!/usr/bin/env python3
"""ISO 주차 라벨. 초안 파일명(draft-2026-W33.json)과 직전 주차 탐색에 사용."""
from datetime import date, timedelta


def week_label(date_iso):
    y, w, _ = date.fromisoformat(date_iso).isocalendar()
    return f"{y}-W{w:02d}"


def prev_week_label(date_iso):
    d = date.fromisoformat(date_iso) - timedelta(days=7)
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"
EOF
```

- [ ] **Step 3: run_log.py**

```bash
cat > /opt/openclaw/work-report-deploy/scripts/run_log.py <<'EOF'
#!/usr/bin/env python3
"""실행 이력. cron 이 조용히 실패하면 금요일 아침까지 아무도 모른다."""
import json
import os
from datetime import datetime

MAX_KEEP = 30


def _path(nn):
    return f"/opt/openclaw/data/user{nn}/work-report/runs.json"


def record(nn, ok, stats=None, failures=None, error=None):
    p = _path(nn)
    try:
        runs = json.load(open(p)).get("runs", [])
    except Exception:
        runs = []
    runs.insert(0, {
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "ok": bool(ok), "stats": stats or {}, "failures": failures or [], "error": error,
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

- [ ] **Step 4: build_draft.py**

```bash
cat > /opt/openclaw/work-report-deploy/scripts/build_draft.py <<'EOF'
#!/usr/bin/env python3
"""초안 조립 → drafts/draft-{주차}.json 저장.

- 파일 저장인 이유: OpenClaw 는 모델 응답 성공 시에만 세션 기록 → API 장애 때
  대화가 통째로 사라진다 (2026-08-03~04 실증). 파일이면 초안이 살아남는다.
- 주차별 보관인 이유: 이월 대조(직전 주차의 '차주' → 이번 회차)에 직전 파일이 필요.
"""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, "/opt/openclaw/work-report-deploy/scripts")
from collect import collect                     # noqa: E402
from dedupe import merge_duplicates, compress_minor, similarity   # noqa: E402
from week_util import week_label, prev_week_label                 # noqa: E402
import run_log                                   # noqa: E402

CARRY_SIM = 0.6


def split_common(items, businesses):
    ids = {b["id"] for b in businesses}
    return ([x for x in items if x.get("biz_id") in ids],
            [x for x in items if x.get("biz_id") not in ids])


def group_by_business(items, businesses):
    return [{"id": b["id"], "name": b["name"], "alias": b.get("alias", b["name"]),
             "items": [x for x in items if x.get("biz_id") == b["id"]]}
            for b in businesses]


def find_unsourced(items):
    return [x for x in items if not x.get("sources")]


def apply_carryover(items, prev_next_items):
    """직전 주차 '차주' 항목과 대조.
    - 이번 주에 비슷한 제목이 wip/next 로 잡힘 → carry 표시 (「지난주 예정 → 계속」)
    - done 으로 잡힘 → 그대로 흡수 (표시 없음)
    - 아예 안 잡힘 → carry=True 인 next 항목으로 이월 추가 (안 했으면 그대로 남긴다)
    """
    out = list(items)
    for prev in prev_next_items:
        match = None
        for cur in out:
            if similarity(prev.get("text", ""), cur.get("text", "")) >= CARRY_SIM:
                match = cur
                break
        if match is None:
            out.append({"text": prev.get("text", ""), "source": "carry", "url": None,
                        "biz_id": prev.get("biz_id"), "at": "", "status": "next",
                        "sources": [], "carry": True})
        elif match.get("status") in ("wip", "next"):
            match["carry"] = True
    return out


def _load_prev_next(nn, date_from):
    p = f"/opt/openclaw/data/user{nn}/work-report/drafts/draft-{prev_week_label(date_from)}.json"
    if not os.path.exists(p):
        return []
    try:
        prev = json.load(open(p))
    except Exception:
        return []
    items = []
    for g in prev.get("businesses", []):
        for it in g.get("items", []):
            if it.get("status") == "next":
                items.append(dict(it, biz_id=g.get("id")))
    for it in prev.get("common", []):
        if it.get("status") == "next":
            items.append(it)
    return items


def build(nn, date_from, date_to):
    cfg = json.load(open(f"/opt/openclaw/data/user{nn}/work-report/config.json"))
    master = json.load(open("/opt/openclaw/data/businesses.json"))
    businesses = [b for b in master["businesses"] if nn in (b.get("members") or [])]

    items, stats, failures = collect(
        cfg.get("tools", []), businesses, date_from, date_to,
        member_id=cfg.get("dooray_member_id"),
        github=cfg.get("github"),
        figma_name=(cfg.get("profile") or {}).get("name"))
    items = merge_duplicates(items)
    items = compress_minor(items)
    items = apply_carryover(items, _load_prev_next(nn, date_from))

    grouped, common = split_common(items, businesses)
    week = week_label(date_from)
    draft = {
        "period": f"{date_from}~{date_to}", "week": week, "ai": [],
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "businesses": group_by_business(grouped, businesses),
        "common": common, "stats": stats, "failures": failures,
        "warnings": find_unsourced(items),
    }
    out_dir = f"/opt/openclaw/data/user{nn}/work-report/drafts"
    os.makedirs(out_dir, exist_ok=True)
    out = f"{out_dir}/draft-{week}.json"
    json.dump(draft, open(out, "w"), ensure_ascii=False, indent=2)
    run_log.record(nn, ok=True, stats=stats, failures=failures)
    return out, draft


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("사용법: build_draft.py <userNN> <from:YYYY-MM-DD> <to:YYYY-MM-DD>")
        sys.exit(2)
    nn, f, t = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        path, d = build(nn, f, t)
        total = sum(len(g["items"]) for g in d["businesses"]) + len(d["common"])
        print(json.dumps({"ok": True, "path": path, "week": d["week"], "total": total,
                          "stats": d["stats"], "failures": d["failures"],
                          "warnings": len(d["warnings"])}, ensure_ascii=False))
    except Exception as e:
        run_log.record(nn, ok=False, error=str(e))
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
EOF
chmod +x /opt/openclaw/work-report-deploy/scripts/build_draft.py
```

- [ ] **Step 5: 검증**

```bash
cd /opt/openclaw/work-report-deploy && python3 -m pytest tests/ -v 2>&1 | tail -3
python3 scripts/build_draft.py 02 2026-08-10 2026-08-14
ls /opt/openclaw/data/user02/work-report/drafts/
head -5 /opt/openclaw/data/user02/work-report/runs.json
```
Expected: 전체 테스트 `passed` · `{"ok": true, "week": "2026-W33", ...}` · `draft-2026-W33.json` 존재 · runs.json 에 기록

- [ ] **Step 6: 커밋** — `feat(work-report): 초안 조립 (주차별 저장 + 이월 대조 + 실행 이력)`

## Task 6: UI — 보고서 미리보기 카드 · 툴 카드 · 업무 칩

**Files:**
- Create: `custom-ui/src/components/WorkReportCards.tsx`
- Modify: `custom-ui/src/components/MessageList.tsx` (fence 2개) · `custom-ui/src/utils/messageFilter.ts` (`CARD_FENCE_MARKERS`) · `custom-ui/src/components/QuickActions.tsx` (`DEFAULT_CHIPS`)

**Interfaces:**
- Consumes: Task 5 draft 스키마 (`businesses[].alias`·`failures[]`·item `carry`)
- Produces: ` ```work-draft ` · ` ```tool-pick ` 렌더링. 버튼 → `onSelect(text)` 로 비서에 전송

- [ ] **Step 1: WorkReportCards.tsx** — 보고서 미리보기형 (메일 구조 그대로 · 청록 단색)

```tsx
cat > /root/openclaw-custom-platform/custom-ui/src/components/WorkReportCards.tsx <<'EOF'
import { memo } from 'react';
import { FileText, AlertTriangle, RotateCcw, CheckCircle2 } from 'lucide-react';

interface Src { source: string; url?: string | null }
interface Item {
  text: string; status?: string; sources?: Src[];
  merged_count?: number; carry?: boolean;
}
interface BizGroup { id: string; name: string; alias: string; items: Item[] }
export interface WorkDraft {
  period: string; week?: string; generated_at?: string;
  businesses: BizGroup[]; common: Item[];
  failures?: string[]; warnings?: Item[];
}

const TOOL_KO: Record<string, string> = {
  dooray: '두레이', gmail: 'Gmail', calendar: '캘린더',
  drive: '드라이브', github: 'GitHub', figma: 'Figma',
};

/* [사업명] 태그 포함 항목 1줄. 색은 청록 계열만 — 위계는 굵기·투명도로 */
function Row({ it, alias }: { it: Item; alias?: string }) {
  const unsourced = !it.sources || it.sources.length === 0;
  const manual = unsourced && it.carry !== true && it.sources !== undefined && it.sources.length === 0;
  return (
    <div className={`flex items-baseline gap-2 px-3 py-1 text-xs ${unsourced && !it.carry ? 'bg-amber-500/[0.06]' : ''}`}>
      <span className="flex-1 leading-snug">
        {alias && <span className="text-accent/70 text-[10px] font-bold mr-1">[{alias}]</span>}
        {it.text}
        {it.merged_count ? <span className="ml-1 text-[9px] text-text-secondary">묶음</span> : null}
        {it.carry ? <span className="ml-1 text-[8.5px] text-accent/60">· 지난주 예정 → 계속</span> : null}
        {unsourced && !it.carry && !manual
          ? <span className="ml-1.5 text-[9px] font-bold text-amber-700">⚠ 출처 없음 — 확인 필요</span> : null}
      </span>
      <span className="text-[9px] whitespace-nowrap">
        {(it.sources || []).map((s, i) => (
          s.url
            ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
                 className="text-accent/60 hover:text-accent ml-1 border-b border-dotted border-accent/30">
                {TOOL_KO[s.source] || s.source} ↗</a>
            : <span key={i} className="text-text-secondary/70 ml-1">{TOOL_KO[s.source] || s.source}</span>
        ))}
        {unsourced ? <span className="text-text-secondary/50">—</span> : null}
      </span>
    </div>
  );
}

/* 사업 그룹을 상태별로 평탄화: [{item, alias}] */
function flat(d: WorkDraft, pred: (s?: string) => boolean) {
  const rows: Array<{ it: Item; alias?: string }> = [];
  for (const b of d.businesses) for (const it of b.items) if (pred(it.status)) rows.push({ it, alias: b.alias });
  for (const it of d.common) if (pred(it.status)) rows.push({ it });
  return rows;
}

export const WorkDraftCard = memo(function WorkDraftCard({
  raw, onSelect,
}: { raw: string; onSelect?: (t: string) => void }) {
  let d: WorkDraft | null = null;
  try { d = JSON.parse(raw); } catch { /* streaming partial */ }
  if (!d || !Array.isArray(d.businesses)) {
    return <div className="my-2 p-3 rounded-lg border border-border-color text-xs text-text-secondary italic">
      업무보고 초안 로딩 중...</div>;
  }
  const done = flat(d, s => s === 'done' || s === undefined);
  const next = flat(d, s => s === 'wip' || s === 'next');
  const warnCount = (d.warnings || []).length;
  const fails = d.failures || [];
  const emptyBiz = d.businesses.filter(b => b.items.length === 0);

  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white max-w-2xl overflow-hidden">
      <div className="bg-accent/[0.07] px-4 py-2.5 flex justify-between items-baseline">
        <span className="text-sm font-bold text-accent flex items-center gap-1.5">
          <FileText className="w-4 h-4" /> 업무보고 초안
        </span>
        <span className="text-[10px] text-text-secondary">{d.period}{d.generated_at ? ` · ${d.generated_at.slice(5, 16).replace('T', ' ')} 생성` : ''}</span>
      </div>

      {fails.length > 0 && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-800 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          <b>{fails.map(f => TOOL_KO[f] || f).join(' · ')} 수집 실패</b> — 해당 항목이 빠진 초안입니다. 연동 확인 후 다시 생성하세요.
        </div>
      )}

      <div className="flex border-b border-border-color/60 text-center">
        <div className="flex-1 py-2 border-r border-border-color/60">
          <div className="text-base font-extrabold text-accent">{done.length}</div>
          <div className="text-[9.5px] text-text-secondary">완료</div>
        </div>
        <div className="flex-1 py-2">
          <div className="text-base font-extrabold text-accent">{next.length}</div>
          <div className="text-[9.5px] text-text-secondary">진행 · 차주</div>
        </div>
      </div>

      <div className="py-2">
        <div className="px-4 text-[11px] font-extrabold text-accent">■ 완료</div>
        {done.map((r, i) => <Row key={i} it={r.it} alias={r.alias} />)}

        <div className="px-4 pt-2 text-[11px] font-extrabold text-accent">■ 진행 · 차주 계획</div>
        {next.map((r, i) => <Row key={i} it={r.it} alias={r.alias} />)}

        {Array.isArray((d as WorkDraft & { ai?: Item[] }).ai) && (d as WorkDraft & { ai?: Item[] }).ai!.length > 0 && (
          <>
            <div className="px-4 pt-2 text-[11px] font-extrabold text-accent">■ 업무 - AI 툴 활용</div>
            {(d as WorkDraft & { ai?: Item[] }).ai!.map((it, i) => <Row key={i} it={it} />)}
          </>
        )}
      </div>

      {emptyBiz.length > 0 && (
        <div className="px-4 pb-1 text-[10px] text-text-secondary/70">
          이번 주 활동 없음: {emptyBiz.map(b => b.name).join(' · ')}
        </div>
      )}
      {warnCount > 0 && (
        <div className="px-4 pb-2 flex items-start gap-1.5 text-[10.5px] text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>출처 없는 항목 {warnCount}건 — 실제로 한 일이 맞는지 확인하세요.</span>
        </div>
      )}

      <div className="border-t border-border-color/60 px-4 py-2.5 flex justify-between items-center">
        <button onClick={() => onSelect?.('업무보고 초안 처음 상태로 되돌려줘')}
          className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-secondary flex items-center gap-1">
          <RotateCcw className="w-3 h-3" /> 초기화
        </button>
        <span className="text-[9.5px] text-text-secondary mr-auto ml-3">✏️ 항목 수정은 채팅으로 · 화면에 보이는 그대로 메일이 됩니다</span>
        <button onClick={() => onSelect?.('업무보고 초안 확정. 메일 발송 준비해줘')}
          className="px-4 py-1.5 text-xs bg-accent text-white font-semibold rounded-lg flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" /> 확정
        </button>
      </div>
    </div>
  );
});

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
      <div className="flex gap-1.5 mt-1">
        <button onClick={() => onSelect?.('이 구성을 기본값으로 저장하고 다시 집계해줘')}
          className="flex-1 px-3 py-1.5 text-[10.5px] border border-border-color rounded-lg text-text-secondary">
          기본값으로 저장 + 집계
        </button>
        <button onClick={() => onSelect?.('이 구성으로 업무보고 다시 집계해줘')}
          className="flex-1 px-3 py-1.5 text-xs bg-accent text-white font-semibold rounded-lg">
          이대로 집계 (이번만)
        </button>
      </div>
    </div>
  );
});
EOF
```

- [ ] **Step 2: fence 라우팅** — `MessageList.tsx` 의 `language-draft-card` 분기 바로 아래:

```tsx
if (cls.includes('language-work-draft')) return <WorkDraftCard raw={raw} onSelect={onSendMessage} />;
if (cls.includes('language-tool-pick'))  return <ToolPickCard raw={raw} onSelect={onSendMessage} />;
```
import 추가: `import { WorkDraftCard, ToolPickCard } from './WorkReportCards';`

- [ ] **Step 3: 필터 예외** — `messageFilter.ts` 의 `CARD_FENCE_MARKERS` 배열에:

```ts
  '```work-draft',
  '```tool-pick',
```

- [ ] **Step 4: 업무 칩 2개** — `QuickActions.tsx` 의 `DEFAULT_CHIPS` 맨 앞에 (비서 화면 = 업무 바로가기, 에이전트 선택기 아님):

```tsx
  { label: '이번 주 업무보고', icon: FileText, prompt: '이번 주 업무보고 초안 만들어줘.', send: true, tone: 'accent', hint: '내가 한 일 → 메일 (사내)' },
  { label: '사업 주간보고 (기관 제출용)', icon: Building2, prompt: '사업 주간보고 만들어줘.', send: true, tone: 'soft', hint: 'SR → 한글 파일 (대외 제출)' },
```
lucide import 에 `FileText`·`Building2` 가 없으면 추가.

- [ ] **Step 5: 검증 + 배포**

```bash
cd /root/openclaw-custom-platform/custom-ui
npx tsc --noEmit 2>&1 | grep -E "WorkReportCards|MessageList|messageFilter|QuickActions"; echo "--- 에러 없으면 통과 ---"
npm run build 2>&1 | tail -3
rsync -a --delete dist/ /opt/openclaw/custom-ui/
docker exec openclaw-nginx nginx -s reload
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/
```
Expected: 대상 파일 에러 0 · `✓ built` · `200`

- [ ] **Step 6: 커밋** — `feat(work-report): 보고서 미리보기 카드 + 툴 카드 + 업무 칩`

## Task 7: 비서 위임 규칙 (keyword_map 확장 포함)

**Files:**
- Modify: `/opt/openclaw/scripts/sync-agents.sh` (`keyword_map`)
- Modify: `/opt/openclaw/data/user02/BOOTSTRAP.md` (103~127행 주간보고 양식 → 위임 규칙)

**Interfaces:**
- Consumes: Task 5 draft 경로 · Task 6 fence
- Produces: 비서가 work-report 를 호출하고 draft 파일을 ` ```work-draft ` 로 재발행

- [ ] **Step 1: keyword_map 확장** — `sync-agents.sh` 의 `keyword_map = {` 블록에 추가.
  기존 커스텀 에이전트 포함 (B 채택 — 위임 0건 7명에게 통로):

```python
    'work-report': '업무보고, 내 업무, 이번 주 한 일, 주간 업무, 메일 주간보고',
    'business-report': '사업 주간보고, 사업보고, 기관 보고, SR, HWPX, 한글 보고서',
    'docwriter': '문서 작성, 문서 초안, 공문',
    'doc-writer': '문서 작성, 문서 초안, 공문',
    'designer': '디자인, 시안, 배너, 이미지 제작',
    'planmanager': '일정 관리, 스케줄 정리',
    'maillng': '메일 정리, 메일 분류',
    'mail-mgr': '메일 정리, 메일 분류',
    'meetingnotes': '회의록, 회의 정리',
    'contractreviewer': '계약서 검토, 계약 조항',
    'dataanalyst': '데이터 분석, 통계 분석',
    'publicsectorpro': '입찰, 공고, 나라장터, 제안 전략',
    'bid-reviewer': '제안서 검토, 입찰 서류 검토',
```

- [ ] **Step 2: BOOTSTRAP 위임 규칙 교체** — `### 주간보고 양식` 섹션(103~127행) 전체를 아래로 치환:

```markdown
### 업무보고 (개인 · 사내 메일) — 반드시 위임

"업무보고", "이번 주 한 일", "주간 업무" 요청이 오면 **직접 작성하지 마.**
`sessions_spawn({ agentId: "work-report", task: "<기간> 업무보고 초안 생성" })` 로 위임해.

**서브에이전트가 draft 파일 경로를 반환하면:**
1. `exec({"command": "cat <경로>"})` 로 읽어
2. JSON 을 그대로 ```work-draft 코드블록으로 뱉어 (카드로 렌더링됨)
3. 카드 위 리드 한 줄만: "초안 나왔어요 👇"
4. failures 배열이 비어있지 않으면 리드에 실패 툴을 명시해

**수정 요청이 오면** draft 파일을 갱신하고 다시 ```work-draft 로 뱉어.
"AI 활용에 ○○ 추가" 는 draft 의 `ai` 배열에 `{"text":"...","sources":[]}` 로 넣어 (직접 입력 = 출처 없음이 정상).

**"조회할 곳 바꿔줘" 류 요청이 오면** config.json 의 tools 를 읽어
```tool-pick 코드블록으로 뱉어: {"tools":[{"id","name","desc","on","connected"}]}
기본 상태에서는 이 카드를 띄우지 마 — **묻지 말고 바로 초안까지 가라.**

### 사업 주간보고 (기관 제출용) — 반드시 위임

"사업 주간보고", "사업보고", "기관 보고", "SR", "한글 보고서" 요청이 오면
`sessions_spawn({ agentId: "business-report", task: "<요청 내용>" })` 로 위임해.
반환된 {"kind":"...","data":{...}} 는 kind 를 코드블록 언어로 써서 재발행해
(예: kind "draft-card" → ```draft-card 블록에 data).

### 구분이 안 될 때 — 결과물로 되물어

그냥 "주간보고" 처럼 애매하면 **에이전트 이름 말고 결과물로** 한 번만 물어:
"어느 쪽 말씀이세요? ① 대표님께 보내는 메일 주간보고 (내가 한 일) ② 발주기관에 제출하는 한글 보고서 (사업 현황)"
키워드가 잡히면 묻지 말고 바로 진행해.
```

- [ ] **Step 2-b: RAG 답변에 출처 의무화** — BOOTSTRAP 의 `## 회사 문서 내용 검색 (RAG)` 섹션 끝에 추가:

```markdown
### 답변 규칙 (절대 위반 금지)
- 자료 기반 답변에는 **반드시 출처를 붙여**: 파일명 + 링크
  (`https://docs.google.com/.../{file_id}` — rag 결과의 file_id 로 조립)
- 자료에서 못 찾았으면 **지어내지 말고** "자료에서 못 찾았어요" 라고 말한 뒤,
  직원 목록에서 관련 담당자를 찾아 "○○님께 문의해보시겠어요?" 로 안내해
- 여러 문서가 잡히면 가장 최근 수정본을 우선하되, 출처는 모두 나열해
```

- [ ] **Step 3: sync + 검증** (⚠ 반드시 인자 `02`)

```bash
/opt/openclaw/scripts/sync-agents.sh 02 2>&1 | tail -3
sed -n '/## 위임 규칙/,$p' /opt/openclaw/shared/user02/AGENTS.md | head -12
grep -c "제목을 반드시 포함해" /opt/openclaw/data/user02/BOOTSTRAP.md
```
Expected: 위임 규칙표에 발화 키워드 표시 · 마지막 grep `0` (양식 제거됨)

- [ ] **Step 4: 다른 사용자 무변경 확인**

```bash
for nn in $(seq -w 1 16); do f=/opt/openclaw/shared/user$nn/AGENTS.md; [ -f "$f" ] && md5sum "$f"; done > /tmp/wr2-agents.md5
diff /tmp/wr-baseline/agents.md5 /tmp/wr2-agents.md5 | grep -oP 'user\d{2}' | sort -u
```
Expected: `user02` 만 (Task 1 이후 유일 변경자)

- [ ] **Step 5: 커밋** — `feat(work-report): 비서 위임 규칙 + keyword_map 발화 키워드 확장`

## Task 8: 메일 발송 연결

**Files:**
- Modify: `/opt/openclaw/data/user02/work-report/config.json` (profile·recipients 실값)
- Modify: `/opt/openclaw/data/user02/BOOTSTRAP.md` (Task 7 섹션 뒤에 발송 절차)

- [ ] **Step 1: 수신자·프로필 설정**

```bash
python3 - <<'EOF'
import json
p = "/opt/openclaw/data/user02/work-report/config.json"
c = json.load(open(p))
c["recipients"] = {"to": ["blueyooe@tideflo.com"], "cc": []}
c["profile"] = {"team": "기술구현그룹", "name": "손재민", "title": "매니저"}
json.dump(c, open(p, "w"), ensure_ascii=False, indent=2)
print(json.dumps(c["profile"], ensure_ascii=False), c["recipients"])
EOF
```

- [ ] **Step 2: 발송 절차 추가** — Task 7 의 `### 업무보고` 섹션 끝에:

```markdown
**발송 절차 (절대 위반 금지):**
1. "확정" 을 받으면 draft 를 메일 본문으로 조립해:
   제목 `[주간보고][YYYY-MM-DD~YYYY-MM-DD]{profile.team} {profile.name} {profile.title}` — `(AI)` 등 붙이지 마
   본문: `기간(…) 팀/이름/직책` + `■ 완료` + `■ 진행 · 차주 계획` + `■ 업무 - AI 툴 활용`
   항목 앞 [사업 alias] · 증적 URL 은 `  ↳ 증적: <url>` 하위 줄 · 표 만들지 마 · 인사말 금지
2. 수신자는 work-report/config.json 의 recipients 기본값
3. 제목·수신자·참조를 보여주고 **명시적 승인** 후에만
   `exec({"command": "gcurl POST /api/mail/send-confirm '{...}'"})` 로 발송
4. **한 주에 한 번만.** `gog mail search "in:sent 주간보고 newer_than:7d"` 로 이미 보냈는지
   확인하고, 있으면 반드시 되물어. 정정 재발송은 제목에 `[재발송]` 을 붙여 수동으로만.
```

- [ ] **Step 3: 검증** — `grep -c "발송 절차" /opt/openclaw/data/user02/BOOTSTRAP.md` → `1` ·
  `grep -c "(AI)" /opt/openclaw/data/user02/BOOTSTRAP.md` 로 금지 문구가 규칙에 명시됐는지 확인
- [ ] **Step 4: 커밋** — `feat(work-report): 메일 발송 절차 (주1회 · 재발송 수동)`

## Task 9: cron (휴무 분기 포함)

**Files:**
- Modify: `/opt/openclaw/data/user02/cron/jobs.json`

- [ ] **Step 1: 등록**

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
    "description": "이번 주 업무보고 초안 자동 생성. 발송은 하지 않음. 금요일 휴무면 조기 발송 제안.",
    "enabled": True,
    "schedule": {"kind": "cron", "expr": "0 17 * * 4", "tz": "Asia/Seoul"},
    "sessionTarget": "main",
    "wakeMode": "now",
    "payload": {
        "kind": "systemEvent",
        "text": ("[cron: 업무보고 초안] 이번 주(월~금) 업무보고 초안을 생성하라. 발송하지 마라. "
                 "초안 카드를 보여주고 확인을 기다려라. "
                 "생성 전에 내일(금요일)이 공휴일이거나 사용자의 연차인지 캘린더로 확인하고, "
                 "휴무면 카드 리드에 '내일 휴무 — 오늘 발송할까요?' 를 덧붙여라.")
    },
})
json.dump(d, open(p, "w"), ensure_ascii=False, indent=2)
print([ (j["name"], j["schedule"]) for j in d["jobs"] ])
EOF
```

- [ ] **Step 2: 검증** — 출력의 모든 job `tz` 가 `Asia/Seoul` · 지시문이 3문장 이내(툴·이메일 하드코딩 없음)
- [ ] **Step 3: 커밋** — `feat(work-report): 목 17시 초안 cron (휴무 분기 · Asia/Seoul)`

## Task 10: 사업 주간보고 — 비서 경유 + 표시명

**Files:**
- Modify: `/opt/openclaw/business-report-deploy/SOUL.template.md` (분기 안내)
- Modify: `/opt/openclaw/business-report-deploy/features.json` + user02 `openclaw.json` (표시명)

- [ ] **Step 1: SOUL 분기** — `# 핵심 규칙` 블록 바로 아래 삽입:

```markdown
## 서브에이전트로 호출된 경우 (비서 경유)

`[Subagent Context]` 가 붙어 들어오면 **사용자가 아니라 비서가 부른 것**이다.
- 카드를 뱉어도 사용자 화면에는 안 보인다. **결과 JSON 만 반환**해라:
  `{"kind":"biz-picker"|"sr-table"|"grouping-editor"|"draft-card"|"download-card","data":{...}}`
- 비서가 이 JSON 을 카드로 재발행한다.

`[Subagent Context]` 가 없으면 기존대로 카드를 직접 뱉는다 (에이전트 화면 직접 진입 — 하위호환).
```

- [ ] **Step 2: 표시명 (기관 제출용)**

```bash
python3 - <<'EOF'
import json
# 매니페스트 (향후 배포용)
p = "/opt/openclaw/business-report-deploy/features.json"
m = json.load(open(p))
f = next(x for x in m["features"] if x["id"] == "business-report")
f["name"] = "사업 주간보고 (기관 제출용)"
f["agent_config"]["name"] = "사업 주간보고 (기관 제출용)"
f["agent_config"]["identity"]["name"] = "사업 주간보고 (기관 제출용)"
json.dump(m, open(p, "w"), ensure_ascii=False, indent=2)

# user02 즉시 반영 — 원자적 쓰기 (Task 1 enroll.sh 와 동일 패턴)
import os, shutil, tempfile, datetime
cp = "/opt/openclaw/data/user02/openclaw.json"
cfg = json.loads(open(cp, encoding="utf-8").read())
a = next(x for x in cfg["agents"]["list"] if x["id"] == "business-report")
a["name"] = "사업 주간보고 (기관 제출용)"
a["identity"]["name"] = "사업 주간보고 (기관 제출용)"
shutil.copy2(cp, cp + ".bak." + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
st = os.stat(cp)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cp), prefix=".openclaw.json.tmp.")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, indent=2)
    fh.flush(); os.fsync(fh.fileno())
os.chmod(tmp, st.st_mode); os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, cp)
print("표시명 변경 완료")
EOF
```

- [ ] **Step 3: user02 workspace SOUL 갱신 (user02 만!)**

```bash
cp /opt/openclaw/business-report-deploy/SOUL.template.md \
   /opt/openclaw/data/user02/workspace-business-report/SOUL.md
chown tideclaw:tideclaw /opt/openclaw/data/user02/workspace-business-report/SOUL.md
chmod 666 /opt/openclaw/data/user02/workspace-business-report/SOUL.md
grep -c "Subagent Context" /opt/openclaw/data/user02/workspace-business-report/SOUL.md
```
Expected: `1` 이상. **다른 사용자 workspace 는 건드리지 않는다** (전체 배포 때 일괄).

- [ ] **Step 4: 커밋** — `feat: 사업 주간보고 비서 경유 분기 + 표시명 (기관 제출용) — user02`

## Task 11: 옛 에이전트 정리 + 통합 테스트 + 격리 검증

**Files:**
- Modify: `/opt/openclaw/data/user02/openclaw.json` (`reporter` 제거)

- [ ] **Step 1: 격리 검증 (파괴적 변경 전)**

```bash
for nn in $(seq -w 1 16); do f=/opt/openclaw/data/user$nn/openclaw.json; [ -f "$f" ] && md5sum "$f"; done > /tmp/wr2-openclaw.md5
diff /tmp/wr-baseline/openclaw.md5 /tmp/wr2-openclaw.md5 | grep -oP 'user\d{2}' | sort -u
```
Expected: **`user02` 만.** 다른 사용자가 나오면 즉시 중단하고 원인 규명.

- [ ] **Step 2: reporter 제거** (표시명 "주간보고 작성"이 신규 체계와 충돌)

```bash
cp /opt/openclaw/data/user02/openclaw.json /opt/openclaw/data/user02/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)
python3 - <<'EOF'
import json, os, shutil, tempfile
p = "/opt/openclaw/data/user02/openclaw.json"
cfg = json.loads(open(p, encoding="utf-8").read())
cfg["agents"]["list"] = [a for a in cfg["agents"]["list"] if a["id"] != "reporter"]
sec = next(a for a in cfg["agents"]["list"] if a["id"] == "secretary")
allow = sec.get("subagents", {}).get("allowAgents", [])
if "reporter" in allow: allow.remove("reporter")
st = os.stat(p)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), prefix=".openclaw.json.tmp.")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, indent=2); fh.flush(); os.fsync(fh.fileno())
os.chmod(tmp, st.st_mode); os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, p)
print("에이전트:", [a["id"] for a in cfg["agents"]["list"]])
EOF
```
Expected: `['secretary', 'bid-reviewer', 'business-report', 'work-report']`

- [ ] **Step 3: 컨테이너 반영 확인** — watch-agents 자동 sync 후:

```bash
sleep 5; journalctl -u openclaw-watch-agents --since "1 min ago" --no-pager | tail -3
docker exec openclaw-user02 sh -c 'curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://localhost:18789/healthz'
```
Expected: user02 동기화 로그 · `200`

- [ ] **Step 4~6: 수동 위임 분기 테스트** (user02 웹 화면에서)
- `이번 주 업무보고 초안 만들어줘` → work-draft 카드 (■완료/■진행·차주 · [태그] · 요약 숫자)
- `사업 주간보고 만들어줘` → 비서 화면에 biz-picker (에이전트 화면 이동 없음)
- `주간보고 작성해줘` → 결과물 기준 되묻기

- [ ] **Step 7: 실행 이력·롤백 절차 확인** (실행 말고 검증만)

```bash
python3 -c "
import sys; sys.path.insert(0,'/opt/openclaw/work-report-deploy/scripts')
import run_log, json
print(json.dumps(run_log.recent('02', 3), ensure_ascii=False))
"
# 롤백: /opt/openclaw/work-report-deploy/unenroll.sh 02
#       + openclaw.json.bak.<ts> 복원 + sync-agents.sh 02
```

- [ ] **Step 8: 커밋** — `feat: user02 업무보고 통합 완료 · reporter 제거`

---

# Phase 2 — 두레이 연동 (B안) ⛔ Phase 1 검증(손재민 실사용 1주) 후 착수

## Task 12: 두레이 측 방식 확정 + 연동 설정 골격

**Files:**
- Create: `/opt/openclaw/data/user02/work-report/dooray.json`

- [ ] **Step 1: 두레이 관리 콘솔 확인 (사람 필요 — 결과를 기록)**
  확인 항목: ① 메신저 봇 API 지원 여부 (1:1 대화방 · 트리거 불필요 — 이상적)
  ② 미지원 시 Outgoing Webhook 의 방 단위 설정 + 트리거 단어 규칙
  ③ Incoming Webhook URL 발급 (알림 방향)
  → 결과를 `dooray.json` 의 `mode` 로 기록: `"bot"` 또는 `"webhook"`

- [ ] **Step 2: 설정 파일 골격**

```bash
cat > /opt/openclaw/data/user02/work-report/dooray.json <<'EOF'
{
  "mode": "",
  "incoming_url": "",
  "outgoing_secret": "",
  "trigger_word": "",
  "dooray_member_id": "",
  "note": "mode: bot|webhook. incoming_url 은 「TideClaw 비서」 방의 수신 훅. 값은 Step 1 확인 후 기입."
}
EOF
chmod 600 /opt/openclaw/data/user02/work-report/dooray.json
chown tideclaw:tideclaw /opt/openclaw/data/user02/work-report/dooray.json
```

- [ ] **Step 3: 커밋** — `feat(dooray): 연동 설정 골격 (mode 미정 상태)`

## Task 13: 발신 알림 (Incoming) — 초안 준비 · 실패 통지

**Files:**
- Create: `/opt/openclaw/work-report-deploy/scripts/dooray_notify.py`
- Modify: user02 cron payload (알림 지시 1줄 추가)

**Interfaces:**
- Produces: `dooray_notify.send(nn, text) -> bool` — `dooray.json` 의 `incoming_url` 로 POST.
  URL 미설정이면 조용히 False (Phase 1 동작 불변).

- [ ] **Step 1: 구현**

```bash
cat > /opt/openclaw/work-report-deploy/scripts/dooray_notify.py <<'EOF'
#!/usr/bin/env python3
"""두레이 「TideClaw 비서」 방으로 알림 (Incoming Webhook).
설정이 없으면 아무것도 하지 않는다 — Phase 1 동작을 바꾸지 않는 안전장치."""
import json
import sys
import urllib.request


def send(nn, text):
    try:
        cfg = json.load(open(f"/opt/openclaw/data/user{nn}/work-report/dooray.json"))
    except Exception:
        return False
    url = (cfg.get("incoming_url") or "").strip()
    if not url:
        return False
    body = json.dumps({"botName": "TideClaw 비서", "text": text}).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("사용법: dooray_notify.py <userNN> <text>")
        sys.exit(2)
    ok = send(sys.argv[1], sys.argv[2])
    print(json.dumps({"ok": ok}))
EOF
chmod +x /opt/openclaw/work-report-deploy/scripts/dooray_notify.py
```

- [ ] **Step 2: cron 지시문에 알림 1줄 추가** — Task 9 payload 끝에:
  `"초안 생성 후(성공·실패 무관) python3 /opt/openclaw/work-report-deploy/scripts/dooray_notify.py 02 '<결과 한 줄 + 웹 링크>' 를 실행하라."`
  (컨테이너 내부 경로가 다르면 `/home/node/documents/work-report/scripts/` 마운트 경로 사용 — 배포 시 확인)

- [ ] **Step 3: 검증** — `python3 scripts/dooray_notify.py 02 "테스트"` → URL 미설정 상태에서 `{"ok": false}` (에러 없이)
- [ ] **Step 4: 커밋** — `feat(dooray): 알림 발신 (미설정 시 무동작)`

## Task 14: 수신 지시 (Outgoing → 비서 세션)

**Files:**
- Modify: `/opt/openclaw/data/user02/openclaw.json` — `extensions.webhooks.routes` (원자적 쓰기)

- [ ] **Step 1: route 등록** — Task 12 에서 확정된 mode 기준.
  webhook 모드 예시 (실제 secret 은 발급값으로):

```json
"extensions": {
  "webhooks": {
    "enabled": true,
    "routes": [{
      "enabled": true,
      "path": "dooray-user02",
      "sessionKey": "agent:secretary:main",
      "secret": "<두레이 Outgoing 이 보내는 토큰>",
      "description": "두레이 「TideClaw 비서」 방 → 손재민 비서 세션"
    }]
  }
}
```
  ⚠ `sessionKey` 는 **웹의 비서 세션과 동일하게** — 두레이 발화가 웹 대화창에 남아 이어진다.
  ⚠ 웹 UI 의 main 세션 진입 차단 정책과 충돌하는지 확인 — 충돌 시 전용 세션 키
  (`agent:secretary:dooray`) 로 하고 웹 세션 목록에 노출되는지 검증 후 결정.

- [ ] **Step 2: 두레이 측 Outgoing 설정** — 「TideClaw 비서」 방 생성 → Outgoing Webhook URL
  `https://<서버>/webhooks/dooray-user02` 등록 (트리거 단어는 mode 에 따라)

- [ ] **Step 3: 왕복 검증** — 두레이 방에서 "오늘 일정 알려줘" → 비서 응답이 방에 회신되는지 ·
  웹 대화창에 같은 대화가 남는지
- [ ] **Step 4: 커밋** — `feat(dooray): 수신 라우팅 (user02)`

## Task 15: Phase 2 통합 테스트

- [ ] 두레이에서 지시 → 회신 (짧은 질의 3종: 일정 · SR 요약 · 미답 메일)
- [ ] 목 17시 cron → 두레이 알림 도착 (성공 문구 · 실패 문구 각 1회 유도)
- [ ] 웹 ↔ 두레이 대화 연속성 ("아까 그거" 지시가 통하는지)
- [ ] 격리 재검증: `diff /tmp/wr-baseline/openclaw.md5 <(현재 해시)` → user02 만
- [ ] 커밋 — `feat(dooray): Phase 2 완료 (user02)`

---

## 전체 배포 (Phase 1·2 모두 user02 검증 후)

```bash
# 1. 나머지 사용자 enroll (원자적 쓰기 적용된 enroll.sh)
for nn in 03 05 06 07 12 13 14 16; do /opt/openclaw/work-report-deploy/enroll.sh $nn; done
# 2. 옛 에이전트 제거 — user03 reporter · user07 weekly-report-agent · user15 weekly-report · user04 eekly
#    (각각 백업 후 Task 11 Step 2 패턴)
# 3. business-report SOUL + 표시명 전체 재배포
# 4. BOOTSTRAP 위임 규칙 — 수동 배포 (배포 스크립트 없음 · user16 은 파일 신규 생성 필요)
# 5. 전 사용자 sync: for nn in $(seq -w 1 16); do /opt/openclaw/scripts/sync-agents.sh $nn; done
# 6. 사용자별 profile·recipients·dooray_member_id 설정 + cron 등록
```
