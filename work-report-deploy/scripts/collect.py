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
import re
import subprocess
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime

BLOCKED_TOOLS = {"sr"}
KNOWN_TOOLS = ["dooray", "gmail", "calendar", "drive", "github", "figma"]


def tool_enabled(tools, name):
    if name in BLOCKED_TOOLS:
        return False
    return name in (tools or [])


RE_PREFIX = re.compile(r"^\s*(?:re|fwd?|fw|답장|전달)\s*:\s*", re.I)
RE_TAG = re.compile(r"^\s*\[[^\]]{1,30}\]\s*")


def clean_title(text):
    """제목 앞머리의 Re:/Fwd:/[태그] 를 규칙으로 걷어낸다.

    ⚠ 이 정리를 LLM 에 맡기면 한글을 매번 새로 생성하게 되어 글자가 깨진다
    (실측: 주간업무보고 → 주간업묵보고/업묳보고/업뭏보고 — 매번 다른 글자).
    기계적으로 지울 수 있는 것은 기계가 지운다."""
    t = (text or "").strip()
    body = t
    for _ in range(6):                 # "[공지] Fwd: [결재] …" 처럼 번갈아 겹친다
        nxt = RE_TAG.sub("", RE_PREFIX.sub("", body)).strip()
        if nxt == body:
            break
        body = nxt
    if body:
        return body
    # 제목이 대괄호뿐이면 전부 지워져 빈 문자열이 된다 → 첫 태그 안을 제목으로.
    # 예: "Fwd: [주간업무보고 회의록][2026-08-10]" → "주간업무보고 회의록"
    head = RE_PREFIX.sub("", t).strip()
    m = RE_TAG.match(head)
    return (m.group(0).strip().strip("[]").strip() if m else head) or t


def _iso(at):
    """gmail 의 date 는 RFC 2822 형식이라 ISO 로 맞춘다 (기간비교·정렬·표시 공통)."""
    at = (at or "").strip()
    if not at or at[:4].isdigit():
        return at
    try:
        return parsedate_to_datetime(at).isoformat()
    except Exception:
        return ""


def normalize_item(raw, source, biz_id=None, url=None, status="done", **extra):
    text = (raw.get("subject") or raw.get("title") or raw.get("name")
            or raw.get("summary") or "").strip()
    at = _iso(raw.get("updatedAt") or raw.get("date") or raw.get("modified")
              or raw.get("start") or "")
    it = {"text": clean_title(text), "source": source, "url": url,
          "biz_id": biz_id, "at": at, "status": status}
    if it["text"] != text:
        it["raw_text"] = text          # 원문 — 다듬기 결과를 대조할 근거
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


WIP_STALE_DAYS = 28       # 진행중 task 를 '살아있다'고 볼 최대 방치 기간


def _days_before(date_str, days):
    return (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def in_period(at, date_from, date_to):
    """수집 항목이 보고 기간에 드는지. dooray CLI 는 기간 파라미터가 없어
    (dooray tasks <pid> [size] [status] [memberIds] …) 클라이언트에서 걸러야 한다.
    이 필터가 없으면 1년치 과거 task 가 주간보고에 딸려 들어온다 (실측 128건)."""
    d = (at or "")[:10]
    if not d:
        return False              # 날짜를 모르면 이번 주 것으로 보지 않는다
    return date_from <= d <= date_to


def collect_dooray(date_from, date_to, member_id=None):
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
                it = normalize_item(t, "dooray", None,
                                    f"https://tideflo.dooray.com/task/{pid}/{t.get('id')}",
                                    mapped, project=pname, project_id=pid)
                # 완료(done)는 이번 주에 끝낸 것만.
                # 진행중(wip)은 이번 주 갱신이 없어도 '계속 하는 일'이라 남기되,
                # 최근 갱신분까지만 — 실측상 1년 넘게 열려만 있는 방치 task 가 다수다.
                lo = date_from if mapped == "done" else _days_before(date_from, WIP_STALE_DAYS)
                if not in_period(it["at"], lo, date_to):
                    continue
                items.append(it)
    return items, ok_all


# 보고 가치가 없는 메일 — 다듬기(LLM)에 맡기면 그 단계를 건너뛰는 회차가 있어(실측)
# 명백한 것은 수집 단계에서 규칙으로 거른다.
RE_AD_SUBJECT = re.compile(
    r"\(광고\)|\[광고\]|광고\s*문의|무료\s*체험|웨비나|세미나\s*안내|뉴스레터|구독|"
    r"이벤트\s*안내|할인|특가|프로모션|초대합니다|신청하세요|마감\s*임박", re.I)
RE_AD_SENDER = re.compile(
    r"no-?reply|noreply|newsletter|mailer|marketing|ad@|edu@|support@|info@|"
    r"news@|promo|notification", re.I)
# 타인의 결재/회람 — 내 업무가 아니다 (본인 건은 이름으로 걸러 남긴다)
RE_APPROVAL = re.compile(r"결재|회람|기안|전자결재|docswave", re.I)
# 캘린더 잡음 — 장소·상태만 적어둔 일정
RE_CAL_NOISE = re.compile(r"^(사무실|재택|외근|출장|휴가|연차|반차|점심|회의실\s*\S*)$")


def is_ad_mail(subject, sender):
    return bool(RE_AD_SUBJECT.search(subject or "") or RE_AD_SENDER.search(sender or ""))


def is_others_approval(subject, member_name):
    """결재/회람 메일 중 **내 이름이 없는 것** — 남의 문서다."""
    if not RE_APPROVAL.search(subject or ""):
        return False
    return not (member_name and member_name in (subject or ""))


def collect_gmail(date_from, date_to, member_name=None):
    ok, d = _run(f'gog mail search "after:{date_from} before:{date_to}" --max 50')
    items = []
    for m in d.get("messages", []):
        subject = m.get("subject") or ""
        sender = m.get("from") or ""
        if is_ad_mail(subject, sender) or is_others_approval(subject, member_name):
            continue
        url = f"https://mail.google.com/mail/u/0/#all/{m.get('id')}"
        items.append(normalize_item(m, "gmail", None, url, "done"))
    return items, ok


CALENDAR_API = "http://172.18.0.1:18799/api/calendar/search"


def collect_calendar(nn, date_from, date_to):
    """기간 지정 조회 API 로 본인 일정을 가져온다.

    ⚠ `gog calendar list [일수]` 를 쓰면 안 된다 — **미래만** 본다(음수 무효, search 도 미래 30일).
    주간보고는 지나간 한 주를 정리하는 일이라 과거를 못 읽으면 수집이 무의미하다(실측:
    보고 기간 8/10~8/14 중 월·화·수가 통째로 빠졌다). CLI 는 한글도 깨뜨렸다(기술구현??룹).
    """
    cmd = ["curl", "-s", "-m", "40", "-X", "POST", "-H", "Content-Type: application/json",
           "-d", json.dumps({"userNN": nn, "timeMin": date_from, "timeMax": date_to},
                            ensure_ascii=False), CALENDAR_API]
    try:
        d = json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout)
    except Exception:
        return [], False
    if not d.get("ok"):
        return [], False
    items = []
    for e in d.get("events", []):
        title = (e.get("title") or "").strip()
        if not title or RE_CAL_NOISE.match(title):
            continue          # "사무실" 처럼 장소만 적어둔 일정은 업무가 아니다
        items.append(normalize_item(
            {"title": title, "date": e.get("start")}, "calendar", None, e.get("htmlLink"), "done"))
    return items, True


