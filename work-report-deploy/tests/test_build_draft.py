import json
import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from week_util import week_label, prev_week_label
from build_draft import split_common, group_by_business, find_unsourced, apply_carryover

def _it(text, biz_id, status="done", sources=None):
    return {"text": text, "biz_id": biz_id, "status": status,
            "sources": sources if sources is not None else [{"source": "dooray", "url": "u"}]}

def test_week_label_iso():
    assert week_label("2026-08-10") == "2026-W33"
    assert prev_week_label("2026-08-10") == "2026-W32"

def test_group_keeps_empty_businesses():
    """활동 없는 사업도 남긴다 — 빠뜨림/없음 구분"""
    bs = [{"id": "b1", "name": "사업1", "alias": "일"}, {"id": "b2", "name": "사업2", "alias": "이"}]
    out = group_by_business([_it("작업A", "b1")], bs)
    assert len(out) == 2 and out[1]["items"] == [] and out[0]["alias"] == "일"

def test_split_common():
    bs = [{"id": "b1", "name": "사업1"}]
    grouped, common = split_common([_it("작업A", "b1"), _it("전사 회의", None)], bs)
    assert [x["text"] for x in grouped] == ["작업A"]
    assert [x["text"] for x in common] == ["전사 회의"]

def test_find_unsourced():
    warns = find_unsourced([_it("정상", "b1"), _it("근거없음", "b1", sources=[])])
    assert [w["text"] for w in warns] == ["근거없음"]

def test_carryover_marks_continuing_item():
    prev_next = [{"text": "통계 화면 개선", "status": "next"}]
    out = apply_carryover([_it("통계 화면 개선", "b1", status="wip")], prev_next)
    assert out[0].get("carry") is True

def test_carryover_appends_untouched_item():
    prev_next = [{"text": "점검 일정 협의", "status": "next", "biz_id": "b1"}]
    out = apply_carryover([_it("다른 작업", "b1")], prev_next)
    carried = [x for x in out if x.get("carry")]
    assert len(carried) == 1 and carried[0]["text"] == "점검 일정 협의"
    assert carried[0]["status"] == "next" and carried[0]["sources"] == []

def test_carryover_done_absorbs():
    prev_next = [{"text": "로그인 오류 조치", "status": "next"}]
    out = apply_carryover([_it("로그인 오류 조치", "b1", status="done")], prev_next)
    assert len(out) == 1 and not out[0].get("carry")

def test_drop_empty_for_many_businesses():
    """담당 사업이 많은 사람(디자이너·팀장)은 빈 사업 나열이 노이즈 → 활동 있는 것만"""
    bs = [{"id": f"b{i}", "name": f"사업{i}", "alias": f"별칭{i}"} for i in range(1, 8)]
    items = [_it("작업A", "b1")]
    kept = group_by_business(items, bs, drop_empty=True)
    assert len(kept) == 1 and kept[0]["id"] == "b1"
    shown = group_by_business(items, bs, drop_empty=False)
    assert len(shown) == 7


def test_draft_carries_profile_and_recipients(tmp_path, monkeypatch):
    """비서가 config 를 안 읽고 소속·직책·수신자를 지어낸 사고가 있었다"""
    import build_draft
    cfg = {"tools": [], "profile": {"team": "전략사업팀", "name": "손재민", "title": "매니저"},
           "recipients": {"to": ["boss@tideflo.com"], "cc": []}}
    d = tmp_path / "work-report"
    d.mkdir()
    (d / "config.json").write_text(json.dumps(cfg, ensure_ascii=False))
    monkeypatch.setattr(build_draft.paths, "data_dir", lambda nn: str(tmp_path))
    monkeypatch.setattr(build_draft.paths, "load_master", lambda: {"businesses": []})
    monkeypatch.setattr(build_draft, "collect", lambda *a, **k: ([], {}, []))
    monkeypatch.setattr(build_draft.run_log, "record", lambda *a, **k: None)
    _, draft = build_draft.build("02", "2026-08-10", "2026-08-14")
    assert draft["profile"]["team"] == "전략사업팀"
    assert draft["profile"]["title"] == "매니저"
    assert draft["recipients"]["to"] == ["boss@tideflo.com"]
