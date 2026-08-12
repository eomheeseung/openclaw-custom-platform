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


def collect_github(owner, repo, date_from, date_to, token=None, author=None):
    """외부 연동 페이지가 저장한 토큰(integrations.json)으로 직접 호출.
    컨테이너에 gh CLI 가 없으므로 curl 사용. author(깃헙 username)가 있으면 본인 커밋만."""
    if not owner or not repo or not token:
        return [], True          # 미설정 = 조회 안 함 (정상)
    if not author:
        # 공용 저장소에서 author 없이 긁으면 팀원 커밋까지 내 보고서에 섞인다
        # (SR 을 제외한 것과 같은 이유). username 미설정은 실패로 드러낸다.
        return [], False
    q = (f"since={date_from}T00:00:00Z&until={date_to}T23:59:59Z"
         f"&per_page=50&author={author}")
    cmd = (f'curl -s -m 30 -H "Authorization: Bearer {token}" '
           f'-H "Accept: application/vnd.github+json" '
           f'"https://api.github.com/repos/{owner}/{repo}/commits?{q}"')
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
        # repos = [(owner, repo, biz_id), ...] — 사업 마스터의 github_repos 는 biz_id 로
        # 분류되고([사업] 태그), 개인 연동 페이지의 레포는 biz_id=None(공통)으로 잡힌다.
        g = github or {}
        got, ok_all = [], True
        for owner, repo, biz in (g.get("repos") or []):
            it, ok = collect_github(owner, repo, date_from, date_to,
                                    token=g.get("token"), author=g.get("username"))
            for x in it:
                x["biz_id"] = biz
            got += it
            ok_all = ok_all and ok
        take("github", got, ok_all)
    if tool_enabled(tools, "figma"):
        keys = []
        for b in businesses:
            keys += b.get("figma_file_keys") or []
        take("figma", *collect_figma(keys, figma_name))
    return items, stats, failures
