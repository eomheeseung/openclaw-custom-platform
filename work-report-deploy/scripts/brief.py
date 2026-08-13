#!/usr/bin/env python3
"""아침 브리핑 — 오늘 일정 · 답장할 메일 · 마감 임박 업무를 두레이로 보낸다.

문장을 모델에게 맡기지 않는 이유: 매일 아침 한글을 새로 쓰게 되어 글자가 깨진다
(실측: 주간업무보고 → 업묵보고). 여기서 조립하면 매일 같은 문장이 나온다.

컨테이너 안에서 돈다 — 두레이 CLI 와 호스트 API(172.18.0.1) 를 둘 다 쓸 수 있는 유일한 자리다.

사용법:
  python3 brief.py            # 화면에 미리보기 (발송 안 함)
  python3 brief.py --send     # 설정된 시각이 지났고 오늘 아직 안 보냈으면 발송
  python3 brief.py --send --force   # 시각·중복 확인 없이 발송 (테스트)
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collect
import notify
import paths

MAIL_API = "http://172.18.0.1:18799/api/mail/search"
MAIL_MAX = 5          # 아침부터 스크롤이 길어지면 안 읽는다
MAIL_DAYS = 3
DUE_DAYS = 1          # 오늘·내일 마감까지
OVERDUE_DAYS = 7      # 지난 마감은 최근 것만 (작년 것까지 26줄 나왔다)
TASK_MAX = 5
TOMORROW_MAX = 3


def _api(url, params):
    cmd = ["curl", "-s", "-m", "30", "-G", url]
    for k, v in params.items():
        cmd += ["--data-urlencode", f"{k}={v}"]
    try:
        return json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=40).stdout)
    except Exception:
        return {}


def today_events(nn, today):
    cmd = ["curl", "-s", "-m", "30", "-X", "POST", "-H", "Content-Type: application/json",
           "-d", json.dumps({"userNN": nn, "timeMin": today, "timeMax": today}, ensure_ascii=False),
           collect.CALENDAR_API]
    try:
        d = json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=40).stdout)
    except Exception:
        return []
    out = []
    for e in d.get("events", []):
        title = (e.get("title") or "").strip()
        if not title or collect.RE_CAL_NOISE.match(title) or collect.RE_CAL_LEAVE.search(title):
            continue
        start = (e.get("start") or "")
        hhmm = start[11:16] if len(start) >= 16 else "종일"
        out.append((hhmm, title))
    return sorted(out)


def unreplied_mail(nn):
    """읽지 않은 받은편지함 메일에서 광고·타인 결재를 걷어낸다.
    전체 미읽음 숫자(실측 42건)는 아무 정보도 아니라서 건별로 추린다."""
    q = ("is:unread in:inbox -category:promotions -category:social -category:updates "
         f"newer_than:{MAIL_DAYS}d")
    d = _api(MAIL_API, {"userNN": nn, "q": q, "max": 20})
    name = None
    try:
        cfg = json.load(open(f"{paths.data_dir(nn)}/work-report/config.json"))
        name = (cfg.get("profile") or {}).get("name")
    except Exception:
        pass
    out = []
    for m in d.get("messages", []):
        subject, sender = m.get("subject") or "", m.get("from") or ""
        if collect.is_ad_mail(subject, sender) or collect.is_others_approval(subject, name):
            continue
        who = sender.split("<")[0].strip().strip('"') or sender
        who = who.split("@")[0]        # 이름 없이 주소만 오는 발신자 정리
        out.append((who, collect.clean_title(subject)))
    return out


def due_tasks(nn, today):
    """마감이 곧이거나 막 지난 진행중 업무. dueDate 는 UTC 라 날짜만 비교한다.

    ⚠ 지난 마감을 전부 넣으면 안 된다 — 실측 26건이 나왔고 대부분 작년 것이었다.
    아침에 26줄을 보면 아무도 안 읽는다. 최근에 넘긴 것만 남긴다."""
    d0 = datetime.strptime(today, "%Y-%m-%d")
    lo = (d0 - timedelta(days=OVERDUE_DAYS)).strftime("%Y-%m-%d")
    hi = (d0 + timedelta(days=DUE_DAYS)).strftime("%Y-%m-%d")
    projects, _ = collect.dooray_projects()
    out = []
    for p in projects:
        ok, d = collect._run(f"dooray tasks {p.get('id')} 50 working")
        if not ok:
            continue
        for t in d.get("tasks", []):
            due = (t.get("dueDate") or "")[:10]
            if not due or due < lo or due > hi:
                continue
            out.append((due, p.get("name"), collect.clean_title(t.get("subject") or "")))
    return sorted(out)


HOLIDAY_CAL = "ko.south_korea#holiday@group.v.calendar.google.com"

# 요일마다 다른 인사 — 매일 같은 문장이면 사흘 만에 안 읽는다
CLOSING = {
    0: "한 주 시작이네요. 가볍게 가봐요 🌱",
    1: "오늘도 좋은 하루 보내세요 ☕",
    2: "벌써 반이 지났어요. 천천히 하나씩 🐢",
    3: "조금만 더 힘내요 💪",
    4: "금요일이에요! 마무리 잘 해봐요 🎉",
    5: "주말에도 고생이 많아요 🍀",
    6: "주말에도 고생이 많아요 🍀",
}


def day_off(nn, today, events):
    """오늘 쉬는 날이면 브리핑을 보내지 않는다.
    공휴일은 구글 공휴일 달력, 휴가는 본인 달력의 연차·반차 일정으로 판단한다."""
    for title in events:
        # 반차는 반나절 근무라 브리핑이 필요하다 — 종일 휴가만 건너뛴다
        if collect.RE_CAL_LEAVE.search(title) and "반차" not in title:
            return f"휴가({title})"
    cmd = ["curl", "-s", "-m", "20", "-X", "POST", "-H", "Content-Type: application/json",
           "-d", json.dumps({"userNN": nn, "timeMin": today, "timeMax": today,
                             "calendarId": HOLIDAY_CAL}, ensure_ascii=False),
           collect.CALENDAR_API]
    try:
        d = json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout)
    except Exception:
        return ""                      # 공휴일 조회 실패로 브리핑을 막지는 않는다
    for e in d.get("events", []):
        if (e.get("start") or "")[:10] == today:
            return f"공휴일({e.get('title')})"
    return ""


def raw_titles(nn, today):
    """필터 전 원본 제목 — 휴가 판단에 쓴다 (표시용 목록은 휴가를 걸러낸다)."""
    cmd = ["curl", "-s", "-m", "30", "-X", "POST", "-H", "Content-Type: application/json",
           "-d", json.dumps({"userNN": nn, "timeMin": today, "timeMax": today}, ensure_ascii=False),
           collect.CALENDAR_API]
    try:
        d = json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=40).stdout)
    except Exception:
        return []
    return [(e.get("title") or "").strip() for e in d.get("events", [])]


SR_API_LIMIT = 200


def sr_summary(nn, today):
    """사업별 SR 현황 — 오늘 들어온 것과 아직 안 닫힌 것.

    ⚠ 주간보고에는 SR 을 쓰지 않는다(목록에 처리 담당자가 없어 타인 처리 건이 섞인다).
    브리핑은 '무엇이 들어왔나' 를 알리는 것이라 담당자 구분이 필요 없다."""
    base_dir = f"{paths.data_dir(nn)}/business-report"
    try:
        ids = json.load(open(f"{base_dir}/projects.json")).get("projects") or []
    except Exception:
        return []
    out = []
    for pid in ids:
        env = {}
        try:
            for line in open(f"{base_dir}/{pid}/auth.env"):
                if "=" in line and not line.startswith("#"):
                    k, v = line.strip().split("=", 1)
                    env[k] = v
            name = json.load(open(f"{base_dir}/{pid}/meta.json")).get("name") or pid
        except Exception:
            continue
        base, tenant, tok = env.get("SR_BASE_URL"), env.get("SR_TENANT"), env.get("SR_API_TOKEN")
        if not (base and tenant and tok):
            continue
        frm = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=90)).strftime("%Y-%m-%d")
        url = (f"{base}/api/{tenant}/sr?date_field=created_at"
               f"&from={frm}&to={today}&limit={SR_API_LIMIT}")
        cmd = ["curl", "-s", "-m", "25", "-H", f"Authorization: Bearer {tok}", url]
        try:
            d = json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=35).stdout)
        except Exception:
            continue
        items = d if isinstance(d, list) else (d.get("data") or d.get("items") or [])
        new_today = [i for i in items if (i.get("created_at") or "")[:10] == today]
        open_cnt = sum(1 for i in items if i.get("status_code") != "closed")
        if new_today or open_cnt:
            out.append((name, new_today, open_cnt))
    return out


def compose(nn, now):
    today = now.strftime("%Y-%m-%d")
    hello = CLOSING.get(now.weekday(), CLOSING[1])
    lines = [f"☀ {now.strftime('%m월 %d일')} 브리핑 · {hello}", ""]

    ev = today_events(nn, today)
    lines.append("■ 오늘 일정")
    lines += [f"· {h} {t}" for h, t in ev] or ["· 일정 없음"]

    mails = unreplied_mail(nn)
    lines += ["", "■ 답장 안 한 메일"]
    if mails:
        lines += [f"· {who} — {subj}" for who, subj in mails[:MAIL_MAX]]
        if len(mails) > MAIL_MAX:
            lines.append(f"· 외 {len(mails) - MAIL_MAX}건")
    else:
        lines.append("· 없음")

    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    ev2 = today_events(nn, tomorrow)
    lines += ["", "■ 내일 일정"]
    if ev2:
        lines += [f"· {h} {t}" for h, t in ev2[:TOMORROW_MAX]]
        if len(ev2) > TOMORROW_MAX:
            lines.append(f"· 외 {len(ev2) - TOMORROW_MAX}건")
    else:
        lines.append("· 일정 없음")


    srs = sr_summary(nn, today)
    lines += ["", "■ SR"]
    if srs:
        for name, new_today, open_cnt in srs:
            for i in new_today[:3]:
                lines.append(f"· 신규 {i.get('sr_no')} {i.get('title','')[:40]}")
            lines.append(f"· {name} 미처리 {open_cnt}건" if open_cnt else f"· {name} 미처리 없음")
    else:
        lines.append("· 없음")

    tasks = due_tasks(nn, today)
    lines += ["", "■ 두레이 업무 마감"]
    if tasks:
        lines += [f"· {due[5:]} {name} — {subj}" for due, name, subj in tasks[:TASK_MAX]]
        if len(tasks) > TASK_MAX:
            lines.append(f"· 외 {len(tasks) - TASK_MAX}건")
    else:
        lines.append("· 없음")

    return "\n".join(lines)


def _state_path(nn):
    return f"{paths.data_dir(nn)}/work-report/brief-state.json"


def should_send(nn, now):
    """설정 시각이 지났고 오늘 아직 안 보냈을 때만. 타이머가 30분마다 깨우므로
    여기서 걸러야 하루에 여러 번 가지 않는다."""
    try:
        cfg = json.load(open(f"{paths.data_dir(nn)}/work-report/config.json"))
    except Exception:
        return False, "설정 없음"
    b = cfg.get("brief") or {}
    if not b.get("enabled"):
        return False, "꺼짐"
    if now.strftime("%H:%M") < (b.get("time") or "10:00"):
        return False, "시각 전"
    try:
        if json.load(open(_state_path(nn))).get("sentOn") == now.strftime("%Y-%m-%d"):
            return False, "오늘 이미 보냄"
    except Exception:
        pass
    return True, ""


def mark_sent(nn, now):
    p = _state_path(nn)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.tmp"
    json.dump({"sentOn": now.strftime("%Y-%m-%d")}, open(tmp, "w"))
    os.replace(tmp, p)


if __name__ == "__main__":
    nn = paths.self_nn()
    if not nn:
        print(json.dumps({"ok": False, "error": "사용자 번호를 알 수 없습니다"}, ensure_ascii=False))
        sys.exit(2)
    now = datetime.now()
    send, force = "--send" in sys.argv, "--force" in sys.argv

    if send and not force:
        ok, why = should_send(nn, now)
        if not ok:
            print(json.dumps({"ok": True, "skipped": why}, ensure_ascii=False))
            sys.exit(0)
        off = day_off(nn, now.strftime("%Y-%m-%d"), raw_titles(nn, now.strftime("%Y-%m-%d")))
        if off:
            mark_sent(nn, now)     # 오늘은 안 보낸다 — 30분 뒤에 다시 묻지 않게 표시만 남긴다
            print(json.dumps({"ok": True, "skipped": off}, ensure_ascii=False))
            sys.exit(0)

    text = compose(nn, now)
    if not send:
        print(text)
        sys.exit(0)
    sent, how = notify.notify(nn, text)
    if sent:
        mark_sent(nn, now)
    print(json.dumps({"ok": sent, "via": how}, ensure_ascii=False))
