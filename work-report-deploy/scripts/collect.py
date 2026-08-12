#!/usr/bin/env python3
"""툴별 수집 → 정규화 항목 + 건수 + 실패 목록.

설계(B안): 사업 매핑을 위한 사전 등록을 요구하지 않는다.
  - 두레이: `dooray projects` 로 내 프로젝트를 **자동 발견**하고, 항목에 project/project_id 를 실어
    classify.py 가 이름 유사도로 사업에 붙인다.
  - 드라이브: 공유 드라이브 목록을 받아 파일의 parents 와 대조 (best effort).
  - 깃헙: org 단위 검색 — 레포를 하나하나 등록할 필요 없음.

⚠ SR 영구 제외: 목록 컬럼(sr_no·title·requester·…)에 처리 담당자가 없어 타인 처리 건이 섞인다.
⚠ 실패를 드러낸다: 미연동/실패 시 CLI 가 에러 대신 사용법 안내문을 뱉어 '조용한 누락'이 되므로,
  호출 실패는 failures 로 반환해 카드 배지로 띄운다.
"""
import json
import subprocess

BLOCKED_TOOLS = {"sr"}
KNOWN_TOOLS = ["dooray", "gmail", "calendar", "drive", "github", "figma"]


def tool_enabled(tools, name):
    if name in BLOCKED_TOOLS:
        return False
    return name in (tools or [])


def normalize_item(raw, source, biz_id=None, url=None, status="done", **extra):
    text = (raw.get("subject") or raw.get("title") or raw.get("name")
            or raw.get("summary") or "").strip()
    at = (raw.get("updatedAt") or raw.get("date") or raw.get("modified")
          or raw.get("start") or "")
    it = {"text": text, "source": source, "url": url,
          "biz_id": biz_id, "at": at, "status": status}
    it.update(extra)          # project / project_id / repo — classify 가 매핑에 씀
    return it


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


def dooray_projects():
    """내가 속한 프로젝트 자동 발견. 관리자가 프로젝트 ID 를 등록할 필요가 없다."""
    ok, d = _run("dooray projects")
    if not ok:
        return [], False
    return [p for p in d.get("projects", []) if p.get("state") != "archived"], True


def collect_dooray(member_id=None):
    projects, ok_all = dooray_projects()
    if not ok_all:
        return [], False
    member = member_id or ""      # 생략 시 CLI 가 본인 담당 자동 적용
    items = []
    for p in projects:
        pid, pname = p.get("id"), p.get("name")
        for status, mapped in (("done", "done"), ("working", "wip")):
            ok, d = _run(f"dooray tasks {pid} 50 {status} {member}".strip())
            ok_all = ok_all and ok
            for t in d.get("tasks", []):
                url = f"https://tideflo.dooray.com/task/{pid}/{t.get('id')}"
                items.append(normalize_item(t, "dooray", None, url, mapped,
                                            project=pname, project_id=pid))
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
    """공유 드라이브명을 컨테이너로 삼아 매핑 (parents 가 드라이브 루트인 경우).
    그 외 파일은 파일명 키워드 / LLM 보정에 맡긴다."""
    ok_s, ds = _run("gog drive shared")
    drive_names = {d.get("id"): d.get("name") for d in ds.get("drives", [])} if ok_s else {}
    ok, d = _run(f"gog drive recent {days}")
    items = []
    for f in d.get("files", []):
        url = f"https://drive.google.com/file/d/{f.get('id')}/view"
        container = None
        for parent in f.get("parents") or []:
            if parent in drive_names:
                container = drive_names[parent]
                break
        items.append(normalize_item(f, "drive", None, url, "done", project=container))
    return items, ok


def collect_github(owner, date_from, date_to, token=None, author=None):
    """본인 커밋 전역 검색 — 레포도 조직도 등록할 필요 없음.
    실측(user02): 레포가 infconn/·eomheeseung/ 등 여러 조직에 흩어져 있어 org 고정은 부적합.
    author(본인 username) 는 필수: 생략하면 공용 저장소의 팀원 커밋이 섞인다.
    owner 는 선택 — 지정하면 그 조직으로 범위를 좁힌다."""
    if not token:
        return [], True                 # 미설정 = 조회 안 함 (정상)
    if not author:
        return [], False                # 타인 커밋 오염 방지 — 실패로 드러냄
    scope = f"org:{owner}+" if owner else ""
    q = f"{scope}author:{author}+author-date:{date_from}..{date_to}"
    cmd = (f'curl -s -m 30 -H "Authorization: Bearer {token}" '
           f'-H "Accept: application/vnd.github+json" '
           f'"https://api.github.com/search/commits?q={q}&per_page=50"')
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60).stdout
        d = json.loads(out)
        rows = d.get("items")
        if not isinstance(rows, list):
            return [], False
    except Exception:
        return [], False
    items = []
    for c in rows:
        msg = (c.get("commit") or {}).get("message", "").split("\n")[0]
        r = c.get("repository") or {}
        repo = r.get("full_name") or r.get("name") or ""
        items.append(normalize_item(
            {"title": msg, "date": (c.get("commit") or {}).get("author", {}).get("date")},
            "github", None, c.get("html_url"), "done", repo=repo))
    return items, True


def collect_figma(file_keys, member_name):
    """등록 파일의 버전 이력에서 본인 것만.
    ⚠ figma CLI 미배포 — file_keys 가 비어 있는 동안은 휴면 (호출 안 됨)."""
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
        take("dooray", *collect_dooray(member_id))
    if tool_enabled(tools, "gmail"):
        take("gmail", *collect_gmail(date_from, date_to))
    if tool_enabled(tools, "calendar"):
        take("calendar", *collect_calendar())
    if tool_enabled(tools, "drive"):
        take("drive", *collect_drive())
    if tool_enabled(tools, "github"):
        g = github or {}
        take("github", *collect_github(g.get("owner"), date_from, date_to,
                                       token=g.get("token"), author=g.get("username")))
    if tool_enabled(tools, "figma"):
        keys = []
        for b in businesses:
            keys += b.get("figma_file_keys") or []
        take("figma", *collect_figma(keys, figma_name))
    return items, stats, failures