DRIVE_API = "http://172.18.0.1:18799/api/drive/advanced-search"
# 스크린샷 파일명(예: "2026-08-11 19_04_17.348.png") — 보고 대상이 아니다
RE_SCREENSHOT = re.compile(r"^\d{4}-\d{2}-\d{2}[ _]\d{2}[_:]\d{2}[_:]\d{2}")
DRIVE_MAX = 40


def _drive_call(payload):
    cmd = ["curl", "-s", "-m", "40", "-X", "POST", "-H", "Content-Type: application/json",
           "-d", json.dumps(payload, ensure_ascii=False), DRIVE_API]
    try:
        d = json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout)
    except Exception:
        return None
    return d if d.get("ok") else None


def drive_account(nn):
    """본인 구글 계정. integrations.json 에는 없고 API 응답 `account` 로만 알 수 있다."""
    d = _drive_call({"userNN": nn, "pageSize": 1})
    return (d or {}).get("account")


def collect_drive(nn, date_from, date_to, member_email=None):
    """drive-advanced 확장의 검색 API 로 **본인이 수정한 파일만** 기간으로 조회한다.

    ⚠ `gog drive recent` 를 쓰면 안 된다 — 일수와 무관하게 **항상 30건**만 돌려줘서
    공유 드라이브가 활발하면 본인 파일이 통째로 잘린다(실측: 본인 0건 / 실제 120건).
    """
    member_email = member_email or drive_account(nn)
    if not member_email:
        return [], False              # 계정을 모르면 타인 파일이 섞인다 — 실패로 드러냄
    d = _drive_call({"userNN": nn, "modifiedAfter": date_from, "modifiedBefore": date_to,
                     "modifiedByEmail": member_email, "pageSize": 200})
    if not d:
        return [], False
    # 공유 드라이브 이름이 곧 사업명이다 (예: "금연서비스 통합정보시스템 위탁운영").
    # 파일명만으로는 어느 사업인지 알 수 없으므로 **경로로 판단한다** — classify 가
    # project(= 드라이브명)를 사업명과 유사도 비교해 매핑한다.
    ok_s, ds = _run("gog drive shared")
    drive_names = {x.get("id"): x.get("name") for x in ds.get("drives", [])} if ok_s else {}
    items = []
    for f in d.get("files", []):
        name = (f.get("name") or "").strip()
        if not name or RE_SCREENSHOT.match(name):
            continue
        # driveId 가 없으면 개인 드라이브 — 사업을 특정할 수 없어 공통으로 간다
        container = drive_names.get(f.get("driveId"))
        items.append(normalize_item(
            {"title": name, "date": f.get("modifiedTime")}, "drive", None,
            f.get("webViewLink"), "done", project=container))
    # 산출물이 많은 주에는 수십 건이 나온다(실측 122건). 최신순으로 잘라 다듬기 부담을 줄이되,
    # **공유 드라이브 파일은 자르지 않는다** — 사업이 특정되는 실제 산출물이라
    # 상한에 밀려 사라지면 보고에서 누락된다. 개인 드라이브만 상한을 적용한다.
    items.sort(key=lambda x: x.get("at") or "", reverse=True)
    shared = [x for x in items if x.get("project")]
    personal = [x for x in items if not x.get("project")]
    return shared + personal[:DRIVE_MAX], True


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
            github=None, figma_name=None, nn=None, member_email=None):
    items, stats, failures = [], {}, []

    def take(name, got, ok):
        items.extend(got)
        stats[name] = len(got)
        if not ok:
            failures.append(name)

    if tool_enabled(tools, "dooray"):
        take("dooray", *collect_dooray(date_from, date_to, member_id))
    if tool_enabled(tools, "gmail"):
        take("gmail", *collect_gmail(date_from, date_to, figma_name))
    if tool_enabled(tools, "calendar"):
        take("calendar", *collect_calendar(nn, date_from, date_to))
    if tool_enabled(tools, "drive"):
        take("drive", *collect_drive(nn, date_from, date_to, member_email))
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
