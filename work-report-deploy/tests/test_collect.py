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

def test_github_requires_author_on_shared_repo():
    """공용 저장소 — username 없으면 수집하지 않고 실패로 드러낸다 (타인 커밋 오염 방지)"""
    from collect import collect_github
    items, ok = collect_github("org", "repo", "2026-08-10", "2026-08-14", token="t", author=None)
    assert items == [] and ok is False

def test_github_unconfigured_is_not_failure():
    from collect import collect_github
    items, ok = collect_github(None, None, "2026-08-10", "2026-08-14")
    assert items == [] and ok is True
