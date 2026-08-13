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
import os
import re
import subprocess
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
from week_util import next_week_range
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime


def _out(proc):
    """subprocess 출력을 UTF-8 로 직접 디코드한다.

    ⚠ `text=True` 를 쓰면 안 된다 — 한글이 깨진다(실측: 한국건강증진'개'발원 의 개 한 글자가
    U+FFFD 3개로 바뀌었다. 원본 API 응답은 멀쩡했다). 모델이 깨뜨린 줄 알았던 글자 중
    일부가 여기서 생긴 것이다."""
    return (proc.stdout or b"").decode("utf-8", "replace")

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
        out = _out(subprocess.run(cmd, shell=True, capture_output=True, timeout=60))
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
# "8월 2주차 보고" — 주간보고를 쓰는 업무 자체다. 주간보고에 적을 내용이 아니다.
# 실측: 김다영 8건 전부, 김예림 5건 중 4건이 이것이었다(모두 '전략사업팀-보고관리').
RE_REPORT_TASK = re.compile(r"^\s*\d{1,2}월\s*\d\s*주차\s*보고\s*$")


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


MEMBER_NAME = {"value": ""}          # collect() 가 채운다


def member_name_hit(x):
    n = MEMBER_NAME["value"]
    return bool(n) and n in str(x)


def collect_dooray(date_from, date_to, member_id=None, owned=None):
    """본인 담당 task + **담당자가 없는 내 사업 task**.

    ⚠ 담당자 필터만 쓰면 안 된다 — 사내에서 담당자를 지정하지 않고 쓰는 프로젝트가 많다.
    실측(user13): 2026년 사업 프로젝트 20건 중 담당자가 지정된 건 2건뿐이었고,
    본인 담당으로 조회하니 0건이었다. 실제로는 그 주에 11건이 갱신돼 있었고
    메일 내용과 그대로 겹쳤다(보건소 자료 추출·인수인계·개인정보 파기 요청).

    그래서 담당자가 **없는** task 는 내가 그 사업의 주담당(owners)일 때만 가져온다.
    지원(supporters)일 뿐이면 남의 일이 섞이므로 가져오지 않는다.
    """
    from classify import business_for_container
    projects, ok_all = dooray_projects()
    if not ok_all:
        return [], False
    member = member_id or ""      # 생략 시 CLI 가 본인 담당 자동 적용
    owned = owned or []           # 내가 주담당인 사업 목록
    items, seen = [], set()
    for p in projects:
        pid, pname = p.get("id"), p.get("name")
        biz = business_for_container(pname, owned) if owned else None
        for status, mapped in (("done", "done"), ("working", "wip")):
            # 내 사업이면 담당자 무관하게 받아 오고(all), 아래에서 담당자 있는 것만 걸러낸다
            args = f"{pid} 50 {status}" + (' "" "" all' if biz else f" {member}")
            ok, d = _run(f"dooray tasks {args}".strip())
            ok_all = ok_all and ok
            for t in d.get("tasks", []):
                # all 은 status 인자를 무시하고 전부 준다 — 같은 task 가 두 번 들어온다
                if t.get("id") in seen:
                    continue
                seen.add(t.get("id"))
                if biz:
                    # 담당자가 지정돼 있으면 내 것만
                    to = [str(x) for x in ((t.get("users") or {}).get("to") or [])]
                    if to and not any(member_name_hit(x) for x in to):
                        continue
                    # 담당자가 없는 task 는 '누가 했는지' 근거가 갱신 시각뿐이다.
                    # 방치된 진행중 task 까지 넣으면 지난 몇 달치가 딸려온다(실측 39건).
                    if not in_period(t.get("updatedAt"), date_from, date_to):
                        continue
                    mapped = {"done": "done", "closed": "done"}.get(
                        t.get("workflowClass"), "wip")
                it = normalize_item(t, "dooray", None,
                                    f"https://tideflo.dooray.com/task/{pid}/{t.get('id')}",
                                    mapped, project=pname, project_id=pid)
                # 완료(done)는 이번 주에 끝낸 것만.
                # 진행중(wip)은 이번 주 갱신이 없어도 '계속 하는 일'이라 남기되,
                # 최근 갱신분까지만 — 실측상 1년 넘게 열려만 있는 방치 task 가 다수다.
                if RE_REPORT_TASK.match(it["text"]):
                    continue
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
# 휴가·연차는 제목이 길어도(예: "[손재민] 연차신청서 - 오후 반차 휴가") 업무가 아니다
RE_CAL_LEAVE = re.compile(r"연차|반차|병가|경조휴가|휴가\s*(신청|원)")


