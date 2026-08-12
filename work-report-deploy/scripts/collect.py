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
    if not pid:
        return [], True
    member = member_id or ""  # dooray CLI 는 memberIds 생략 시 본인 담당 자동
    items, ok_all = [], True
    for status, mapped in (("done", "done"), ("working", "wip")):
        ok, d = _run(f"dooray tasks {pid} 50 {status} {member}".strip())
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
    """등록 파일의 버전 이력에서 본인 것만.
    ⚠ figma CLI 는 아직 미배포 — file_keys 가 비어 있는 동안은 휴면 (호출 안 됨)."""
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
