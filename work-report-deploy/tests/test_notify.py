import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import notify


class _Proc:
    def __init__(self, stdout):
        self.stdout = stdout


def _capture(monkeypatch, stdout=""):
    seen = {}

    def fake_run(cmd, **kw):
        seen["url"] = cmd[-1]
        seen["body"] = json.loads(cmd[cmd.index("-d") + 1])
        seen["headers"] = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-H"]
        return _Proc(stdout)

    monkeypatch.setattr(notify.subprocess, "run", fake_run)
    return seen


def test_bot_hook_empty_response_is_success(monkeypatch):
    """인커밍 훅은 성공 시 본문이 비어 있다 — 빈 응답을 실패로 보면 안 된다"""
    seen = _capture(monkeypatch, stdout="")
    assert notify.send_bot("https://hook/x", "안녕") is True
    assert seen["body"] == {"botName": "TideClaw", "text": "안녕"}


def test_bot_hook_reports_failure(monkeypatch):
    _capture(monkeypatch, stdout='{"header":{"isSuccessful":false}}')
    assert notify.send_bot("https://hook/x", "안녕") is False


def test_direct_send_uses_member_id(monkeypatch):
    """폴백 경로 — '나와의 대화'는 채널 목록에 없으므로 memberId 로 보낸다"""
    seen = _capture(monkeypatch, stdout='{"header":{"isSuccessful":true}}')
    assert notify.send_direct("tok", "42", "안녕") is True
    assert seen["url"].endswith("/channels/direct-send")
    assert seen["body"] == {"organizationMemberId": "42", "text": "안녕"}
    assert any("dooray-api tok" in h for h in seen["headers"])


def test_notify_prefers_bot(monkeypatch, tmp_path):
    """봇 URL 이 있으면 봇으로 — 개인 토큰으로 보내면 알림이 뜨지 않는다"""
    (tmp_path / "integrations.json").write_text(json.dumps(
        {"dooray": {"botUrl": "https://hook/x", "token": "t", "memberId": "42"}}))
    monkeypatch.setattr(notify.paths, "data_dir", lambda nn: str(tmp_path))
    seen = _capture(monkeypatch, stdout="")
    ok, via = notify.notify("02", "테스트")
    assert (ok, via) == (True, "bot")
    assert seen["url"] == "https://hook/x"


def test_notify_falls_back_and_flags_no_alert(monkeypatch, tmp_path):
    """봇 미등록 사용자는 발송은 되지만 알림이 없다는 걸 호출자가 알아야 한다"""
    (tmp_path / "integrations.json").write_text(json.dumps(
        {"dooray": {"token": "t", "memberId": "42"}}))
    monkeypatch.setattr(notify.paths, "data_dir", lambda nn: str(tmp_path))
    _capture(monkeypatch, stdout='{"header":{"isSuccessful":true}}')
    ok, via = notify.notify("02", "테스트")
    assert ok is True and "알림 없음" in via


def test_notify_without_integration(monkeypatch, tmp_path):
    """미연동이면 조용히 실패 — 알림 실패가 보고 생성을 막으면 안 된다"""
    monkeypatch.setattr(notify.paths, "data_dir", lambda nn: str(tmp_path))
    ok, msg = notify.notify("02", "테스트")
    assert ok is False and "미연동" in msg
