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


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("사용법: notify.py <userNN> <메시지>")
        sys.exit(2)
    ok, info = notify(sys.argv[1], " ".join(sys.argv[2:]))
    print(json.dumps({"ok": ok, "via": info}, ensure_ascii=False))
    sys.exit(0 if ok else 1)