def is_ad_mail(subject, sender):
    return bool(RE_AD_SUBJECT.search(subject or "") or RE_AD_SENDER.search(sender or ""))


def is_others_approval(subject, member_name):
    """결재/회람 메일 중 **내 이름이 없는 것** — 남의 문서다."""
    if not RE_APPROVAL.search(subject or ""):
        return False
    return not (member_name and member_name in (subject or ""))


MAIL_API = "http://172.18.0.1:18799/api/mail/search"
MAIL_MAX = 100
# 사람이 쓴 메일이 아니다 — 시스템 알림·결재 시스템·모니터링
RE_MAIL_BOT = re.compile(r"dooray!?\s*notification|whatap|docswave|no-?reply@|noreply@", re.I)
# 일정 응답 알림·타인의 주간보고 — 내 업무가 아니다
RE_MAIL_NOISE = re.compile(
    r"^(업데이트된\s*)?(초대장|초대)\s*:|^(수락함|거절함|미정|취소됨)\s*:|^\[?주간보고\]?[\[\s]")
# 외부 업체 영업 메일. 사내(@tideflo.com) 발신은 대상에서 뺀다 — 오탐 방지
RE_MAIL_SALES = re.compile(r"안녕하세요.{0,20}입니다|안내의\s*건|안내\s*드립니다|소개\s*드립니다")


