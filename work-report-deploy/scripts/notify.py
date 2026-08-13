#!/usr/bin/env python3
"""두레이 메신저 알림 발송 (단방향).

**봇 인커밍 훅으로 보낸다.** 개인 토큰(`direct-send`)으로도 메시지는 들어가지만
보낸 사람이 본인이 되어 **알림이 뜨지 않는다**(실측). 봇으로 보내야 뱃지·팝업이 뜬다.
  · 봇 URL 은 사용자마다 다르다 — 두레이 대화방 > 서비스 연동 > Incoming 에서 각자 발급.
  · 봇이 보낸 메시지는 발신자 ID 가 봇으로 찍혀(실측 4397489955517839483)
    사용자가 직접 쓴 메시지와 구분된다. 수신 폴링이 자기 알림에 반응하는 루프가 없다.

⚠ 발송 전용이다. 수신은 개인 토큰으로 채널 로그를 폴링한다(별도 모듈).
  두레이가 우리 서버를 호출할 수 없어서다 — 사내망(192.168.50.101)이라 콜백 경로가 없다.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
import week_util
from datetime import datetime

BOT_NAME = "TideClaw"
DIRECT_SEND = "https://api.dooray.com/messenger/v1/channels/direct-send"


def _post(url, body, headers=()):
    cmd = ["curl", "-s", "-m", "20", "-X", "POST", "-H", "Content-Type: application/json"]
    for h in headers:
        cmd += ["-H", h]
    cmd += ["-d", json.dumps(body, ensure_ascii=False), url]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return None


def send_bot(bot_url, text):
    """인커밍 훅은 성공 시 본문이 비어 있다 — 빈 응답을 실패로 보지 않는다."""
    out = _post(bot_url, {"botName": BOT_NAME, "text": text})
    if out is None:
        return False
    out = out.strip()
    if not out:
        return True
    try:
        return (json.loads(out).get("header") or {}).get("isSuccessful") is not False
    except Exception:
        return False


def send_direct(token, member_id, text):
    """폴백 — 메시지는 들어가지만 알림은 뜨지 않는다."""
    out = _post(DIRECT_SEND, {"organizationMemberId": str(member_id), "text": text},
                headers=[f"Authorization: dooray-api {token}"])
    try:
        return bool((json.loads(out).get("header") or {}).get("isSuccessful"))
    except Exception:
        return False


def _dooray(nn):
    try:
        return json.load(open(f"{paths.data_dir(nn)}/integrations.json")).get("dooray") or {}
    except Exception:
        return {}


def notify(nn, text):
    """실패해도 예외를 던지지 않는다 — 알림 실패가 보고 생성을 막으면 안 된다."""
    d = _dooray(nn)
    if d.get("botUrl"):
        return (True, "bot") if send_bot(d["botUrl"], text) else (False, "봇 전송 실패")
    if d.get("token") and d.get("memberId"):
        ok = send_direct(d["token"], d["memberId"], text)
        # 봇 미등록 사용자 — 알림이 안 뜨므로 등록을 유도해야 한다
        return (True, "direct(알림 없음)") if ok else (False, "전송 실패")
    return False, "두레이 미연동"


def draft_summary(nn, week_label_fn=None):
    """초안 파일에서 회신문을 **기계적으로** 만든다.

    ⚠ 모델이 요약을 새로 쓰면 한글이 깨진다(실측: 주간업무보고 → 주간업묳보고).
    항목 문구는 파일에 있는 그대로 인용하고, 숫자와 링크만 붙인다."""
    base = paths.data_dir(nn)
    week = week_util.week_label(datetime.now().strftime("%Y-%m-%d"))
    path = f"{base}/work-report/drafts/draft-{week}.json"
    try:
        d = json.load(open(path))
    except Exception:
        return None
    done, rest = [], []
    for grp in list(d.get("businesses") or []) + [{"items": d.get("common") or []}]:
        for it in grp.get("items") or []:
            (done if it.get("status") == "done" else rest).append(it.get("text", ""))
    link = _web_link(nn, week)
    lines = [f"이번 주 주간보고 초안 ({d.get('period','')})",
             f"완료 {len(done)}건" + (f" · 진행/차주 {len(rest)}건" if rest else "")]
    for t in done[:5]:
        lines.append(f"· {t}")
    if len(done) > 5:
        lines.append(f"· 외 {len(done) - 5}건")
    for t in rest[:3]:
        lines.append(f"· (진행) {t}")
    if d.get("failures"):
        lines.append(f"※ 수집 실패: {', '.join(d['failures'])}")
    lines.append(f"확인: {link}")
    return "\n".join(lines)


def _web_link(nn, week):
    """대화 링크. 담당별로 세션이 갈리므로 **데몬이 기록한 실제 세션 키**에서 만든다.
    고정 문자열(secretary/dooray-<주차>)로 만들면 엉뚱한 대화가 열린다(실측)."""
    token = _gateway_token(nn)
    key = ""
    try:
        st = json.load(open(f"{paths.data_dir(nn)}/work-report/dooray-state.json"))
        key = st.get("sessionKey") or ""
    except Exception:
        pass
    parts = key.split(":")
    if len(parts) >= 3:
        tail = ":".join(parts[2:]).lower()
        return f"http://claw.tideflo.work/chat/{parts[1]}/{tail}?token={token}"
    return f"http://claw.tideflo.work/chat/work-report/dooray-{week}?token={token}".lower()


def _gateway_token(nn):
    try:
        return (json.load(open(f"{paths.data_dir(nn)}/openclaw.json"))
                .get("gateway", {}).get("auth", {}).get("token", ""))
    except Exception:
        return ""


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("사용법: notify.py <userNN> <메시지>  |  notify.py <userNN> --draft")
        sys.exit(2)
    if sys.argv[2] == "--draft":
        msg = draft_summary(sys.argv[1])
        if not msg:
            print(json.dumps({"ok": False, "via": "초안 파일 없음"}, ensure_ascii=False))
            sys.exit(1)
        ok, info = notify(sys.argv[1], msg)
    else:
        ok, info = notify(sys.argv[1], " ".join(sys.argv[2:]))
    print(json.dumps({"ok": ok, "via": info}, ensure_ascii=False))
    sys.exit(0 if ok else 1)