def collect_gmail(date_from, date_to, member_name=None):
    """호스트 API 로 조회한다.

    ⚠ `gog mail search` 를 쓰면 안 된다 — 같은 조건에서 **9건**만 돌려준다.
    실제로는 50건이 넘는다(실측 user13: API 50+ vs CLI 9). 조회 범위가 왜 좁은지는
    CLI 내부 문제라 알 수 없고, 빠진 메일 중에 실제 업무 메일이 있었다
    (오류 수정 요청·기능 업데이트 협의 등).
    `before` 는 그날을 포함하지 않으므로 하루 더한다."""
    end = (datetime.strptime(date_to, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    cmd = ["curl", "-s", "-m", "40", "-G", MAIL_API,
           "--data-urlencode", f"userNN={_self_nn()}",
           "--data-urlencode", f"q=after:{date_from} before:{end}",
           "--data-urlencode", f"max={MAIL_MAX}"]
    try:
        d = json.loads(_out(subprocess.run(cmd, capture_output=True, timeout=60)))
    except Exception:
        return [], False
    ok = bool(d.get("ok"))
    items = []
    for m in d.get("messages", []):
        subject = (m.get("subject") or "").strip()
        sender = m.get("from") or ""
        if not subject:
            continue                       # 제목 없는 초안
        if RE_MAIL_BOT.search(sender) or is_ad_mail(subject, sender) \
                or is_others_approval(subject, member_name):
            continue
        head = clean_title(subject)
        if RE_MAIL_NOISE.match(subject) or (RE_MAIL_NOISE.match(head) and member_name not in subject):
            continue
        if "tideflo.com" not in sender and RE_MAIL_SALES.search(subject):
            continue
        url = f"https://mail.google.com/mail/u/0/#all/{m.get('id')}"
        items.append(normalize_item(m, "gmail", None, url, "done"))
    return items, ok


CALENDAR_API = "http://172.18.0.1:18799/api/calendar/search"


def _self_nn():
    return paths.self_nn() or ""


def collect_calendar(nn, date_from, date_to, status="done"):
    """기간 지정 조회 API 로 본인 일정을 가져온다.

    ⚠ `gog calendar list [일수]` 를 쓰면 안 된다 — **미래만** 본다(음수 무효, search 도 미래 30일).
    주간보고는 지나간 한 주를 정리하는 일이라 과거를 못 읽으면 수집이 무의미하다(실측:
    보고 기간 8/10~8/14 중 월·화·수가 통째로 빠졌다). CLI 는 한글도 깨뜨렸다(기술구현??룹).
    """
    cmd = ["curl", "-s", "-m", "40", "-X", "POST", "-H", "Content-Type: application/json",
           "-d", json.dumps({"userNN": nn, "timeMin": date_from, "timeMax": date_to},
                            ensure_ascii=False), CALENDAR_API]
    try:
        d = json.loads(_out(subprocess.run(cmd, capture_output=True, timeout=60)))
    except Exception:
        return [], False
    if not d.get("ok"):
        return [], False
    items = []
    for e in d.get("events", []):
        title = (e.get("title") or "").strip()
        if not title or RE_CAL_NOISE.match(title) or RE_CAL_LEAVE.search(title):
            continue          # "사무실" 처럼 장소만 적어둔 일정·휴가는 업무가 아니다
        items.append(normalize_item(
            {"title": title, "date": e.get("start")}, "calendar", None, e.get("htmlLink"), status))
    return items, True


# 문서 파일명 정리 — 확장자·버전·날짜·구분자를 규칙으로 걷어낸다.
# 이걸 모델에게 시키면 한 줄에 3초씩 걸린다(실측: 36건 다듬기에 105초).
RE_EXT = re.compile(r"\.(xlsx?|docx?|pptx?|pdf|hwpx?|md|txt|csv|png|jpe?g|gif|zip)$", re.I)
RE_VER = re.compile(r"[_\s-]*[vV]?\d+(\.\d+)+\s*$")           # _v1.3, v2.1, 5.5
RE_DATE = re.compile(r"[_\s-]*\(?\d{6,8}\)?\s*$")              # _20260811, 260812
RE_SEQ = re.compile(r"\s*\(\d{1,3}\)\s*$")                     # (25) — 다운로드 사본 번호


# 그 자체로 뜻이 없는 토막 — 날짜(20260811·260812), 버전(v1.2·2.1)
RE_JUNK_TOKEN = re.compile(r"^(\d{6,8}|[vV]?\d+(\.\d+)+)$")


def clean_filename(name):
    """파일명을 사람이 읽는 제목으로. 뜻이 있는 부분은 건드리지 않는다."""
    t = RE_EXT.sub("", (name or "").strip())
    t = RE_SEQ.sub("", t)                    # 끝의 (25) — 다운로드 사본 번호
    t = re.sub(r"[_]+", " ", t)              # 언더바는 원래 띄어쓰기 자리다
    # 날짜·버전 토막은 위치와 무관하게 뺀다. 단어로 붙어 있는 숫자(15종·A-B)는 남는다.
    parts = [w for w in t.split() if not RE_JUNK_TOKEN.match(w)]
    t = " ".join(parts)
    t = re.sub(r"\s*-\s*$", "", t).strip(" -")
    return t or (name or "").strip()


DRIVE_API = "http://172.18.0.1:18799/api/drive/advanced-search"
# 스크린샷 파일명(예: "2026-08-11 19_04_17.348.png") — 보고 대상이 아니다
RE_SCREENSHOT = re.compile(r"^\d{4}-\d{2}-\d{2}[ _]\d{2}[_:]\d{2}[_:]\d{2}")
DRIVE_MAX = 40


def _drive_call(payload):
    cmd = ["curl", "-s", "-m", "40", "-X", "POST", "-H", "Content-Type: application/json",
           "-d", json.dumps(payload, ensure_ascii=False), DRIVE_API]
    try:
        d = json.loads(_out(subprocess.run(cmd, capture_output=True, timeout=60)))
    except Exception:
        return None
    return d if d.get("ok") else None


def drive_account(nn):
    """본인 구글 계정. integrations.json 에는 없고 API 응답 `account` 로만 알 수 있다.

    한 번 알아내면 바뀌지 않으므로 config 에 캐시한다 — 매 수집마다 조회하면
    그 호출이 실패하는 것만으로 드라이브 전체가 빠진다(실측: 같은 조건에서 간헐 실패).
    """
    cfg_path = f"{paths.data_dir(nn)}/work-report/config.json"
    try:
        cfg = json.load(open(cfg_path))
    except Exception:
        cfg = None
    if cfg and cfg.get("drive_account"):
        return cfg["drive_account"]
    for _ in range(2):                      # 한 번은 재시도 — 간헐 실패가 관측된다
        d = _drive_call({"userNN": nn, "pageSize": 1})
        account = (d or {}).get("account")
        if account:
            if cfg is not None:
                cfg["drive_account"] = account
                try:
                    tmp = f"{cfg_path}.tmp"
                    json.dump(cfg, open(tmp, "w"), ensure_ascii=False, indent=2)
                    os.replace(tmp, cfg_path)
                except Exception:
                    pass                    # 캐시 실패는 수집을 막지 않는다
            return account
    return None


def collect_drive(nn, date_from, date_to, member_email=None):
    """drive-advanced 확장의 검색 API 로 **본인이 수정한 파일만** 기간으로 조회한다.

    ⚠ `gog drive recent` 를 쓰면 안 된다 — 일수와 무관하게 **항상 30건**만 돌려줘서
    공유 드라이브가 활발하면 본인 파일이 통째로 잘린다(실측: 본인 0건 / 실제 120건).
    """
    member_email = member_email or drive_account(nn)
    if not member_email:
        return [], False              # 계정을 모르면 타인 파일이 섞인다 — 실패로 드러냄
    payload = {"userNN": nn, "modifiedAfter": date_from, "modifiedBefore": date_to,
               "modifiedByEmail": member_email, "pageSize": 200}
    d = _drive_call(payload) or _drive_call(payload)      # 간헐 실패 대비 1회 재시도
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
        # 파일명 정리는 규칙으로 끝낸다 — 모델에 맡기면 한 줄에 3초씩 든다
        items.append(normalize_item(
            {"title": clean_filename(name), "date": f.get("modifiedTime")}, "drive", None,
            f.get("webViewLink"), "done", project=container, raw_text=name))
    # 산출물이 많은 주에는 수십 건이 나온다(실측 122건). 최신순으로 잘라 다듬기 부담을 줄이되,
    # **공유 드라이브 파일은 자르지 않는다** — 사업이 특정되는 실제 산출물이라
    # 상한에 밀려 사라지면 보고에서 누락된다. 개인 드라이브만 상한을 적용한다.
    items.sort(key=lambda x: x.get("at") or "", reverse=True)
    shared = [x for x in items if x.get("project")]
    personal = [x for x in items if not x.get("project")]
    return shared + personal[:DRIVE_MAX], True


GH_API = "https://api.github.com"


def _gh(url, token):
    cmd = ["curl", "-s", "-m", "30", "-H", f"Authorization: Bearer {token}",
           "-H", "Accept: application/vnd.github+json", url]
    try:
        return json.loads(_out(subprocess.run(cmd, capture_output=True, timeout=45)))
    except Exception:
        return None


def collect_github(owner, date_from, date_to, token=None, author=None):
    """접근 가능한 레포를 돌며 **모든 브랜치**에서 본인 커밋을 찾는다.

    ⚠ `search/commits` 를 쓰면 안 된다 — 사내 레포는 전부 private 이라 검색에 잡히지 않고,
    잡히더라도 기본 브랜치만 본다. 실측(user02): search 로 0건이었으나 실제로는
    feature/v2·feature/redesign-ui 에 7건이 있었다.
    """
    if not token:
        return [], True                 # 미설정 = 조회 안 함 (정상)
    if not author:
        return [], False                # 타인 커밋 오염 방지 — 실패로 드러냄
    repos = _gh(f"{GH_API}/user/repos?sort=pushed&per_page=50"
                "&affiliation=owner,collaborator,organization_member", token)
    if not isinstance(repos, list):
        return [], False
    since, until = f"{date_from}T00:00:00Z", f"{date_to}T23:59:59Z"
    items, seen = [], set()
    for r in repos:
        # 보고 기간 이후로 한 번도 push 되지 않은 레포는 볼 필요가 없다 (호출 수 절약)
        if (r.get("pushed_at") or "") < since:
            continue
        if owner and (r.get("owner") or {}).get("login") != owner:
            continue
        full = r.get("full_name")
        branches = _gh(f"{GH_API}/repos/{full}/branches?per_page=30", token)
        for b in branches if isinstance(branches, list) else []:
            commits = _gh(f"{GH_API}/repos/{full}/commits?sha={b.get('name')}"
                          f"&author={author}&since={since}&until={until}&per_page=50", token)
            for c in commits if isinstance(commits, list) else []:
                sha = c.get("sha")
                if not sha or sha in seen:
                    continue            # 브랜치가 겹치면 같은 커밋이 여러 번 잡힌다
                seen.add(sha)
                # 병합 커밋(부모 2개 이상)은 자동 생성 메시지라 업무 내용이 없다
                if len(c.get("parents") or []) > 1:
                    continue
                msg = (c.get("commit") or {}).get("message", "").split("\n")[0]
                items.append(normalize_item(
                    {"title": msg, "date": (c.get("commit") or {}).get("author", {}).get("date")},
                    "github", None, c.get("html_url"), "done", repo=full))
    return items, True


FIGMA_API = "https://api.figma.com"


# 피그마가 자동으로 붙이는 이름 — 무엇을 했는지 알려주지 않는다
RE_FIG_AUTONAME = re.compile(
    r"^(frame|group|rectangle|ellipse|vector|line|image|component|instance|slide)\b[\s\d:.-]*$", re.I)
FIG_PAGE_MAX = 3         # 파일당 보고할 페이지 수 (변경이 많은 순)
FIG_NAME_MAX = 3         # 한 줄에 나열할 프레임 이름 수


def _fig_get(token, url, timeout=60):
    cmd = ["curl", "-s", "-m", str(timeout - 5), "-H", f"X-Figma-Token: {token}", url]
    try:
        d = json.loads(_out(subprocess.run(cmd, capture_output=True, timeout=timeout)))
    except Exception:
        return None
    return None if d.get("status") else d


def _fig_versions(token, key, date_from):
    """보고 기간 시작 이전 버전이 나올 때까지 거슬러 올라간다.
    한 번에 30개씩만 오므로(실측) 페이지를 넘겨야 기준점을 잡을 수 있다."""
    url = f"{FIGMA_API}/v1/files/{key}/versions?page_size=30"
    out = []
    for _ in range(6):                       # 180개면 몇 달치다 — 그보다 오래 거슬러 갈 일은 없다
        d = _fig_get(token, url, timeout=45)
        if not d:
            break
        vs = d.get("versions") or []
        out += vs
        if not vs or (vs[-1].get("created_at") or "")[:10] < date_from:
            break
        nxt = ((d.get("pagination") or {}).get("next_page") or "")
        if not nxt:
            break
        url = urllib.parse.quote(nxt, safe=":/?&=")   # 응답 URL 에 공백이 섞여 온다
    return out


def _fig_tree(token, key, version_id):
    """그 시점의 페이지 → 최상위 프레임 이름. depth=2 면 1MB 안쪽이다(실측)."""
    d = _fig_get(token, f"{FIGMA_API}/v1/files/{key}?depth=2&version={version_id}", timeout=60)
    if not d:
        return None
    out = {}
    for pg in (d.get("document") or {}).get("children") or []:
        out[pg.get("id")] = {
            "name": pg.get("name") or "",
            "kids": {k.get("id"): (k.get("name") or "") for k in (pg.get("children") or [])},
        }
    return out


def _fig_diff(old, new):
    """페이지별 추가·삭제·이름변경. 프레임 **내부** 수정은 이름이 그대로라 잡히지 않는다 —
    피그마에 버전 간 비교 API 가 없어 여기까지가 한계다."""
    pages = []
    for pid, pg in (new or {}).items():
        before = (old or {}).get(pid, {}).get("kids", {})
        after = pg.get("kids", {})
        named = lambda v: v and not RE_FIG_AUTONAME.match(v)
        # 같은 이름의 프레임이 여러 개인 경우가 흔하다 — 이름 기준으로 한 번만 센다
        added = sorted({v for k, v in after.items() if k not in before and named(v)})
        renamed = sorted({after[k] for k in after
                          if k in before and before[k] != after[k] and named(after[k])})
        if added or renamed:
            pages.append({"page": pg.get("name") or "", "added": added, "renamed": renamed})
    return sorted(pages, key=lambda x: -(len(x["added"]) + len(x["renamed"])))


def collect_figma(nn, date_from, date_to):
    """등록된 파일의 버전 이력에서 **본인 편집만** 골라 파일당 한 줄로 낸다.

    ⚠ 자동 발견이 불가능하다 — 피그마에는 **사용자 기준 파일 목록 API 가 없고**(명세 확인),
    팀·폴더 조회는 관리자 권한이 필요해 일반 멤버 토큰으로는 403 이다. 그래서 개별 등록만 가능하다.
    버전에 label 이 거의 없어(자동 저장) '무엇을 했는지'는 알 수 없고 '편집했다'만 남는다.
    """
    try:
        integ = json.load(open(f"{paths.data_dir(nn)}/integrations.json"))
    except Exception:
        return [], False
    fig = integ.get("figma") or {}
    token, user_id = fig.get("token"), str(fig.get("userId") or "")
    files = fig.get("fileKeys") or []
    if not token or not files:
        return [], True                # 미설정 = 조회 안 함 (정상)
    if not user_id:
        return [], False               # 본인 식별이 없으면 남의 편집이 섞인다 — 실패로 드러냄
    items, ok_all = [], True
    for f in files:
        key = f.get("key") if isinstance(f, dict) else f
        name = (f.get("name") if isinstance(f, dict) else None) or key
        cmd = ["curl", "-s", "-m", "30", "-H", f"X-Figma-Token: {token}",
               f"{FIGMA_API}/v1/files/{key}/versions"]
        try:
            d = json.loads(_out(subprocess.run(cmd, capture_output=True, timeout=45)))
        except Exception:
            ok_all = False
            continue
        if d.get("status"):
            ok_all = False
            continue
        mine = [v for v in d.get("versions", [])
                if str((v.get("user") or {}).get("id")) == user_id
                and in_period(v.get("created_at"), date_from, date_to)]
        if not mine:
            continue
        latest = max(mine, key=lambda v: v.get("created_at") or "")
        label = (latest.get("label") or "").strip()

        # 버전 이름이 거의 비어 있어(자동 저장) '무엇을 했는지'는 이력에 없다.
        # 기간 시작 시점과 지금의 파일 구조를 비교해 프레임 단위로 알아낸다.
        detail = ""
        allv = _fig_versions(token, key, date_from)
        base = next((v for v in allv if (v.get("created_at") or "")[:10] < date_from), None)
        if base:
            old = _fig_tree(token, key, base.get("id"))
            new = _fig_tree(token, key, latest.get("id"))
            if old is None or new is None:
                ok_all = False
            else:
                pages = _fig_diff(old, new)

        url = f"https://www.figma.com/design/{key}"
        if pages:
            # 페이지 하나가 곧 한 덩어리의 작업이다 — 파일당 한 줄로 뭉치면
            # "시안 편집" 과 다를 바 없어진다.
            for pg in pages[:FIG_PAGE_MAX]:
                names = pg["added"] + pg["renamed"]
                head = ", ".join(names[:FIG_NAME_MAX])
                more = f" 외 {len(names) - FIG_NAME_MAX}건" if len(names) > FIG_NAME_MAX else ""
                items.append(normalize_item(
                    {"title": f"{name} · {pg['page']} — {head}{more}",
                     "date": latest.get("created_at")},
                    "figma", None, url, "done", project=name))
        else:
            items.append(normalize_item(
                {"title": f"{name} 시안 편집" + (f" ({label})" if label else ""),
                 "date": latest.get("created_at")},
                "figma", None, url, "done", project=name))
    return items, ok_all


def collect(tools, businesses, date_from, date_to, member_id=None,
            github=None, figma_name=None, nn=None, member_email=None, owner_nn=None):
    items, stats, failures = [], {}, []
    # 주담당(owners)인 사업만 — 지원일 뿐인 사업의 무주공산 task 는 남의 일이다
    owned_businesses = [b for b in (businesses or [])
                        if owner_nn and owner_nn in (b.get("owners") or [])]
    MEMBER_NAME["value"] = figma_name or ""      # 본인 이름 — task 담당자 대조에 쓴다

    def take(name, got, ok):
        items.extend(got)
        stats[name] = len(got)
        if not ok:
            failures.append(name)

    if tool_enabled(tools, "dooray"):
        take("dooray", *collect_dooray(date_from, date_to, member_id, owned=owned_businesses))
    if tool_enabled(tools, "gmail"):
        take("gmail", *collect_gmail(date_from, date_to, figma_name))
    if tool_enabled(tools, "calendar"):
        take("calendar", *collect_calendar(nn, date_from, date_to))
        # 다음 주 일정 = 차주 계획. 이걸 안 넣으면 '진행·차주' 가 거의 비어서
        # 사용자가 매주 손으로 채워야 한다(실측: 캘린더에 잡아둔 다음 주 미팅이 안 들어옴).
        nf, nt = next_week_range(date_from)
        got, ok = collect_calendar(nn, nf, nt, status="next")
        items.extend(got)
        stats["calendar"] = stats.get("calendar", 0) + len(got)
        if not ok and "calendar" not in failures:
            failures.append("calendar")
    if tool_enabled(tools, "drive"):
        take("drive", *collect_drive(nn, date_from, date_to, member_email))
    if tool_enabled(tools, "github"):
        g = github or {}
        take("github", *collect_github(g.get("owner"), date_from, date_to,
                                       token=g.get("token"), author=g.get("username")))
    if tool_enabled(tools, "figma"):
        take("figma", *collect_figma(nn, date_from, date_to))
    return items, stats, failures
